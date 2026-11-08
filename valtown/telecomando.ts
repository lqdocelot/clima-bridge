// Telecomando della bacheca del frigo (Kindle): stato e comandi dei due condizionatori.
//   GET  ?azione=stato               -> righe "chiave<TAB>testo" (esito, soggiorno, eva)
//   POST ?azione=comando&c=<comando>  -> esegue, poi le stesse righe aggiornate
// Intestazione obbligatoria X-Chiave = TELECOMANDO_KEY. Il Kindle scrive le righe così come sono (eips):
// solo ASCII, niente apostrofo, al massimo 34 caratteri. Progetto: bacheca-frigo,
// docs/superpowers/specs/2026-11-07-telecomando-clima-design.md §6.
// Env vars su val.town: TELECOMANDO_KEY, FGLAIR_EMAIL, FGLAIR_PASSWORD, GH_PAT, TARGET_WINTER (facoltativa, 24).
import { DRY, fgLogin, fgProps, fgSet, HEAT, OFF, type Props } from "./fglair.ts";

const REPO = "lqdocelot/clima-bridge";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const STANZE = {
  soggiorno: { nome: "Soggiorno", dsn: "AC000W002919142", sensore: "🛋️ Soggiorno" },
  eva: { nome: "Eva", dsn: "AC000W002919128", sensore: "🧸 Cameretta EVA" },
} as const;
type Stanza = keyof typeof STANZE;
const AZIONI_STANZA = ["comfort", "caldo", "spento", "meno", "piu"] as const;
const MODI: Record<number, string> = { 0: "spento", 2: "auto", 3: "freddo", 4: "deumid", 5: "ventola", 6: "caldo" };
const SP_MIN = 17, SP_MAX = 30, FAN_QUIET = 0, ALETTE_SU = 1;

export type Deps = {
  chiave: string;
  caldo: number;                 // gradi del pulsante Caldo (= TARGET_WINTER del ponte)
  limite?: number;               // ms massimi per tutta la risposta (il Kindle aspetta 20 s)
  adesso: () => Date;
  login: () => Promise<string>;
  props: (tok: string, dsn: string) => Promise<Props>;
  set: (tok: string, key: number, value: number) => Promise<void>;
  comfort: (dsn: string) => Promise<void>;          // comfort.yml: dsn vuoto = tutte le stanze
  json: (nome: "sensors" | "autostate" | "emergency") => Promise<unknown>;
};

const ascii = (s: string) => s.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/'/g, " ").slice(0, 34);
const ora = (d: Date) =>
  new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(d);
const gradi = (raw: number) => (raw / 10).toFixed(1);

export function rigaStato(s: { mode: number; sp: number; temp: number | null; ultima: string }): string {
  const modo = MODI[s.mode] ?? `modo ${s.mode}`;
  const stanza = s.temp == null ? "--" : s.temp.toFixed(1);
  const sp = s.mode === OFF ? "" : ` ${s.sp.toFixed(1)}`;
  return ascii(`${modo}${sp}  stanza ${stanza}  ${s.ultima}`);
}

// Una promessa che non arriva entro il limite vale come errore: le altre righe arrivano lo stesso.
function entro<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error("tempo scaduto")), ms))]);
}
const oppureNull = <T>(p: Promise<T>) => p.catch(() => null);

