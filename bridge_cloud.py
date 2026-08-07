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
import base64
import hashlib
import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

TZ_ROME = ZoneInfo("Europe/Rome")  # ora locale italiana, esplicita (il runner GitHub è UTC)


def now_it():
    return datetime.now(TZ_ROME)


def in_window(h, start, end):
    """True se l'ora decimale h è in [start..end), con wrap a mezzanotte (es. 22→8)."""
    return (start <= h or h < end) if start > end else (start <= h < end)

DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"

# ---- Comfort v2 (tarabili da env/Variables) ----
COMFORT_TARGET = float(os.environ.get("TARGET", "25.0"))   # comfort dolce, sempre
DEADZONE = 0.3
STEP = 0.5
SETPOINT_MIN, SETPOINT_MAX = 20.0, 29.0
MAX_DELTA = float(os.environ.get("MAX_DELTA", "6.0"))      # cap Δ interno-esterno (anti shock termico)
MAINTENANCE_MAX = float(os.environ.get("MAINTENANCE_MAX", "28.0"))  # via di casa: raffresca solo sopra questa
# Umidità. Di GIORNO (DAY_FROM→DAY_TO) la soglia è più severa e ha la precedenza: appena si
# superano RH_DAY_MAX si passa in dry anche se la stanza è ancora tiepida. Di notte vale la
# soglia alta e conservativa (RH_DRY_ON, solo a temperatura già a posto). Isteresi: RH_DRY_OFF.
RH_DAY_MAX = float(os.environ.get("RH_DAY_MAX", "55"))  # % max di giorno → dry subito
RH_DRY_ON = float(os.environ.get("RH_DRY_ON", "62"))    # % di notte (con temp vicina al target)
RH_DRY_OFF = float(os.environ.get("RH_DRY_OFF", "50"))  # % sotto cui si esce dal dry
DAY_FROM = float(os.environ.get("DAY_FROM", "8"))
DAY_TO = float(os.environ.get("DAY_TO", "22"))
HOT_GUARD = 2.0   # in dry, se la stanza supera target+HOT_GUARD si torna a raffrescare
AUTOSTATE_FILE = "autostate.json"  # memoria di cosa ha impostato l'automatismo + flag override manuale (nel repo)
EMERGENCY_FILE = "emergency.json"  # lockout 24h: {"mode":"off"/"safe"/"none","until":<epoch>}
SAFE_TARGET = float(os.environ.get("SAFE_TARGET", "26"))  # setpoint cool gentile in "modalità sicura"
LAT, LON = 45.0703, 7.6869  # Torino (regolabile)

# ---- FGLair ----
SIGNIN_URL = "https://user-field-eu.aylanetworks.com/users/sign_in.json"
BASE = "https://ads-field-eu.aylanetworks.com/apiv1/"
PROPS_URL = BASE + "dsns/{dsn}/properties.json"
SET_URL = BASE + "properties/{key}/datapoints.json"
APP_ID, APP_SECRET = "FGLair-eu-id", "FGLair-eu-gpFbVBRoiJ8E3QWJ-QRULLL3j3U"
MODE = {0: "off", 2: "auto", 3: "cool", 4: "dry", 5: "fan_only", 6: "heat"}
OFF = 0
COOL = 3
DRY = 4
FAN_ONLY = 5
FAN_QUIET = 0

RES_TEMP, RES_HUM = "0.1.85", "0.2.85"
# nomi leggibili dei sensori Aqara (per il bot Telegram)
SENSOR_NAMES = {
    "lumi.158d008afda8d2": "🛋️ Soggiorno",
    "lumi.158d0008974abd": "🧸 Cameretta EVA",
    "lumi.158d008afda91f": "🛏️ Camera",
    "lumi.158d0008ab1164": "🚿 Bagno",
}
# CAMERETTA di Eva: l'automatismo non la raffresca MAI (né cool né ventola) — si accende solo
# se la forzi a mano. Unica eccezione: nella fascia dry_window controlla l'UMIDITÀ (dry, che non
# raffredda) tenendola sotto RH_DAY_MAX. Il soggiorno invece ha il comfort normale h24.
ROOMS = [
    {"name": "SOGGIORNO", "dsn": "AC000W002919142", "sensor": "lumi.158d008afda8d2"},
    {"name": "CAMERA",    "dsn": "AC000W002919128", "sensor": "lumi.158d0008974abd",
     "always_off": True, "dry_window": (11, 21)},
]

