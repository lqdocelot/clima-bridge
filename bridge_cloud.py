#!/usr/bin/env python3
"""
PONTE CLOUD con controllo dolce + presenza + notifiche Telegram.
- Tiene la temperatura reale (Aqara) verso ~25°C regolando il setpoint (no strappi, inverter modula).
- Cap Δ interno-esterno (anti shock termico). Umidità letta/loggata.
- PRESENZA: se 'away' (casa vuota) -> spegne (efficienza). Se 'home' -> modalità gentile (ventola quiet).
- NOTIFICHE: avvisa su Telegram quando fa qualcosa o in caso di errore.
Cloud puro: gira da ovunque (es. GitHub Actions). Credenziali e config da variabili d'ambiente.

DRY_RUN=true (default) -> non comanda nulla, stampa/avvisa soltanto.
"""
import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import holidays
import requests
from aqara_iot import AqaraOpenAPI, AqaraDeviceManager

TZ_ROME = ZoneInfo("Europe/Rome")  # ora locale italiana, esplicita (il runner GitHub è UTC)

# Festività nazionali IT (mobili incluse, es. Pasquetta). L'oggetto espande gli anni al volo.
_IT_HOLIDAYS = holidays.Italy()


def now_it():
    return datetime.now(TZ_ROME)


def is_home_day(d):
    """True se 'd' è un giorno in cui probabilmente si dorme/si è a casa al mattino:
    weekend (sab/dom) o festivo nazionale italiano."""
    return d.weekday() >= 5 or d in _IT_HOLIDAYS


def wake_hour_for(d):
    """Ora (decimale, es. 9.5 = 09:30) in cui il clima della cameretta può riaccendersi
    al mattino: feriale → WAKE_NORMAL, weekend/festivi → WAKE_HOME (più tardi)."""
    return WAKE_HOME if is_home_day(d) else WAKE_NORMAL


def in_quiet_window(h, qe, qs=22):
    """True se l'ora decimale h è nella fascia di spegnimento cameretta [qs..qe).
    qs = sera (22), qe = risveglio (9.5 feriali, 12 weekend-festivi). Gestisce il wrap a mezzanotte.
    Nella fascia la cameretta è spenta di DEFAULT, ma una mossa manuale la scavalca per HOLD_HOURS
    (gestito dal blocco manuale). Non c'è più una sotto-fascia 'assoluta'."""
    return (qs <= h or h < qe) if qs > qe else (qs <= h < qe)

DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"

# ---- Comfort (tarabili anche da env) ----
BASE_TARGET = float(os.environ.get("TARGET", "25.0"))      # target normale (solo adulto a casa)
TARGET_SOFT = float(os.environ.get("TARGET_SOFT", "25.0"))  # target gentile quando ci sono i bimbi (Jessica a casa)
DEADZONE = 0.3
STEP = 0.5
SETPOINT_MIN, SETPOINT_MAX = 20.0, 29.0
MAX_DELTA = float(os.environ.get("MAX_DELTA", "6.0"))
# Umidità: vicino al target con aria umida si passa in dry; isteresi per non fare ping-pong.
RH_DRY_ON = float(os.environ.get("RH_DRY_ON", "62"))    # % oltre cui passare in dry (se temp vicina al target)
RH_DRY_OFF = float(os.environ.get("RH_DRY_OFF", "55"))  # % sotto cui tornare in cool
# Risveglio: ora (decimale) di riaccensione al mattino dopo la fascia notturna.
WAKE_NORMAL = float(os.environ.get("WAKE_HOUR", "9.5"))       # feriali → 09:30
WAKE_HOME = float(os.environ.get("WAKE_HOUR_HOME", "12.0"))   # weekend/festivi → 12:00 (si dorme)
HOLD_SECONDS = int(float(os.environ.get("HOLD_HOURS", "1")) * 3600)  # blocco manuale: dopo un cambio a mano, l'automatismo si ferma per N ore
AUTOSTATE_FILE = "autostate.json"  # memoria di cosa ha impostato l'automatismo + scadenza blocco manuale (nel repo)
EMERGENCY_FILE = "emergency.json"  # lockout 24h: {"mode":"off"/"safe"/"none","until":<epoch>} (scritto dal bot/emergency.yml)
SAFE_TARGET = float(os.environ.get("SAFE_TARGET", "26"))  # setpoint cool gentile in "modalità sicura"
LAT, LON = 45.0703, 7.6869  # Torino (regolabile)