export function crea(d: Deps) {
  const limite = d.limite ?? 12000;
  return async (req: Request): Promise<Response> => {
    if (!d.chiave || req.headers.get("X-Chiave") !== d.chiave) return new Response("no", { status: 403 });
    const url = new URL(req.url);
    const azione = url.searchParams.get("azione") ?? "stato";
    const comando = azione === "comando" ? url.searchParams.get("c") ?? "" : "";
    const [chi, cosa] = comando.split("_") as [string, string];
    const valido = comando === "tutto_comfort" || comando === "tutto_spento" ||
      (chi in STANZE && (AZIONI_STANZA as readonly string[]).includes(cosa));
    if (azione === "comando" && !valido) return risposta({ esito: "comando sconosciuto" }, 400);

    // letture in parallelo, ognuna col suo limite
    const scadenza = Math.max(50, limite - 1000);
    const tok = oppureNull(entro(d.login(), scadenza));
    const props = Object.fromEntries((Object.keys(STANZE) as Stanza[]).map((k) => [
      k, tok.then((t) => t ? oppureNull(entro(d.props(t, STANZE[k].dsn), scadenza)) : null),
    ])) as Record<Stanza, Promise<Props | null>>;
    const [sensors, autostate, emergency] = await Promise.all(
      (["sensors", "autostate", "emergency"] as const).map((n) => oppureNull(entro(d.json(n), scadenza))),
    ) as [any, any, any];
    const p: Record<Stanza, Props | null> = { soggiorno: await props.soggiorno, eva: await props.eva };
    const t = await tok;

    const em = emergency && ["off", "safe"].includes(emergency.mode) && Number(emergency.until) * 1000 > d.adesso().getTime()
      ? ora(new Date(Number(emergency.until) * 1000)) : null;
    const scritto: Partial<Record<Stanza, { mode: number; sp: number }>> = {};
    const attesa = new Set<Stanza>();
    let esito = em ? `emergenza fino ${em}` : "";

    const scrivi = async (k: Stanza, valori: [string, number][]) => {
      const pk = p[k]!;
      await Promise.all(valori.filter(([n]) => pk[n]).map(([n, v]) => entro(d.set(t!, pk[n].key, v), scadenza)));
      scritto[k] = {
        mode: valori.find(([n]) => n === "operation_mode")?.[1] ?? pk.operation_mode.value,
        sp: valori.find(([n]) => n === "adjust_temperature")?.[1] ?? pk.adjust_temperature.value,
      };
      attesa.add(k);
    };

    try {
      if (comando === "tutto_comfort") {
        await entro(d.comfort(""), scadenza);
        (Object.keys(STANZE) as Stanza[]).forEach((k) => attesa.add(k));
        esito = "ok: tutto al ponte";
      } else if (comando === "tutto_spento") {
        const vivi = (Object.keys(STANZE) as Stanza[]).filter((k) => p[k]);
        await Promise.all(vivi.map((k) => scrivi(k, [["operation_mode", OFF]])));
        esito = vivi.length === 2 ? `ok: tutto spento ${ora(d.adesso())}` : "un clima non risponde";
      } else if (comando) {
        const k = chi as Stanza, nome = STANZE[k].nome;
        if (em) {
          esito = "emergenza: usa Tutto Comfort";      // il ponte annullerebbe il comando
        } else if (cosa === "comfort") {
          await entro(d.comfort(STANZE[k].dsn), scadenza);
          attesa.add(k);
          esito = `ok: ${nome} al ponte`;
        } else if (!p[k] || !t) {
          esito = `${nome} non risponde`;
        } else if (cosa === "caldo") {
          const sp = Math.round(d.caldo * 10);
          await scrivi(k, [["operation_mode", HEAT], ["adjust_temperature", sp], ["fan_speed", FAN_QUIET],
            ["af_vertical_swing", 0], ["af_vertical_direction", ALETTE_SU]]);
          esito = `ok: ${nome} caldo ${gradi(sp)} ${ora(d.adesso())}`;
        } else if (cosa === "spento") {
          await scrivi(k, [["operation_mode", OFF]]);
          esito = `ok: ${nome} spento ${ora(d.adesso())}`;
        } else {
          const mode = p[k]!.operation_mode.value;
          if (mode === OFF || mode === DRY) {
            esito = `${nome} ${mode === OFF ? "spento" : "in deumid"}: premi Caldo`;
          } else {
            const sp0 = p[k]!.adjust_temperature.value;
            const sp = Math.min(SP_MAX * 10, Math.max(SP_MIN * 10, sp0 + (cosa === "piu" ? 5 : -5)));
            if (sp !== sp0) await scrivi(k, [["adjust_temperature", sp]]);
            else attesa.add(k);
            esito = `ok: ${nome} ${gradi(sp)} ${ora(d.adesso())}`;
          }
        }
      }
    } catch (_e) {
      esito = "comando non riuscito, riprova";
    }

    const righe: Record<string, string> = { esito };
    for (const k of Object.keys(STANZE) as Stanza[]) {
      const pk = p[k];
      if (!pk) {
        righe[k] = "non risponde";
        continue;
      }
      const s = (sensors?.rooms ?? []).find((r: any) => r?.name === STANZE[k].sensore);
      const disp = pk.display_temperature?.value;
      const temp = typeof s?.t === "number" ? s.t : disp ? (disp - 5000) / 100 : null;
      const voce = autostate?.[STANZE[k].dsn];
      const ultima = attesa.has(k) ? "attesa" : !voce ? "attesa" : voce.manual ? "manuale" : "auto";
      const v = scritto[k] ?? { mode: pk.operation_mode.value, sp: pk.adjust_temperature.value };
      righe[k] = rigaStato({ mode: v.mode, sp: v.sp / 10, temp, ultima });
    }
    return risposta(righe, 200);
  };
}

function risposta(righe: Record<string, string>, status: number) {
  const testo = Object.entries(righe).map(([k, v]) => `${k}\t${ascii(v)}`).join("\n") + "\n";
  return new Response(testo, { status, headers: { "Content-Type": "text/plain; charset=us-ascii" } });
}

// ---------------------------------------------------------------- val.town
const env = (n: string) => (globalThis as any).Deno?.env.get(n) ?? "";
const GH_PAT = env("GH_PAT");

export default crea({
  chiave: env("TELECOMANDO_KEY"),
  caldo: Number(env("TARGET_WINTER") || 24),
  adesso: () => new Date(),
  login: () => fgLogin(env("FGLAIR_EMAIL"), env("FGLAIR_PASSWORD")),
  props: (tok, dsn) => fgProps(tok, dsn),
  set: (tok, key, value) => fgSet(tok, key, value),
  comfort: async (dsn) => {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/comfort.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: "Bearer " + GH_PAT, Accept: "application/vnd.github+json" },
      body: JSON.stringify(dsn ? { ref: "main", inputs: { dsn } } : { ref: "main" }),
      signal: AbortSignal.timeout(4000),
    });
    if (r.status >= 300) throw new Error(`comfort.yml ${r.status}`);
  },
  json: async (nome) =>
    (await fetch(`${RAW}${nome}.json?t=${Date.now()}`, { signal: AbortSignal.timeout(4000) })).json(),
});
