#!/bin/sh
# ▶️ Comfort: riprende l'automatico (comfort_reset.py) e lo salva nel repo. Se intanto il ponte ha salvato
# il suo stato, il push viene rifiutato: si riparte da origin/main e si riapplica il reset sullo stato
# nuovo (prima il ciclo finiva con "sleep 4" e il job risultava verde anche se il reset si era perso).
# Uso: sh comfort_salva.sh [dsn]. Esce con errore se dopo 3 tentativi il push non riesce.
DSN=${1:-}
for i in 1 2 3; do
  python3 comfort_reset.py "$DSN" || exit 1
  git add emergency.json autostate.json
  git commit -q -m "comfort: riprendi automatico${DSN:+ ($DSN)}" || echo "nessun cambiamento"
  git push -q origin HEAD:main && exit 0
  echo "push rifiutato (tentativo $i): riparto da origin/main e riapplico"
  sleep 2
  git fetch -q origin main && git reset -q --hard origin/main
done
echo "comfort NON salvato dopo 3 tentativi" >&2
exit 1
