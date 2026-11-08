// Test del telecomando della bacheca (deno test --allow-env valtown/). Nessuna chiamata vera: FGLair finto.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crea, rigaStato } from "./telecomando.ts";
import { COOL, DRY, FAN, HEAT, OFF } from "./fglair.ts";

const SOG = "AC000W002919142", EVA = "AC000W002919128";
const ADESSO = new Date("2026-11-08T15:20:00Z"); // 16:20 in Italia
const AVVIO = ["operation_mode", "adjust_temperature", "fan_speed", "af_vertical_swing", "af_vertical_direction"];

type Clima = { mode: number; sp: number; disp?: number };
function finto(op: {
  climi?: Record<string, Clima>;
  emergency?: unknown;
  sensors?: unknown;
  loginRotto?: boolean;
  propsRotte?: string[];
  propsLente?: string[];
  limite?: number;
  setLento?: number;
  setRotto?: boolean;
} = {}) {
  const climi: Record<string, Clima> = op.climi ?? {
    [SOG]: { mode: HEAT, sp: 240 },
    [EVA]: { mode: OFF, sp: 190 },
  };
  const scritti: [string, string, number][] = [];
  let chiamateFg = 0, inVolo = 0, massimo = 0;
  const nomi = ["operation_mode", "adjust_temperature", "fan_speed", "af_vertical_swing", "af_vertical_direction", "display_temperature"];
  const gestore = crea({
    chiave: "segreta",
    caldo: 24,
    freddo: 24,
    limite: op.limite ?? 2000,
    adesso: () => ADESSO,
    login: () => {
      chiamateFg++;
      return op.loginRotto ? Promise.reject(new Error("giù")) : Promise.resolve("tok");
    },
    props: (_tok, dsn) => {
      chiamateFg++;
      if (op.propsRotte?.includes(dsn)) return Promise.reject(new Error("giù"));
      if (op.propsLente?.includes(dsn)) return new Promise(() => {});
      const c = climi[dsn];
      const v: Record<string, number> = {
        operation_mode: c.mode, adjust_temperature: c.sp, fan_speed: 4,
        af_vertical_swing: 1, af_vertical_direction: 4, display_temperature: c.disp ?? 0,
      };
      return Promise.resolve(Object.fromEntries(nomi.map((n, i) => [n, { key: i + (dsn === SOG ? 100 : 200), value: v[n] }])));
    },
    set: async (_tok, key, value) => {
      chiamateFg++;
      if (op.setRotto) throw new Error("FGLair 500");
      inVolo++;
      massimo = Math.max(massimo, inVolo);
      if (op.setLento) await new Promise((r) => setTimeout(r, op.setLento));
      inVolo--;
      scritti.push([key >= 200 ? "eva" : "soggiorno", nomi[key % 100], value]);
    },
    json: (nome) =>
      Promise.resolve(({
        sensors: op.sensors ?? { rooms: [{ name: "🛋️ Soggiorno", t: 21.7, h: 67 }, { name: "🧸 Cameretta EVA", t: 20.3, h: 68 }] },
        emergency: op.emergency ?? { mode: "none", until: 0 },
      } as Record<string, unknown>)[nome]),
  });
  const chiedi = async (q: string, chiave = "segreta") => {
    const r = await gestore(new Request(`https://x/?${q}`, {
      method: q.includes("comando") ? "POST" : "GET",
      headers: { "X-Chiave": chiave },
    }));
    const testo = await r.text();
    const righe = Object.fromEntries(testo.trim().split("\n").filter(Boolean).map((l) => l.split("\t")));
    return { stato: r.status, righe, testo };
  };
  return { chiedi, scritti, chiamate: () => chiamateFg, massimoInsieme: () => massimo };
}
const di = (f: ReturnType<typeof finto>, stanza: string) => f.scritti.filter((s) => s[0] === stanza);

Deno.test("chiave sbagliata o assente: 403 e nessun comando", async () => {
  const f = finto();
  assertEquals((await f.chiedi("azione=comando&c=soggiorno_spento", "altra")).stato, 403);
  assertEquals((await f.chiedi("azione=stato", "")).stato, 403);
  assertEquals(f.chiamate(), 0);
});

Deno.test("stato: modo, setpoint e stanza (niente auto/manuale)", async () => {
  const { stato, righe } = await finto().chiedi("azione=stato");
  assertEquals(stato, 200);
  assertEquals(righe.soggiorno, "caldo 24.0  stanza 21.7");
  assertEquals(righe.eva, "spento  stanza 20.3");
  assertEquals(righe.esito, "");
});

