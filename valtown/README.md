# Codice del progetto val.town «Clima»

Copia versionata dei file del progetto https://www.val.town/x/lqdocelot/Clima (pubblico anche lì).
Nessun segreto nel codice: tutto arriva dalle variabili d'ambiente del progetto su val.town.

- `main.ts` — bot Telegram a bottoni (webhook HTTP)
- `bacheca_orologio.ts` — cron orario che fa rigenerare la bacheca del frigo
- `telecomando.ts` + `fglair.ts` — telecomando della pagina Clima del Kindle (HTTP, intestazione `X-Chiave`)
- `telecomando_test.ts` — test: `deno test --allow-env valtown/`
