#!/usr/bin/env python3
"""▶️ Comfort = "riprendi automatico" (chiamato da comfort.yml tramite comfort_salva.sh).

Senza argomento azzera l'emergenza e gli override di TUTTE le stanze; con un dsn riprende l'automatico
per UNA sola stanza (emergenza e altre stanze restano). Lavora su autostate.json ed emergency.json nella
cartella corrente. Uso: python3 comfort_reset.py [dsn]
"""
import json
import sys


def riprendi(autostate, dsn=""):
    # RIMUOVE le entry per-stanza (non basta manual=False): se restasse memorizzato il
    # vecchio stato, al giro dopo il ponte lo troverebbe diverso dal clima reale e si
    # ri-bloccherebbe da solo con un falso "cambio manuale". Ripartire da zero = pulito.
    return {k: v for k, v in autostate.items() if k.startswith("_") or (dsn and k != dsn)}


def main(argv):
    dsn = (argv[1] if len(argv) > 1 else "").strip()
    if not dsn:
        json.dump({"mode": "none", "until": 0}, open("emergency.json", "w"))
    try:
        a = json.load(open("autostate.json"))
    except Exception:
        a = {}
    a = riprendi(a, dsn)
    json.dump(a, open("autostate.json", "w"))
    print("comfort:", f"stanza {dsn}" if dsn else "tutte le stanze, emergenza azzerata", "->", a)


if __name__ == "__main__":
    main(sys.argv)