TG_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
PRESENCE_URL = os.environ.get("PRESENCE_URL", "")
# Interruttore presenza: se 'false' il ponte ignora presence.json e assume sempre "casa"
# (nessuno spegnimento per 'tutti fuori'). Disattivata finché non c'è un aggiornatore
# automatico affidabile (automazione WiFi sui telefoni). Riattivare con repo Variable.
PRESENCE_ENABLED = os.environ.get("PRESENCE_ENABLED", "true").lower() != "false"
# Interruttore sensori Aqara: il cloud Aqara è inaccessibile dal 14/06 (app dell'SDK revocata).
# Con 'false' il ponte non tenta nemmeno la lettura (niente attese/hang) e usa direttamente
# la temperatura interna dei climi. Riattivare quando la connessione Aqara sarà ripristinata.
AQARA_ENABLED = os.environ.get("AQARA_ENABLED", "true").lower() != "false"
# Credenziali Open API v3 (progetto approvato sul developer console, regione Europa).
AQARA_EP = "https://open-ger.aqara.com/v3.0/open/api"
AQARA_APP_ID = os.environ.get("AQARA_APP_ID", "")
AQARA_KEY_ID = os.environ.get("AQARA_KEY_ID", "")
AQARA_APP_KEY = os.environ.get("AQARA_APP_KEY", "")
AQARA_REFRESH_TOKEN = os.environ.get("AQARA_REFRESH_TOKEN", "")  # solo bootstrap iniziale
AQARA_TOKEN_FILE = "aqara_token.enc"  # token persistito CIFRATO (il repo è pubblico)
# Sorgente LOCALE dei sensori: il Mac in casa legge i 4 sensori Aqara via Matter (hub M2,
# pairing del 29/05 ancora valido) e pubblica qui — nessun cloud Aqara, nessuna approvazione.
# Usato solo se il file è più fresco di MATTER_MAX_AGE (altrimenti il Mac è spento/fuori casa).
MATTER_FILE = "sensors_matter.json"
MATTER_MAX_AGE = float(os.environ.get("MATTER_MAX_AGE", "2700"))  # 45 min


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


def timeout_session(timeout=20):
    """Session con timeout FORZATO: l'SDK Aqara fa le sue POST senza timeout, quindi se il
    cloud non risponde la chiamata resta appesa all'infinito e blocca l'intero giro
    (visto 06/08: run da 900-1400s, job in coda cancellati a raffica)."""
    class _S(requests.Session):
        def request(self, *a, **kw):
            kw.setdefault("timeout", timeout)
            return super().request(*a, **kw)
    return _S()


_RETRY_SLEEP = 8  # secondi tra i tentativi di rete (azzerato nei test)


# Errori di rete TRANSITORI da ritentare: timeout, connessione, e risposta vuota/non-JSON
# (il cloud Ayla/Aqara ogni tanto risponde HTML/vuoto → .json() solleva JSONDecodeError).
# NON si ritenta su RuntimeError (credenziali/login rifiutato): FGLair blocca dopo 5 tentativi.
TRANSIENT = (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
             requests.exceptions.JSONDecodeError)


def with_retry(fn, tries=3, what=""):
    """Riprova fn solo sugli errori transitori (vedi TRANSIENT). Visto: read timeout sul
    login (10/06) e risposta non-JSON dal login FGLair (20/06 07:30)."""
    for i in range(tries):
        try:
            return fn()
        except TRANSIENT as e:
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


def matter_readings():
    """Letture pubblicate dal Mac via Matter (LAN). {} se il file manca, è illeggibile o è
    troppo vecchio — in quel caso si passa alle sorgenti successive senza far danni."""
    try:
        d = json.load(open(MATTER_FILE))
        age = now_it().timestamp() - float(d.get("updated", 0))
        if age > MATTER_MAX_AGE:
            print(f"   (sensori Matter stantii: {age/60:.0f} min fa → ignorati)")
            return {}
        out = {}
        for did, v in (d.get("rooms") or {}).items():
            t = v.get("temp")
            if t is not None:
                out[did] = {"temp": float(t), "hum": (float(v["hum"]) if v.get("hum") is not None else None)}
        return out
    except Exception:
        return {}