# ---- FGLair ----
SIGNIN_URL = "https://user-field-eu.aylanetworks.com/users/sign_in.json"
BASE = "https://ads-field-eu.aylanetworks.com/apiv1/"
PROPS_URL = BASE + "dsns/{dsn}/properties.json"
SET_URL = BASE + "properties/{key}/datapoints.json"
APP_ID, APP_SECRET = "FGLair-eu-id", "FGLair-eu-gpFbVBRoiJ8E3QWJ-QRULLL3j3U"
MODE = {0: "off", 2: "auto", 3: "cool", 4: "dry", 5: "fan_only", 6: "heat"}
COOL = 3
DRY = 4
FAN_QUIET = 0

RES_TEMP, RES_HUM = "0.1.85", "0.2.85"
# nomi leggibili dei sensori Aqara (per il bot Telegram)
SENSOR_NAMES = {
    "lumi.158d008afda8d2": "🛋️ Soggiorno",
    "lumi.158d0008974abd": "🧸 Cameretta EVA",
    "lumi.158d008afda91f": "🛏️ Camera",
    "lumi.158d0008ab1164": "🚿 Bagno",
}
# quiet_from = ora (decimale) di spegnimento serale; il risveglio è dinamico per tutti
# (feriali WAKE_NORMAL=09:30, weekend/festivi WAKE_HOME=12:00 — vedi wake_hour_for()).
# Nella fascia la stanza è spenta di default ma una mossa manuale regge HOLD_HOURS.
ROOMS = [
    {"name": "SOGGIORNO", "dsn": "AC000W002919142", "sensor": "lumi.158d008afda8d2", "quiet_from": 23},
    {"name": "CAMERA",    "dsn": "AC000W002919128", "sensor": "lumi.158d0008974abd", "quiet_from": 22},
]

TG_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
PRESENCE_URL = os.environ.get("PRESENCE_URL", "")


def notify(text):
    print("TG>", text)
    if TG_TOKEN and TG_CHAT:
        try:
            requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                          data={"chat_id": TG_CHAT, "text": text}, timeout=10)
        except Exception as e:
            print("  (notifica fallita:", e, ")")


def round_half(x):
    return round(x * 2) / 2


_RETRY_SLEEP = 8  # secondi tra i tentativi di rete (azzerato nei test)


def with_retry(fn, tries=3, what=""):
    """Riprova fn SOLO su errori di rete transitori (timeout/connessione): il cloud Ayla
    ogni tanto non risponde (visto run 10/06 06:45, read timeout sul login) e un blip
    non deve abortire il giro. MAI retry su errori di credenziali: FGLair blocca
    l'account dopo 5 login falliti."""
    for i in range(tries):
        try:
            return fn()
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            if i == tries - 1:
                raise
            print(f"   rete instabile ({what}): {type(e).__name__} — riprovo tra {_RETRY_SLEEP}s [{i + 1}/{tries - 1}]")
            time.sleep(_RETRY_SLEEP)


def read_presence():
    """Ritorna (anyone_home: bool, kids_mode: bool).
    presence.json = {"user":"home/away","jess":"home/away"}.
    anyone = qualcuno in casa; kids = Jessica a casa (≈ bimbi presenti) → modalità soft.
    Default casa+normale se non configurato; 'fuori' (sicuro) se errore."""
    if not PRESENCE_URL:
        return True, False
    try:
        txt = requests.get(PRESENCE_URL, timeout=10).text.strip()
        d = json.loads(txt)
        user = str(d.get("user", "away")).lower() == "home"
        jess = str(d.get("jess", "away")).lower() == "home"
        return (user or jess), jess
    except Exception:
        # fallback formato vecchio "home"/"away"
        try:
            t = txt.lower()
            if "home" in t or "casa" in t:
                return True, True  # ambiguo → prudente: casa + soft (coi bimbi)
        except Exception:
            pass
        return False, False  # tutti fuori (sicuro)


