// Orologio della bacheca del frigo (cron di val.town, ogni ora al minuto 5).
// Il programmatore di GitHub Actions salta o ritarda i lanci orari: da qui si chiede
// a GitHub di rigenerare le pagine (workflow genera.yml del repo lqdocelot/bacheca-frigo).
const GH_PAT = Deno.env.get("GH_PAT") || "";
const URL = "https://api.github.com/repos/lqdocelot/bacheca-frigo/actions/workflows/genera.yml/dispatches";

export default async function () {
  // anche di notte: col tasto il Kindle si sveglia a qualsiasi ora e deve trovare la pagina del giorno giusto
  const ora = Number(
    new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" })
      .format(new Date()),
  );
  const r = await fetch(URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GH_PAT,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  console.log("bacheca: ora", ora, "dispatch", r.status);
  if (r.status >= 300) throw new Error(`dispatch ${r.status}: ${await r.text()}`);
}