class AqaraNotConfigured(RuntimeError):
    """Credenziali Aqara assenti: è una configurazione mancante (o una scelta), NON un guasto —
    quindi niente notifica d'allarme, si passa semplicemente alla sorgente successiva."""


def _token_key():
    """Chiave di cifratura derivata dall'app key (che sta nei Secrets): nessun segreto in più
    da gestire, e il file nel repo pubblico resta illeggibile."""
    from cryptography.fernet import Fernet
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(AQARA_APP_KEY.encode()).digest()))


def load_aqara_token():
    """Token salvato (cifrato) nel repo. {} se assente, illeggibile o cifrato con altra chiave."""
    try:
        return json.loads(_token_key().decrypt(open(AQARA_TOKEN_FILE, "rb").read()).decode())
    except Exception:
        return {}


def save_aqara_token(tok):
    """Persiste il token cifrato: ogni refresh invalida il precedente, quindi il nuovo
    DEVE essere salvato (imparato a spese nostre il 07/08)."""
    try:
        open(AQARA_TOKEN_FILE, "wb").write(_token_key().encrypt(json.dumps(tok).encode()))
    except Exception as e:
        print("   ⚠️ salvataggio token Aqara fallito:", e)


def _aqara_headers(token=""):
    """Firma Aqara Open API v3: MD5 di [Accesstoken=..&]Appid=..&Keyid=..&Nonce=..&Time=..+AppKey,
    tutto minuscolo."""
    now = str(int(time.time() * 1000))
    raw = ((f"Accesstoken={token}&" if token else "")
           + f"Appid={AQARA_APP_ID}&Keyid={AQARA_KEY_ID}&Nonce={now}&Time={now}{AQARA_APP_KEY}")
    h = {"Appid": AQARA_APP_ID, "Keyid": AQARA_KEY_ID, "Nonce": now, "Time": now,
         "Sign": hashlib.md5(raw.lower().encode()).hexdigest(),
         "Lang": "en", "Content-Type": "application/json"}
    if token:
        h["Accesstoken"] = token
    return h


def _aqara_call(intent, data, token=""):
    r = requests.post(AQARA_EP, headers=_aqara_headers(token),
                      data=json.dumps({"intent": intent, "data": data}), timeout=20).json()
    if r.get("code") != 0:
        raise RuntimeError(f"Aqara {intent}: {r.get('code')} {r.get('message')}")
    return r.get("result")


def aqara_readings():
    """Legge i sensori dal cloud Aqara con l'Open API v3 firmata (progetto approvato).
    Il refresh token è riutilizzabile, quindi non serve persistere nulla: a ogni giro
    si ottiene un access token fresco. Niente SDK (l'app della libreria è stata revocata)."""
    if not (AQARA_APP_ID and AQARA_KEY_ID and AQARA_APP_KEY):
        raise AqaraNotConfigured("credenziali Aqara non configurate")
    saved = load_aqara_token()
    tok = saved.get("accessToken")
    # rinnova solo quando serve (l'access token dura ~30 giorni): ogni refresh invalida il
    # precedente, quindi il nuovo va SEMPRE persistito.
    if not tok or time.time() > float(saved.get("expiresAt", 0)) - 86400:
        rt = saved.get("refreshToken") or AQARA_REFRESH_TOKEN
        if not rt:
            raise RuntimeError("Aqara: nessun refresh token disponibile")
        res = _aqara_call("config.auth.refreshToken", {"refreshToken": rt}) or {}
        tok = res.get("accessToken")
        if not tok:
            raise RuntimeError("Aqara: refresh token rifiutato")
        save_aqara_token({"accessToken": tok, "refreshToken": res.get("refreshToken") or rt,
                          "expiresAt": time.time() + float(res.get("expiresIn") or 2592000)})
        print("   (token Aqara rinnovato e salvato)")
    res = _aqara_call("query.resource.value",
                      {"resources": [{"subjectId": did, "resourceIds": [RES_TEMP, RES_HUM]}
                                     for did in SENSOR_NAMES]}, token=tok) or []
    vals = {}
    for item in res:
        vals.setdefault(item["subjectId"], {})[item["resourceId"]] = item.get("value")
    out = {}
    for did, v in vals.items():
        t, h = v.get(RES_TEMP), v.get(RES_HUM)
        if t is not None:
            out[did] = {"temp": int(t) / 100, "hum": (int(h) / 100 if h is not None else None)}
    return out