def outdoor_temp():
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast",
                         params={"latitude": LAT, "longitude": LON, "current": "temperature_2m"}, timeout=10)
        return float(r.json()["current"]["temperature_2m"])
    except Exception:
        return None


def aqara_readings():
    api = AqaraOpenAPI("Europe")
    if not api.get_auth(os.environ["AQARA_EMAIL"], os.environ["AQARA_PASSWORD"]):
        raise RuntimeError("Login Aqara fallito")
    dm = AqaraDeviceManager(api)
    dm.generate_devices_and_update_value()
    out = {}
    for did, dev in (getattr(dm, "device_map", None) or {}).items():
        pmap = getattr(dev, "point_map", {}) or {}
        def val(res):
            k = f"{did}__{res}"
            try:
                return int(getattr(pmap[k], "value", pmap[k])) if k in pmap else None
            except Exception:
                return None
        t, h = val(RES_TEMP), val(RES_HUM)
        if t is not None:
            out[did] = {"temp": t / 100, "hum": (h / 100 if h is not None else None)}
    return out


def fg_login():
    body = json.dumps({"user": {"email": os.environ["FGLAIR_EMAIL"], "password": os.environ["FGLAIR_PASSWORD"],
                                "application": {"app_id": APP_ID, "app_secret": APP_SECRET}}})
    tok = requests.post(SIGNIN_URL, headers={"Content-Type": "application/json"}, data=body, timeout=25).json().get("access_token")
    if not tok:
        raise RuntimeError("Login FGLair fallito")
    return {"Content-Type": "application/json", "Authorization": "auth_token " + tok}


def fg_props(H, dsn):
    data = requests.get(PROPS_URL.format(dsn=dsn), headers=H, timeout=15).json()
    return {p["property"]["name"]: {"key": p["property"]["key"], "value": p["property"]["value"]}
            for p in data if isinstance(p, dict) and "property" in p}


def fg_set(H, key, value):
    return requests.post(SET_URL.format(key=key), headers=H,
                         data=json.dumps({"datapoint": {"value": str(value)}}), timeout=15).status_code


def load_emergency():
    """Legge emergency.json (file locale nel repo checked-out). {} se assente/illeggibile."""
    try:
        return json.load(open(EMERGENCY_FILE))
    except Exception:
        return {}


def emergency_mode(d=None):
    """Ritorna 'off' / 'safe' se c'è un'emergenza ANCORA attiva (now < until), altrimenti None.
    Fail-safe: qualsiasi errore/scadenza → None (funzionamento normale)."""
    if d is None:
        d = load_emergency()
    try:
        if d.get("mode") in ("off", "safe") and now_it().timestamp() < float(d.get("until", 0)):
            return d["mode"]
    except Exception:
        pass
    return None


def load_autostate():
    try:
        return json.load(open(AUTOSTATE_FILE))
    except Exception:
        return {}


def save_autostate(d):
    json.dump(d, open(AUTOSTATE_FILE, "w"))