Deno.test("caldo e freddo partono a 24, ventola minima, alette tutte in alto, una impostazione alla volta", async () => {
  const f = finto({ climi: { [SOG]: { mode: OFF, sp: 200 }, [EVA]: { mode: OFF, sp: 190 } }, setLento: 10 });
  let r = await f.chiedi("azione=comando&c=soggiorno_caldo");
  assertEquals(di(f, "soggiorno"), [["soggiorno", "operation_mode", HEAT], ["soggiorno", "adjust_temperature", 240],
    ["soggiorno", "fan_speed", 0], ["soggiorno", "af_vertical_swing", 0], ["soggiorno", "af_vertical_direction", 1]]);
  assertEquals(r.righe.esito, "ok: Soggiorno caldo 24.0 16:20");
  assertEquals(r.righe.soggiorno, "caldo 24.0  stanza 21.7");
  r = await f.chiedi("azione=comando&c=eva_freddo");
  assertEquals(di(f, "eva").map((s) => s[2]), [COOL, 240, 0, 0, 1]);
  assertEquals(r.righe.esito, "ok: Eva freddo 24.0 16:20");
  assertEquals(r.righe.eva, "freddo 24.0  stanza 20.3");
  assertEquals(f.massimoInsieme(), 1);
});

Deno.test("deumidificatore e ventola (ventola al minimo)", async () => {
  const f = finto();
  let r = await f.chiedi("azione=comando&c=soggiorno_deumid");
  assertEquals(f.scritti, [["soggiorno", "operation_mode", DRY]]);
  assertEquals(r.righe.esito, "ok: Soggiorno deumid 16:20");
  assertEquals(r.righe.soggiorno, "deumid  stanza 21.7");
  r = await f.chiedi("azione=comando&c=eva_ventola");
  assertEquals(di(f, "eva"), [["eva", "operation_mode", FAN], ["eva", "fan_speed", 0]]);
  assertEquals(r.righe.esito, "ok: Eva ventola 16:20");
  assertEquals(r.righe.eva, "ventola  stanza 20.3");
});

Deno.test("spento", async () => {
  const f = finto({ climi: { [SOG]: { mode: HEAT, sp: 240 }, [EVA]: { mode: HEAT, sp: 240 } } });
  const { righe } = await f.chiedi("azione=comando&c=eva_spento");
  assertEquals(f.scritti, [["eva", "operation_mode", OFF]]);
  assertEquals(righe.esito, "ok: Eva spento 16:20");
  assertEquals(righe.eva, "spento  stanza 20.3");
});

Deno.test("piu e meno di mezzo grado in caldo o freddo, dentro 17-30", async () => {
  let f = finto();
  let r = await f.chiedi("azione=comando&c=soggiorno_piu");
  assertEquals(f.scritti, [["soggiorno", "adjust_temperature", 245]]);
  assertEquals(r.righe.esito, "ok: Soggiorno 24.5 16:20");
  f = finto({ climi: { [SOG]: { mode: COOL, sp: 300 }, [EVA]: { mode: HEAT, sp: 170 } } });
  await f.chiedi("azione=comando&c=soggiorno_piu");
  await f.chiedi("azione=comando&c=eva_meno");
  assertEquals(f.scritti, []); // già al limite: niente da scrivere
  r = await f.chiedi("azione=comando&c=soggiorno_meno");
  assertEquals(r.righe.esito, "ok: Soggiorno 29.5 16:20");
});

Deno.test("piu e meno rifiutati se il clima non è in caldo o freddo", async () => {
  for (const mode of [OFF, DRY, FAN]) {
    const f = finto({ climi: { [SOG]: { mode, sp: 240 }, [EVA]: { mode, sp: 190 } } });
    assertEquals((await f.chiedi("azione=comando&c=soggiorno_piu")).righe.esito, "Soggiorno: prima Caldo o Freddo");
    assertEquals((await f.chiedi("azione=comando&c=eva_meno")).righe.esito, "Eva: prima Caldo o Freddo");
    assertEquals(f.scritti, []);
  }
});