def fg_login():
    body = json.dumps({"user": {"email": os.environ["FGLAIR_EMAIL"], "password": os.environ["FGLAIR_PASSWORD"],
                                "application": {"app_id": APP_ID, "app_secret": APP_SECRET}}})
    tok = requests.post(SIGNIN_URL, headers={"Content-Type": "application/json"}, data=body, timeout=25).json().get("access_token")
    if not tok:
        raise RuntimeError("Login FGLair fallito")
    return {"Content-Type": "application/json", "Authorization": "auth_token " + tok}


def fg_props(H, dsn):
    # auto-ritenta sui blip transitori del cloud Ayla (read timeout, risposta non-JSON)
    def _go():
        data = requests.get(PROPS_URL.format(dsn=dsn), headers=H, timeout=20).json()
        return {p["property"]["name"]: {"key": p["property"]["key"], "value": p["property"]["value"]}
                for p in data if isinstance(p, dict) and "property" in p}
    return with_retry(_go, what=f"props {dsn[-4:]}")


def fg_set(H, key, value):
    def _go():
        return requests.post(SET_URL.format(key=key), headers=H,
                             data=json.dumps({"datapoint": {"value": str(value)}}), timeout=20).status_code
    return with_retry(_go, what="set")


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


def control_room(room, readings, H, autostate, actions, emerg, away, target):
    """Gestisce UNA stanza, isolata. Gerarchia: EMERGENZA > OVERRIDE MANUALE (sticky, fino a
    ▶️ Comfort) > NOTTE cameretta (solo ventola) > VIA di casa (mantenimento) > COMFORT dolce+dry.
    Ritorna True se l'EMERGENZA ha dovuto rimettere a posto una mossa manuale."""
    dsn = room["dsn"]
    p = fg_props(H, dsn)
    cur_mode = p["operation_mode"]["value"]
    cur_sp_raw = p["adjust_temperature"]["value"]
    cur_sp = cur_sp_raw / 10
    r = readings.get(room["sensor"])
    if r:
        temp = r["temp"]; hum = r.get("hum"); src = "Aqara"
    else:
        # FALLBACK: Aqara giù → temperatura interna del clima (display_temperature); niente umidità.
        dt = p.get("display_temperature", {}).get("value")
        temp = (dt - 5000) / 100 if dt else None
        hum = None; src = "clima"
        if temp is None:
            print(f"[{room['name']}] nessuna temperatura (Aqara giù + display assente), salto.")
            return False
    print(f"\n[{room['name']}] reale={temp:.1f}°C ({src}) | clima: {MODE.get(cur_mode)} @ {cur_sp:.1f}°C")
    st = autostate.get(dsn, {})

    def remember(mode, sp_raw, manual=False):
        autostate[dsn] = {"mode": mode, "sp": sp_raw, "manual": manual}

    # 1) EMERGENZA (off/safe) — vince su tutto. Ritorna True se ha annullato una mossa manuale.
    if emerg == "off":
        reverted = cur_mode != OFF
        if reverted:
            print("   🆘 emergenza: spengo")
            if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], OFF)
        remember(OFF, cur_sp_raw)
        return reverted
    if emerg == "safe":
        if room.get("always_off"):   # la cameretta non si accende nemmeno in modalità sicura
            reverted = cur_mode != OFF
            if reverted:
                print("   🆘 sicura: cameretta resta spenta")
                if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], OFF)
            remember(OFF, cur_sp_raw)
            return reverted
        sp_raw = int(SAFE_TARGET * 10); changed = []
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
        remember(COOL, sp_raw)
        return bool(changed)

    # 2) OVERRIDE MANUALE STICKY — resta finché non si preme ▶️ Comfort (comfort.yml azzera il flag).
    if st.get("manual"):
        print("   ✋ override manuale attivo (▶️ Comfort per riprendere) → non intervengo")
        return False
    # rilevo un cambio a mano (telecomando o bot): stato ≠ ultimo impostato dall'automatismo.
    # In dry il clima riporta un setpoint suo → lì confronto solo il modo.
    if st.get("mode") is not None and (cur_mode != st["mode"]
                                       or (st["mode"] != DRY and cur_sp_raw != st["sp"])):
        remember(cur_mode, cur_sp_raw, manual=True)
        print("   ✋ cambio manuale → resta finché non premi ▶️ Comfort")
        actions.append(f"{room['name']}: override manuale (resta fino a ▶️ Comfort)")
        return False

    # 3) CAMERETTA: mai raffrescata dall'automatismo. Nella fascia dry_window controlla solo
    #    l'umidità (dry, che non raffredda); fuori fascia e ad aria asciutta resta spenta.
    if room.get("always_off"):
        win = room.get("dry_window")
        h = now_it().hour + now_it().minute / 60
        if win and hum is not None and in_window(h, win[0], win[1]) and hum >= RH_DAY_MAX:
            if cur_mode != DRY:
                print(f"   💧 cameretta: umidità {hum:.0f}% → dry (non raffredda)")
                if not DRY_RUN:
                    fg_set(H, p["operation_mode"]["key"], DRY)
                    fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
                actions.append(f"{room['name']}: umidità {hum:.0f}% → dry")
            remember(DRY, cur_sp_raw)
            return False
        # in dry con umidità ancora nella zona d'isteresi (tra RH_DRY_OFF e RH_DAY_MAX): lascia finire
        if (cur_mode == DRY and st.get("mode") == DRY and win and hum is not None
                and in_window(h, win[0], win[1]) and hum > RH_DRY_OFF):
            print(f"   💧 cameretta: dry in corso (umidità {hum:.0f}%)")
            remember(DRY, cur_sp_raw)
            return False
        if cur_mode != OFF:
            print("   🛏️ cameretta → spenta (l'automatismo non la accende mai)")
            if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], OFF)
            actions.append(f"{room['name']}: spenta")
        remember(OFF, cur_sp_raw)
        return False

    # 4) VIA DI CASA → mantenimento: raffresca solo se troppo caldo, altrimenti spento (dormiente finché PRESENCE_ENABLED=false)
    if away:
        sp_raw = int(round_half(MAINTENANCE_MAX) * 10)
        if temp > MAINTENANCE_MAX:
            if cur_mode != COOL or cur_sp_raw != sp_raw:
                print(f"   🛰️ via: mantenimento → cool {MAINTENANCE_MAX:g}°")
                if not DRY_RUN:
                    fg_set(H, p["operation_mode"]["key"], COOL)
                    fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
                    fg_set(H, p["adjust_temperature"]["key"], sp_raw)
                actions.append(f"{room['name']}: via → mantenimento {MAINTENANCE_MAX:g}°")
            remember(COOL, sp_raw)
        else:
            if cur_mode != OFF:
                print("   🛰️ via: in banda → spengo")
                if not DRY_RUN: fg_set(H, p["operation_mode"]["key"], OFF)
                actions.append(f"{room['name']}: via → spento")
            remember(OFF, cur_sp_raw)
        return False

    # 5) COMFORT dolce verso target + umidità (dry quando l'umidità è disponibile)
    error = temp - target
    is_day = in_window(now_it().hour + now_it().minute / 60, DAY_FROM, DAY_TO)
    if cur_mode == DRY and st.get("mode") == DRY:
        # esce dal dry se l'aria è asciutta, o se la stanza si scalda troppo (guardia)
        if (hum is not None and hum <= RH_DRY_OFF) or error >= (HOT_GUARD if is_day else 1.0):
            new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, round_half(target)))
            why = "umidità ok" if (hum is not None and hum <= RH_DRY_OFF) else "temperatura risalita"
            print(f"   💧→❄️ {why} → torno cool {new_sp:.1f}°C")
            if not DRY_RUN:
                fg_set(H, p["operation_mode"]["key"], COOL)
                fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
                fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
                actions.append(f"{room['name']}: {why} → cool {new_sp:.1f}°C")
            remember(COOL, int(new_sp * 10))
        else:
            print("   💧 dry attivo" + (f" (umidità {hum:.0f}%)" if hum is not None else ""))
            remember(DRY, cur_sp_raw)
        return False
    # di giorno l'umidità ha la precedenza (dry appena sopra RH_DAY_MAX, anche se tiepido);
    # di notte serve sia aria molto umida sia temperatura già a posto.
    if cur_mode == COOL and hum is not None and (
            (is_day and hum >= RH_DAY_MAX and error < HOT_GUARD)
            or (not is_day and hum >= RH_DRY_ON and error <= 0.5)):
        print(f"   ❄️→💧 umidità {hum:.0f}% → dry")
        if not DRY_RUN:
            fg_set(H, p["operation_mode"]["key"], DRY)
            fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
            actions.append(f"{room['name']}: umidità {hum:.0f}% → dry")
        remember(DRY, cur_sp_raw)
        return False
    if cur_mode != COOL:
        new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, round_half(target)))
        print(f"   avvio cool {new_sp:.1f}°C")
        if not DRY_RUN:
            fg_set(H, p["operation_mode"]["key"], COOL)
            fg_set(H, p["fan_speed"]["key"], FAN_QUIET)
            fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
            actions.append(f"{room['name']}: acceso cool {new_sp:.1f}°C")
        remember(COOL, int(new_sp * 10))
    elif abs(error) <= DEADZONE:
        print(f"   stabile a {temp:.1f}°C")
        remember(COOL, cur_sp_raw)
    else:
        new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, round_half(cur_sp + (-STEP if error > 0 else STEP))))
        print(f"   {temp:.1f} vs {target:.1f} → setpoint {new_sp:.1f}°C")
        if not DRY_RUN and int(new_sp * 10) != cur_sp_raw:
            fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
        remember(COOL, int(new_sp * 10))
    return False