def control_room(room, readings, H, autostate, actions, emerg, anyone, target, now_ts):
    """Gestisce UNA stanza, isolata: un errore qui viene catturato dal chiamante e non
    blocca le altre stanze. Ritorna True se l'EMERGENZA ha rimesso a posto una mossa manuale."""
    dsn = room["dsn"]
    p = fg_props(H, dsn)
    cur_mode = p["operation_mode"]["value"]
    cur_sp_raw = p["adjust_temperature"]["value"]
    cur_sp = cur_sp_raw / 10
    r = readings.get(room["sensor"])
    if r:
        temp = r["temp"]; hum = r.get("hum"); src = "Aqara"
    else:
        # FALLBACK: Aqara non disponibile → temperatura interna del clima (display_temperature),
        # decodifica (val-5000)/100. Niente umidità → la logica dry resta disattivata.
        dt = p.get("display_temperature", {}).get("value")
        temp = (dt - 5000) / 100 if dt else None
        hum = None; src = "clima"
        if temp is None:
            print(f"[{room['name']}] nessuna temperatura (Aqara giù + display assente), salto.")
            return False
    print(f"\n[{room['name']}] reale={temp:.1f}°C ({src}) | clima: {MODE.get(cur_mode)} @ {cur_sp:.1f}°C")
    st = autostate.get(dsn, {})
    q = room.get("quiet_from")
    in_quiet = q is not None and in_quiet_window(now_it().hour + now_it().minute / 60,
                                                 wake_hour_for(now_it().date()), qs=q)

    # EMERGENZA — lockout deliberato 24h: vince su TUTTO (presenza, target, blocco manuale, notte).
    if emerg == "off":
        reverted = cur_mode != 0
        if reverted:
            print("   🆘 emergenza: spengo")
            if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
        autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
        return reverted
    if emerg == "safe":
        # cameretta nelle sue ore notturne resta comunque spenta (Eva dorme)
        if in_quiet:
            reverted = cur_mode != 0
            if reverted:
                print("   🆘 sicura + notte cameretta → spengo")
                if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
            autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
            return reverted
        # cool gentile: 26°, ventola silenziosa, alette in alto, niente oscillazione
        sp_raw = int(SAFE_TARGET * 10)
        changed = []
        if cur_mode != COOL:
            if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], COOL)
            changed.append("cool")
        if cur_sp_raw != sp_raw:
            if not DRY_RUN: fg_set(H, p["adjust_temperature"]["key"], sp_raw)
            changed.append(f"{SAFE_TARGET:g}°")
        if p.get("fan_speed", {}).get("value") != FAN_QUIET:
            if not DRY_RUN: fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
            changed.append("quiet")
        if p.get("af_vertical_swing", {}).get("value"):
            if not DRY_RUN: fg_set(H, p["af_vertical_swing"]["key"], 0)
            changed.append("alette su")
        if "af_vertical_direction" in p and p["af_vertical_direction"]["value"] != 1:
            if not DRY_RUN: fg_set(H, p["af_vertical_direction"]["key"], 1)
        if changed:
            print(f"   🆘 modalità sicura → {', '.join(changed)}")
        autostate[dsn] = {"mode": COOL, "sp": sp_raw, "hold_until": 0}
        return bool(changed)

    # FASCIA NOTTURNA CAMERETTA (sera 22:00 → risveglio 09:30 feriali / 12:00 weekend-festivi).
    # Tutta la fascia è scavalcabile a mano: spenta di DEFAULT, ma una mossa manuale regge HOLD_HOURS
    # (gestita più sotto, dopo il blocco manuale). 'in_quiet' è calcolato sopra.

    # SICUREZZA — Tutti fuori: spento (vince su tutto tranne l'emergenza)
    if not anyone:
        if cur_mode != 0:
            print("   tutti fuori → spengo")
            if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
            actions.append(f"{room['name']}: tutti fuori → spento")
        else:
            print("   tutti fuori, già spento")
        autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
        return False

    # BLOCCO MANUALE — se attivo, non intervengo
    if now_ts < st.get("hold_until", 0):
        until = datetime.fromtimestamp(st["hold_until"], TZ_ROME).strftime("%H:%M")
        print(f"   blocco manuale attivo fino alle {until} → non intervengo")
        return False
    # rilevo un cambio fatto a MANO (telecomando o bot): stato diverso da quello che avevo impostato io.
    # In dry il clima può riportare un setpoint suo → lì confronto solo il modo (niente falsi blocchi).
    if st.get("mode") is not None and (cur_mode != st["mode"]
                                       or (st["mode"] != DRY and cur_sp_raw != st["sp"])):
        until_ts = now_ts + HOLD_SECONDS
        autostate[dsn] = {"mode": cur_mode, "sp": cur_sp_raw, "hold_until": until_ts}
        until = datetime.fromtimestamp(until_ts, TZ_ROME).strftime("%H:%M")
        print(f"   cambio manuale rilevato → automatismo in pausa fino alle {until}")
        actions.append(f"{room['name']}: cambio manuale → pausa fino {until}")
        return False

    # FASCIA NOTTURNA cameretta: nessun override manuale attivo → tieni spento come da fascia
    if in_quiet:
        if cur_mode != 0:
            print("   fascia notturna → spengo (scavalcabile a mano)")
            if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
            actions.append(f"{room['name']}: notte → spento")
        else:
            print("   fascia notturna, già spento")
        autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
        return False

    # CONTROLLO DOLCE verso il target
    room_target = target
    error = temp - room_target

    # GESTIONE UMIDITÀ — solo qui (mai in emergenza/notte/fuori/blocco manuale); 'hum' può essere None in fallback.
    if cur_mode == DRY and st.get("mode") == DRY:
        # il dry l'abbiamo messo noi: torna cool se l'aria è asciutta o la stanza si è riscaldata
        if (hum is not None and hum <= RH_DRY_OFF) or error >= 1.0:
            new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, round_half(room_target)))
            why = "umidità ok" if (hum is not None and hum <= RH_DRY_OFF) else "temperatura risalita"
            print(f"   💧→❄️ {why} → torno cool {new_sp:.1f}°C")
            if not DRY_RUN:
                fg_set(H, p["operation_mode"]["key"], COOL)
                fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
                fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
                actions.append(f"{room['name']}: {why} → cool {new_sp:.1f}°C")
            autostate[dsn] = {"mode": COOL, "sp": int(new_sp * 10), "hold_until": 0}
        else:
            print(f"   💧 dry attivo (umidità {hum:.0f}%)" if hum is not None else "   💧 dry attivo")
            autostate[dsn] = {"mode": DRY, "sp": cur_sp_raw, "hold_until": 0}
        return False
    if cur_mode == COOL and hum is not None and hum >= RH_DRY_ON and error <= 0.5:
        print(f"   ❄️→💧 vicino al target ma umidità {hum:.0f}% → dry")
        if not DRY_RUN:
            fg_set(H, p["operation_mode"]["key"], DRY)
            fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
            actions.append(f"{room['name']}: umidità {hum:.0f}% → dry")
        autostate[dsn] = {"mode": DRY, "sp": cur_sp_raw, "hold_until": 0}
        return False

    if cur_mode != COOL:
        new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, round_half(room_target)))
        print(f"   avvio cool {new_sp:.1f}°C")
        if not DRY_RUN:
            fg_set(H, p["operation_mode"]["key"], COOL)
            fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
            fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
            actions.append(f"{room['name']}: acceso cool {new_sp:.1f}°C")
        autostate[dsn] = {"mode": COOL, "sp": int(new_sp * 10), "hold_until": 0}
    elif abs(error) <= DEADZONE:
        print(f"   stabile a {temp:.1f}°C (nessun cambio)")
        autostate[dsn] = {"mode": COOL, "sp": cur_sp_raw, "hold_until": 0}
    else:
        new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, round_half(cur_sp + (-STEP if error > 0 else STEP))))
        print(f"   {temp:.1f} vs {room_target:.1f} → setpoint {new_sp:.1f}°C")
        if not DRY_RUN and int(new_sp * 10) != cur_sp_raw:
            fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
        autostate[dsn] = {"mode": COOL, "sp": int(new_sp * 10), "hold_until": 0}
    return False