Deno.test("tutto caldo, tutto freddo, tutto spento", async () => {
  let f = finto({ climi: { [SOG]: { mode: OFF, sp: 200 }, [EVA]: { mode: COOL, sp: 260 } } });
  let r = await f.chiedi("azione=comando&c=tutto_caldo");
  assertEquals(di(f, "soggiorno").map((s) => s[1]), AVVIO);
  assertEquals(di(f, "eva").map((s) => s[2]), [HEAT, 240, 0, 0, 1]);
  assertEquals(r.righe.esito, "ok: tutto caldo 24.0 16:20");
  assertEquals([r.righe.soggiorno, r.righe.eva], ["caldo 24.0  stanza 21.7", "caldo 24.0  stanza 20.3"]);
  f = finto();
  r = await f.chiedi("azione=comando&c=tutto_freddo");
  assertEquals(di(f, "eva").map((s) => s[2]), [COOL, 240, 0, 0, 1]);
  assertEquals(r.righe.esito, "ok: tutto freddo 24.0 16:20");
  f = finto({ climi: { [SOG]: { mode: HEAT, sp: 240 }, [EVA]: { mode: HEAT, sp: 240 } } });
  r = await f.chiedi("azione=comando&c=tutto_spento");
  assertEquals(f.scritti.sort(), [["eva", "operation_mode", OFF], ["soggiorno", "operation_mode", OFF]]);
  assertEquals(r.righe.esito, "ok: tutto spento 16:20");
});

Deno.test("una scrittura rifiutata: esito di errore, niente ok falso", async () => {
  const f = finto({ climi: { [SOG]: { mode: OFF, sp: 200 }, [EVA]: { mode: OFF, sp: 190 } }, setRotto: true });
  assertEquals((await f.chiedi("azione=comando&c=soggiorno_caldo")).righe.esito, "comando non riuscito, riprova");
});

Deno.test("emergenza attiva: si annulla dal bot; solo Tutto spento passa", async () => {
  const until = ADESSO.getTime() / 1000 + 3600; // 17:20
  const f = finto({ emergency: { mode: "safe", until } });
  assertEquals((await f.chiedi("azione=stato")).righe.esito, "emergenza fino 17:20");
  for (const c of ["soggiorno_caldo", "eva_spento", "tutto_caldo", "tutto_freddo"]) {
    assertEquals((await f.chiedi(`azione=comando&c=${c}`)).righe.esito, "emergenza attiva: annulla dal bot");
  }
  assertEquals(f.scritti, []);
  assertEquals((await f.chiedi("azione=comando&c=tutto_spento")).righe.esito, "ok: tutto spento 16:20");
});

Deno.test("comandi sconosciuti o tolti (Auto): 400", async () => {
  for (const c of ["balla", "soggiorno_comfort", "tutto_comfort"]) {
    const r = await finto().chiedi(`azione=comando&c=${c}`);
    assertEquals(r.stato, 400);
    assertEquals(r.righe.esito, "comando sconosciuto");
  }
});

Deno.test("un clima che non risponde non blocca l'altro", async () => {
  const f = finto({ propsRotte: [EVA] });
  let r = await f.chiedi("azione=stato");
  assertEquals(r.righe.eva, "non risponde");
  assertEquals(r.righe.soggiorno, "caldo 24.0  stanza 21.7");
  r = await f.chiedi("azione=comando&c=eva_spento");
  assertEquals(r.righe.esito, "Eva non risponde");
  r = await f.chiedi("azione=comando&c=tutto_caldo");
  assertEquals(r.righe.esito, "un clima non risponde");
  assertEquals(di(f, "soggiorno").map((s) => s[1]), AVVIO);
});

Deno.test("FGLair giù: righe non risponde", async () => {
  const f = finto({ loginRotto: true });
  let r = await f.chiedi("azione=stato");
  assertEquals([r.righe.soggiorno, r.righe.eva], ["non risponde", "non risponde"]);
  r = await f.chiedi("azione=comando&c=soggiorno_caldo");
  assertEquals(r.righe.esito, "Soggiorno non risponde");
});

Deno.test("clima lento: risposta entro il limite", async () => {
  const f = finto({ propsLente: [SOG], limite: 150 });
  const t0 = Date.now();
  const r = await f.chiedi("azione=stato");
  assert(Date.now() - t0 < 1000);
  assertEquals(r.righe.soggiorno, "non risponde");
  assertEquals(r.righe.eva, "spento  stanza 20.3");
});

Deno.test("temperatura della stanza: sensore, altrimenti clima, altrimenti --", async () => {
  const f = finto({
    sensors: { rooms: [] },
    climi: { [SOG]: { mode: HEAT, sp: 240, disp: 7110 }, [EVA]: { mode: OFF, sp: 190 } },
  });
  const { righe } = await f.chiedi("azione=stato");
  assertEquals(righe.soggiorno, "caldo 24.0  stanza 21.1");
  assertEquals(righe.eva, "spento  stanza --");
});

Deno.test("righe sempre ASCII, senza apostrofo, al massimo 34 caratteri", () => {
  for (const mode of [0, 2, 3, 4, 5, 6, 9]) {
    const r = rigaStato({ mode, sp: 23.5, temp: 21.7 });
    assert(r.length <= 34 && /^[\x20-\x7e]*$/.test(r) && !r.includes("'"), r);
  }
});
