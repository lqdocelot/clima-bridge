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


def quiet_phase(h, qe, hard_end=7.0, qs=22):
    """Classifica l'ora decimale h nella fascia di spegnimento cameretta.
    qs = sera (22), qe = fine finestra/risveglio (9.5 feriali, 12 weekend-festivi),
    hard_end = confine notte-profonda/coda-mattutina (default 07:00).
      'hard' = notte profonda (qs→hard_end): spento ASSOLUTO, non scavalcabile a mano
      'soft' = coda mattutina (hard_end→qe): spento di default ma scavalcabile a mano per HOLD
      None   = fuori finestra: controllo normale.
    Le finestre gestiscono il wrap a mezzanotte (qs > qe/hard_end)."""
    def in_win(a, b):
        return (a <= h or h < b) if a > b else (a <= h < b)
    if not in_win(qs, qe):
        return None
    return "hard" if in_win(qs, hard_end) else "soft"

DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"

# ---- Comfort (tarabili anche da env) ----
BASE_TARGET = float(os.environ.get("TARGET", "25.0"))      # target normale (solo adulto a casa)
TARGET_SOFT = float(os.environ.get("TARGET_SOFT", "25.0"))  # target gentile quando ci sono i bimbi (Jessica a casa)
DEADZONE = 0.3
STEP = 0.5
SETPOINT_MIN, SETPOINT_MAX = 20.0, 29.0
MAX_DELTA = float(os.environ.get("MAX_DELTA", "6.0"))
NIGHT_BUMP = float(os.environ.get("NIGHT_BUMP", "1.5"))  # di notte (23-7) alza il target nelle stanze senza fascia quiet (es. soggiorno)
# Risveglio cameretta: ora (decimale) di riaccensione al mattino dopo la fascia notturna.
WAKE_NORMAL = float(os.environ.get("WAKE_HOUR", "9.5"))       # feriali → 09:30
WAKE_HOME = float(os.environ.get("WAKE_HOUR_HOME", "12.0"))   # weekend/festivi → 12:00 (si dorme)
HARD_QUIET_END = float(os.environ.get("HARD_QUIET_END", "7.0"))  # 22:00→07:00 spegnimento ASSOLUTO; dopo, coda scavalcabile a mano
HOLD_SECONDS = int(float(os.environ.get("HOLD_HOURS", "1")) * 3600)  # blocco manuale: dopo un cambio a mano, l'automatismo si ferma per N ore
AUTOSTATE_FILE = "autostate.json"  # memoria di cosa ha impostato l'automatismo + scadenza blocco manuale (nel repo)
RH_MAX = 60
LAT, LON = 45.0703, 7.6869  # Torino (regolabile)

# ---- FGLair ----
SIGNIN_URL = "https://user-field-eu.aylanetworks.com/users/sign_in.json"
BASE = "https://ads-field-eu.aylanetworks.com/apiv1/"
PROPS_URL = BASE + "dsns/{dsn}/properties.json"
SET_URL = BASE + "properties/{key}/datapoints.json"
APP_ID, APP_SECRET = "FGLair-eu-id", "FGLair-eu-gpFbVBRoiJ8E3QWJ-QRULLL3j3U"
MODE = {0: "off", 2: "auto", 3: "cool", 4: "dry", 5: "fan_only", 6: "heat"}
COOL = 3
FAN_QUIET = 0