def main():
    actions = []
    print(f"== Ponte CLOUD @ {now_it():%H:%M} IT (DRY_RUN={DRY_RUN}) ==")
    try:
        anyone, kids = read_presence()
        base = TARGET_SOFT if kids else BASE_TARGET
        out = outdoor_temp()
        target = base if out is None else max(base, out - MAX_DELTA)
        stato = "tutti fuori" if not anyone else ("Jessica/bimbi a casa (soft)" if kids else "solo adulto a casa")
        print(f"Presenza: {stato} | esterno: {out}°C | target: {target:.1f}°C")

        em = load_emergency()
        emerg = emergency_mode(em)
        if emerg:
            until = datetime.fromtimestamp(float(em.get("until", 0)), TZ_ROME).strftime("%d/%m %H:%M")
            print(f"🆘 EMERGENZA ATTIVA: {emerg} (fino a {until}) — bypass dell'automatismo normale")

        try:
            readings = with_retry(aqara_readings, what="lettura Aqara")
            aqara_ok = True
            print("Aqara:", {k[-6:]: f"{v['temp']:.1f}°C/{v['hum']:.0f}%" if v['hum'] else f"{v['temp']:.1f}°C" for k, v in readings.items()})
        except Exception as e:
            readings = {}; aqara_ok = False
            print(f"⚠️ Aqara non raggiungibile ({e}) → fallback temperatura interna clima")

        # pubblica temperature/umidità per il bot Telegram (sensors.json nel repo)
        try:
            rooms_out = []
            for did, name in SENSOR_NAMES.items():
                v = readings.get(did)
                if v:
                    rooms_out.append({"name": name, "t": round(v["temp"], 1),
                                      "h": (round(v["hum"]) if v["hum"] is not None else None)})
            json.dump({"updated": now_it().strftime("%H:%M"), "rooms": rooms_out,
                       "emergency": {"mode": emerg or "none", "until": em.get("until", 0)}}, open("sensors.json", "w"))
        except Exception as e:
            print("sensors.json err:", e)

        H = with_retry(fg_login, what="login FGLair")
        autostate = load_autostate()
        now_ts = now_it().timestamp()

        # Notifica quando un'emergenza è APPENA scaduta (transizione attiva → spenta)
        if autostate.get("_emergency") in ("off", "safe") and emerg is None:
            notify("✅ Emergenza terminata: l'automatismo del clima è ripreso normalmente.")
        autostate["_emergency"] = emerg or "none"

        # Notifica una sola volta l'ingresso/uscita dalla modalità degradata (Aqara giù → sensore interno clima)
        if not aqara_ok and not autostate.get("_aqara_down"):
            notify("⚠️ Sensori Aqara non raggiungibili: uso la temperatura interna dei condizionatori "
                   "(niente umidità/dry, niente monitoraggio Camera/Bagno) finché non tornano.")
        elif aqara_ok and autostate.get("_aqara_down"):
            notify("✅ Sensori Aqara di nuovo raggiungibili.")
        autostate["_aqara_down"] = (not aqara_ok)
        emergency_reverted = False  # True se l'emergenza ha dovuto rimettere a posto una mossa manuale

        # Stanze gestite in ISOLAMENTO: un errore (es. blip cloud Ayla su un dsn)
        # non blocca l'altra stanza — si salta solo quella per questo giro.
        room_errors = []
        for room in ROOMS:
            try:
                if control_room(room, readings, H, autostate, actions, emerg, anyone, target, now_ts):
                    emergency_reverted = True
            except Exception as e:
                print(f"   ⚠️ [{room['name']}] errore stanza: {e}")
                room_errors.append(f"{room['name']}: {e}")

        if not DRY_RUN:
            save_autostate(autostate)

        if emergency_reverted:
            until = datetime.fromtimestamp(float(em.get("until", 0)), TZ_ROME).strftime("%H:%M")
            label = "Tutto spento" if emerg == "off" else "Modalità sicura"
            notify(("[PROVA] " if DRY_RUN else "") +
                   f"🆘 Emergenza «{label}» attiva fino alle {until}: ho riportato i climi allo stato di emergenza.\n"
                   f"Per comandarli a mano premi ✅ Annulla SOS nel bot.")
        elif actions:
            notify("🌡️ " + ("[PROVA] " if DRY_RUN else "") + " | ".join(actions))
        if room_errors:
            notify("⚠️ Ponte clima: errore su " + " | ".join(room_errors) +
                   " — le altre stanze sono state gestite; riprovo al prossimo giro.")
        print("\nFine ciclo.")
    except Exception as e:
        notify(f"⚠️ Ponte clima ERRORE: {e}")
        raise


if __name__ == "__main__":
    main()
