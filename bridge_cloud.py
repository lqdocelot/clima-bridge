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

import requests
from aqara_iot import AqaraOpenAPI, AqaraDeviceManager

TZ_ROME = ZoneInfo("Europe/Rome")  # ora locale italiana, esplicita (il runner GitHub è UTC)


def now_it():
    return datetime.now(TZ_ROME)

DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"

# ---- Comfort (tarabili anche da env) ----
BASE_TARGET = float(os.environ.get("TARGET", "25.0"))
DEADZONE = 0.3
STEP = 0.5
SETPOINT_MIN, SETPOINT_MAX = 20.0, 29.0
MAX_DELTA = float(os.environ.get("MAX_DELTA", "6.0"))
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
ROOMS = [
    {"name": "SOGGIORNO", "dsn": "AC000W002919142", "sensor": "lumi.158d008afda8d2"},
    # CAMERA = cameretta di Eva: 22:00-08:00 deve stare SPENTO (lei dorme).
    {"name": "CAMERA",    "dsn": "AC000W002919128", "sensor": "lumi.158d0008974abd", "quiet": (22, 8)},
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
    """'home' | 'away'. Default 'home' se non configurato; 'away' (sicuro) se errore."""
    if not PRESENCE_URL:
        return "home"
    try:
        txt = requests.get(PRESENCE_URL, timeout=10).text.strip().lower()
        if "away" in txt or "fuori" in txt:
            return "away"
        if "home" in txt or "casa" in txt:
            return "home"
    except Exception:
        pass
    return "away"


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


def main():
    actions = []
    print(f"== Ponte CLOUD @ {now_it():%H:%M} IT (DRY_RUN={DRY_RUN}) ==")
    try:
        presence = read_presence()
        out = outdoor_temp()
        target = BASE_TARGET if out is None else max(BASE_TARGET, out - MAX_DELTA)
        print(f"Presenza: {presence} | esterno: {out}°C | target: {target:.1f}°C")

        readings = aqara_readings()
        print("Aqara:", {k[-6:]: f"{v['temp']:.1f}°C/{v['hum']:.0f}%" if v['hum'] else f"{v['temp']:.1f}°C" for k, v in readings.items()})
        H = fg_login()

        for room in ROOMS:
            r = readings.get(room["sensor"])
            if not r:
                print(f"[{room['name']}] sensore non letto, salto."); continue
            temp = r["temp"]
            p = fg_props(H, room["dsn"])
            cur_mode = p["operation_mode"]["value"]
            cur_sp = p["adjust_temperature"]["value"] / 10
            print(f"\n[{room['name']}] reale={temp:.1f}°C | clima: {MODE.get(cur_mode)} @ {cur_sp:.1f}°C")

            # Fascia notturna per-stanza (cameretta Eva 22-8): DEVE stare spento
            q = room.get("quiet")
            if q:
                h = now_it().hour
                qs, qe = q
                in_quiet = (qs <= h or h < qe) if qs > qe else (qs <= h < qe)
                if in_quiet:
                    if cur_mode != 0:
                        print(f"   fascia notturna {qs}-{qe} → spengo")
                        if not DRY_RUN:
                            fg_set(H, p["operation_mode"]["key"], 0)
                        actions.append(f"{room['name']}: notte (dopo le {qs}) → spento")
                    else:
                        print(f"   fascia notturna {qs}-{qe}, già spento")
                    continue

            # CASA VUOTA -> spegni (efficienza)
            if presence == "away":
                if cur_mode != 0:
                    print("   casa vuota -> spengo")
                    if not DRY_RUN:
                        fg_set(H, p["operation_mode"]["key"], 0)
                    actions.append(f"{room['name']}: casa vuota → spento")
                else:
                    print("   casa vuota, già spento")
                continue

            # CASA ABITATA -> controllo dolce verso target
            error = temp - target
            if cur_mode != COOL:
                new_sp = round_half(target)
                reason = f"avvio cool {new_sp:.1f}°C"
            elif error > DEADZONE:
                new_sp = round_half(cur_sp - STEP); reason = f"{temp:.1f}>{target:.1f} → setpoint {new_sp:.1f}°C"
            elif error < -DEADZONE:
                new_sp = round_half(cur_sp + STEP); reason = f"{temp:.1f}<{target:.1f} → setpoint {new_sp:.1f}°C"
            else:
                print(f"   stabile a {temp:.1f}°C (nessun cambio)"); continue
            new_sp = min(SETPOINT_MAX, max(SETPOINT_MIN, new_sp))
            print(f"   {reason}")
            if not DRY_RUN:
                if cur_mode != COOL:
                    fg_set(H, p["operation_mode"]["key"], COOL)
                    fg_set(H, p["fan_speed"]["key"], FAN_QUIET)  # gentile: ventola silenziosa
                    actions.append(f"{room['name']}: acceso cool {new_sp:.1f}°C (gentile)")
                if new_sp != cur_sp:
                    fg_set(H, p["adjust_temperature"]["key"], int(new_sp * 10))
            elif cur_mode != COOL:
                actions.append(f"{room['name']}: [DRY] accenderei cool {new_sp:.1f}°C")

        if actions:
            notify("🌡️ " + ("[PROVA] " if DRY_RUN else "") + " | ".join(actions))
        print("\nFine ciclo.")
    except Exception as e:
        notify(f"⚠️ Ponte clima ERRORE: {e}")
        raise


if __name__ == "__main__":
    main()
