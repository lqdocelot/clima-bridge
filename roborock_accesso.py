# -*- coding: utf-8 -*-
"""Accesso all'account Roborock per la bacheca del frigo (scheda Robot).

Lo lancia Alessandro nel Terminale:
    ~/clima-bridge/.venv-roborock/bin/python ~/clima-bridge/deploy/roborock_accesso.py

Chiede l'email dell'account Roborock, Roborock manda un codice per email, lo si scrive qui.
Il testo da incollare su val.town (variabile ROBOROCK del progetto «Clima») finisce negli appunti del Mac:
non viene stampato né salvato su disco. Stampa solo un riassunto senza segreti (modello, stanze, routine).
Spec: bacheca-frigo docs/superpowers/specs/2026-11-08-scheda-robot-design.md.
"""
import asyncio
import json
import subprocess

from roborock.web_api import RoborockApiClient


async def main():
    email = input("Email dell'account Roborock: ").strip()
    api = RoborockApiClient(username=email)
    await api.request_code_v4()
    codice = input("Codice ricevuto per email: ").strip()
    utente = await api.code_login_v4(codice)
    casa = await api.get_home_data_v3(utente)

    modelli = {p.id: p for p in casa.products}
    robot = [d for d in casa.get_all_devices() if "vacuum" in (modelli.get(d.product_id).model if d.product_id in modelli else "")]
    if not robot:
        print("Nessun robot aspirapolvere su questo account.")
        return
    if len(robot) > 1:
        for i, d in enumerate(robot, 1):
            print(f"{i}. {d.name} ({modelli[d.product_id].model})")
        d = robot[int(input("Quale robot? ")) - 1]
    else:
        d = robot[0]
    modello = modelli[d.product_id].model

    r = utente.rriot
    dati = {
        "rriot": {"u": r.u, "s": r.s, "h": r.h, "k": r.k, "r": {"a": r.r.a, "m": r.r.m}},
        "duid": d.duid, "localKey": d.local_key, "homeId": casa.id, "modello": modello,
    }
    subprocess.run(["pbcopy"], input=json.dumps(dati, separators=(",", ":")).encode(), check=True)

    routine = await api.get_scenes(utente, d.duid)
    print()
    print(f"Robot: {d.name}, modello {modello}, protocollo {d.pv}, in linea: {d.online}")
    print(f"Server MQTT: {r.r.m}")
    print("Stanze della casa:", ", ".join(s.name for s in casa.rooms) or "nessuna")
    print("Routine:", ", ".join(s.name for s in routine) or "nessuna")
    if d.pv and d.pv != "1.0":
        print(f"ATTENZIONE: protocollo {d.pv}, la bacheca parla solo il 1.0: dillo a Claude prima di incollare.")
    print()
    print("Fatto: il testo per val.town e' negli appunti.")
    print("Incollalo su val.town, progetto Clima > Env vars, come valore di una variabile chiamata ROBOROCK.")


if __name__ == "__main__":
    asyncio.run(main())