def main():
    actions = []
    print(f"== Ponte CLOUD @ {now_it():%H:%M} IT (DRY_RUN={DRY_RUN}) ==")
    try:
        anyone = read_presence()[0] if PRESENCE_ENABLED else True
        away = PRESENCE_ENABLED and not anyone   # 'via di casa' → mantenimento (dormiente finché presenza OFF)
        out = outdoor_temp()
        target = COMFORT_TARGET if out is None else max(COMFORT_TARGET, out - MAX_DELTA)
        stato = ("presenza OFF (comfort sempre)" if not PRESENCE_ENABLED
                 else ("VIA → mantenimento" if away else "a casa → comfort"))
        print(f"Presenza: {stato} | esterno: {out}°C | target comfort: {target:.1f}°C")

        em = load_emergency()
        emerg = emergency_mode(em)
        if emerg:
            until = datetime.fromtimestamp(float(em.get("until", 0)), TZ_ROME).strftime("%d/%m %H:%M")
            print(f"🆘 EMERGENZA ATTIVA: {emerg} (fino a {until}) — bypass dell'automatismo normale")

        # Sorgenti sensori in ordine: 1) Matter locale (Mac in casa) 2) cloud Aqara 3) sensore interno clima
        readings = matter_readings()
        aqara_skipped = True
        if readings:
            aqara_ok = True
            print("Sensori via Matter (locale):",
                  {k[-6:]: f"{v['temp']:.1f}°C/{v['hum']:.0f}%" if v['hum'] is not None else f"{v['temp']:.1f}°C"
                   for k, v in readings.items()})
        elif not AQARA_ENABLED:
            aqara_ok = False
            print("Nessun dato Matter e Aqara disattivato → temperatura interna dei climi")
        else:
            aqara_skipped = False   # tentiamo davvero il cloud: un fallimento va notificato
            try:
                readings = with_retry(aqara_readings, what="lettura Aqara")
                aqara_ok = True
                print("Aqara:", {k[-6:]: f"{v['temp']:.1f}°C/{v['hum']:.0f}%" if v['hum'] else f"{v['temp']:.1f}°C" for k, v in readings.items()})
            except AqaraNotConfigured:
                readings = {}; aqara_ok = False; aqara_skipped = True   # nessun allarme
                print("Aqara non configurato (mancano i secrets) → temperatura interna dei climi")
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

        # Notifica quando un'emergenza è APPENA scaduta (transizione attiva → spenta)
        if autostate.get("_emergency") in ("off", "safe") and emerg is None:
            notify("✅ Emergenza terminata: l'automatismo del clima è ripreso normalmente.")
        autostate["_emergency"] = emerg or "none"

        # Notifica una sola volta l'ingresso/uscita dalla modalità degradata (Aqara giù → sensore interno clima).
        # Se Aqara è disattivato di proposito non c'è nulla da notificare.
        if aqara_skipped:
            pass
        elif not aqara_ok and not autostate.get("_aqara_down"):
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
                if control_room(room, readings, H, autostate, actions, emerg, away, target):
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