RES_TEMP, RES_HUM = "0.1.85", "0.2.85"
# nomi leggibili dei sensori Aqara (per il bot Telegram)
SENSOR_NAMES = {
    "lumi.158d008afda8d2": "🛋️ Soggiorno",
    "lumi.158d0008974abd": "🧸 Cameretta EVA",
    "lumi.158d008afda91f": "🛏️ Camera",
    "lumi.158d0008ab1164": "🚿 Bagno",
}
ROOMS = [
    {"name": "SOGGIORNO", "dsn": "AC000W002919142", "sensor": "lumi.158d008afda8d2"},
    # CAMERA = cameretta di Eva: spento la notte; riaccensione mattutina dinamica
    # (feriali WAKE_NORMAL=09:30, weekend/festivi WAKE_HOME=12:00). Vedi wake_hour_for().
    {"name": "CAMERA",    "dsn": "AC000W002919128", "sensor": "lumi.158d0008974abd", "quiet": (22, WAKE_NORMAL)},
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
    tok = requests.post(SIGNIN_URL, headers={"Content-Type": "application/json"}, data=body, timeout=15).json().get("access_token")
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


def load_autostate():
    try:
        return json.load(open(AUTOSTATE_FILE))
    except Exception:
        return {}


def save_autostate(d):
    json.dump(d, open(AUTOSTATE_FILE, "w"))


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

        readings = aqara_readings()
        print("Aqara:", {k[-6:]: f"{v['temp']:.1f}°C/{v['hum']:.0f}%" if v['hum'] else f"{v['temp']:.1f}°C" for k, v in readings.items()})

        # pubblica temperature/umidità per il bot Telegram (sensors.json nel repo)
        try:
            rooms_out = []
            for did, name in SENSOR_NAMES.items():
                v = readings.get(did)
                if v:
                    rooms_out.append({"name": name, "t": round(v["temp"], 1),
                                      "h": (round(v["hum"]) if v["hum"] is not None else None)})
            json.dump({"updated": now_it().strftime("%H:%M"), "rooms": rooms_out}, open("sensors.json", "w"))
        except Exception as e:
            print("sensors.json err:", e)

        H = fg_login()
        autostate = load_autostate()
        now_ts = now_it().timestamp()

        for room in ROOMS:
            dsn = room["dsn"]
            r = readings.get(room["sensor"])
            if not r:
                print(f"[{room['name']}] sensore non letto, salto."); continue
            temp = r["temp"]
            p = fg_props(H, dsn)
            cur_mode = p["operation_mode"]["value"]
            cur_sp_raw = p["adjust_temperature"]["value"]
            cur_sp = cur_sp_raw / 10
            print(f"\n[{room['name']}] reale={temp:.1f}°C | clima: {MODE.get(cur_mode)} @ {cur_sp:.1f}°C")
            st = autostate.get(dsn, {})

            # SICUREZZA 1 — Fascia notturna cameretta. Sera fissa 22:00; risveglio 09:30 feriali / 12:00 weekend-festivi.
            #  - notte profonda 22:00–07:00 ("hard"): spento ASSOLUTO, vince anche sul blocco manuale.
            #  - coda mattutina 07:00→risveglio ("soft"): spento di default MA un cambio a mano la scavalca per HOLD_HOURS
            #    (gestita più sotto, dopo il blocco manuale, così riusa la stessa logica di pausa).
            q = room.get("quiet")
            phase = quiet_phase(now_it().hour + now_it().minute / 60,
                                wake_hour_for(now_it().date()), HARD_QUIET_END) if q else None
            if phase == "hard":
                if cur_mode != 0:
                    print("   notte profonda → spengo (assoluto)")
                    if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
                    actions.append(f"{room['name']}: notte → spento")
                else:
                    print("   notte profonda, già spento")
                autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
                continue

            # SICUREZZA 2 — Tutti fuori: spento (vince su tutto)
            if not anyone:
                if cur_mode != 0:
                    print("   tutti fuori → spengo")
                    if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
                    actions.append(f"{room['name']}: tutti fuori → spento")
                else:
                    print("   tutti fuori, già spento")
                autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
                continue

            # BLOCCO MANUALE — se attivo, non intervengo
            if now_ts < st.get("hold_until", 0):
                until = datetime.fromtimestamp(st["hold_until"], TZ_ROME).strftime("%H:%M")
                print(f"   blocco manuale attivo fino alle {until} → non intervengo")
                continue
            # rilevo un cambio fatto a MANO (telecomando o bot): stato diverso da quello che avevo impostato io
            if st.get("mode") is not None and (cur_mode != st["mode"] or cur_sp_raw != st["sp"]):
                until_ts = now_ts + HOLD_SECONDS
                autostate[dsn] = {"mode": cur_mode, "sp": cur_sp_raw, "hold_until": until_ts}
                until = datetime.fromtimestamp(until_ts, TZ_ROME).strftime("%H:%M")
                print(f"   cambio manuale rilevato → automatismo in pausa fino alle {until}")
                actions.append(f"{room['name']}: cambio manuale → pausa fino {until}")
                continue

            # CODA MATTUTINA (soft, 07:00→risveglio): nessun override manuale attivo → tieni spento come da fascia
            if phase == "soft":
                if cur_mode != 0:
                    print("   coda mattutina → spengo (scavalcabile a mano)")
                    if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], 0)
                    actions.append(f"{room['name']}: mattino → spento")
                else:
                    print("   coda mattutina, già spento")
                autostate[dsn] = {"mode": 0, "sp": cur_sp_raw, "hold_until": 0}
                continue

            # CONTROLLO DOLCE verso il target (con setback notturno per stanze senza quiet)
            room_target = target
            if not q and (23 <= now_it().hour or now_it().hour < 7):
                room_target = target + NIGHT_BUMP
                print(f"   (notte: target soggiorno {room_target:.1f}°C)")
            error = temp - room_target
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

        if not DRY_RUN:
            save_autostate(autostate)

        if actions:
            notify("🌡️ " + ("[PROVA] " if DRY_RUN else "") + " | ".join(actions))
        print("\nFine ciclo.")
    except Exception as e:
        notify(f"⚠️ Ponte clima ERRORE: {e}")
        raise


if __name__ == "__main__":
    main()
