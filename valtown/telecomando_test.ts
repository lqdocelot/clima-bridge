// Test del telecomando della bacheca (deno test valtown/). Nessuna chiamata vera: FGLair e GitHub finti.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crea, rigaStato } from "./telecomando.ts";
import { COOL, DRY, HEAT, OFF } from "./fglair.ts";

const SOG = "AC000W002919142", EVA = "AC000W002919128";
const ADESSO = new Date("2026-11-08T15:20:00Z"); // 16:20 in Italia

type Clima = { mode: number; sp: number; disp?: number };
function finto(op: {
  climi?: Record<string, Clima>;
  autostate?: unknown;
  emergency?: unknown;
  sensors?: unknown;
  loginRotto?: boolean;
  propsRotte?: string[];
  propsLente?: string[];
  limite?: number;
} = {}) {
  const climi: Record<string, Clima> = op.climi ?? {
    [SOG]: { mode: HEAT, sp: 240 },
    [EVA]: { mode: OFF, sp: 190 },
  };
  const scritti: [string, string, number][] = [];
  const comfort: string[] = [];
  let chiamateFg = 0;
  const nomi = ["operation_mode", "adjust_temperature", "fan_speed", "af_vertical_swing", "af_vertical_direction", "display_temperature"];
  const gestore = crea({
    chiave: "segreta",
    caldo: 24,
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
    set: (_tok, key, value) => {
      chiamateFg++;
      scritti.push([key >= 200 ? "eva" : "soggiorno", nomi[key % 100], value]);
      return Promise.resolve();
    },
    comfort: (dsn) => {
      comfort.push(dsn);
      return Promise.resolve();
    },
    json: (nome) =>
      Promise.resolve(({
        sensors: op.sensors ?? { rooms: [{ name: "🛋️ Soggiorno", t: 21.7, h: 67 }, { name: "🧸 Cameretta EVA", t: 20.3, h: 68 }] },
        autostate: op.autostate ?? { [SOG]: { mode: HEAT, sp: 240, manual: false }, [EVA]: { mode: OFF, sp: 190, manual: true } },
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
  return { chiedi, scritti, comfort, chiamate: () => chiamateFg };
}

Deno.test("chiave sbagliata o assente: 403 e nessun comando", async () => {
  const f = finto();
  assertEquals((await f.chiedi("azione=comando&c=soggiorno_spento", "altra")).stato, 403);
  assertEquals((await f.chiedi("azione=stato", "")).stato, 403);
  assertEquals(f.chiamate(), 0);
});

Deno.test("stato: modo, setpoint, stanza, auto/manuale", async () => {
  const { stato, righe } = await finto().chiedi("azione=stato");
  assertEquals(stato, 200);
  assertEquals(righe.soggiorno, "caldo 24.0  stanza 21.7  auto");
  assertEquals(righe.eva, "spento  stanza 20.3  manuale");
  assertEquals(righe.esito, "");
});

Deno.test("caldo: HEAT a 24, ventola minima, alette in alto; riga in attesa", async () => {
  const f = finto({ climi: { [SOG]: { mode: OFF, sp: 200 }, [EVA]: { mode: OFF, sp: 190 } } });
  const { righe } = await f.chiedi("azione=comando&c=soggiorno_caldo");
  assertEquals(f.scritti.sort(), [
    ["soggiorno", "adjust_temperature", 240], ["soggiorno", "af_vertical_direction", 1],
    ["soggiorno", "af_vertical_swing", 0], ["soggiorno", "fan_speed", 0], ["soggiorno", "operation_mode", HEAT],
  ].sort());
  assertEquals(righe.esito, "ok: Soggiorno caldo 24.0 16:20");
  assertEquals(righe.soggiorno, "caldo 24.0  stanza 21.7  attesa");
});

Deno.test("spento", async () => {
  const f = finto({ climi: { [SOG]: { mode: HEAT, sp: 240 }, [EVA]: { mode: HEAT, sp: 240 } } });
  const { righe } = await f.chiedi("azione=comando&c=eva_spento");
  assertEquals(f.scritti, [["eva", "operation_mode", OFF]]);
  assertEquals(righe.esito, "ok: Eva spento 16:20");
  assertEquals(righe.eva, "spento  stanza 20.3  attesa");
});

Deno.test("piu e meno di mezzo grado, dentro 17-30", async () => {
  let f = finto();
  let r = await f.chiedi("azione=comando&c=soggiorno_piu");
  assertEquals(f.scritti, [["soggiorno", "adjust_temperature", 245]]);
  assertEquals(r.righe.esito, "ok: Soggiorno 24.5 16:20");
  f = finto({ climi: { [SOG]: { mode: COOL, sp: 300 }, [EVA]: { mode: HEAT, sp: 170 } } });
  await f.chiedi("azione=comando&c=soggiorno_piu");
  await f.chiedi("azione=comando&c=eva_meno");
  assertEquals(f.scritti, []);                       // già al limite: niente da scrivere
  r = await f.chiedi("azione=comando&c=soggiorno_meno");
  assertEquals(r.righe.esito, "ok: Soggiorno 29.5 16:20");
});

Deno.test("piu e meno rifiutati a clima spento o in deumidificazione", async () => {
  const f = finto({ climi: { [SOG]: { mode: DRY, sp: 240 }, [EVA]: { mode: OFF, sp: 190 } } });
  assertEquals((await f.chiedi("azione=comando&c=eva_meno")).righe.esito, "Eva spento: premi Caldo");
  assertEquals((await f.chiedi("azione=comando&c=soggiorno_piu")).righe.esito, "Soggiorno in deumid: premi Caldo");
  assertEquals(f.scritti, []);
});

Deno.test("comfort di una stanza e di tutta la casa: comfort.yml, righe in attesa", async () => {
  const f = finto();
  let r = await f.chiedi("azione=comando&c=eva_comfort");
  assertEquals(f.comfort, [EVA]);
  assertEquals(r.righe.esito, "ok: Eva al ponte");
  assertEquals(r.righe.eva, "spento  stanza 20.3  attesa");
  r = await f.chiedi("azione=comando&c=tutto_comfort");
  assertEquals(f.comfort, [EVA, ""]);
  assertEquals(r.righe.esito, "ok: tutto al ponte");
  assert(r.righe.soggiorno.endsWith("attesa") && r.righe.eva.endsWith("attesa"));
  assertEquals(f.scritti, []);
});

Deno.test("tutto spento", async () => {
  const f = finto({ climi: { [SOG]: { mode: HEAT, sp: 240 }, [EVA]: { mode: HEAT, sp: 240 } } });
  const { righe } = await f.chiedi("azione=comando&c=tutto_spento");
  assertEquals(f.scritti.sort(), [["eva", "operation_mode", OFF], ["soggiorno", "operation_mode", OFF]]);
  assertEquals(righe.esito, "ok: tutto spento 16:20");
});

Deno.test("emergenza attiva: comandi di stanza rifiutati, Tutto Comfort e Tutto spento sì", async () => {
  const until = ADESSO.getTime() / 1000 + 3600; // 17:20
  const f = finto({ emergency: { mode: "off", until } });
  assertEquals((await f.chiedi("azione=stato")).righe.esito, "emergenza fino 17:20");
  assertEquals((await f.chiedi("azione=comando&c=soggiorno_caldo")).righe.esito, "emergenza: usa Tutto Comfort");
  assertEquals((await f.chiedi("azione=comando&c=eva_comfort")).righe.esito, "emergenza: usa Tutto Comfort");
  assertEquals(f.scritti, []);
  assertEquals((await f.chiedi("azione=comando&c=tutto_comfort")).righe.esito, "ok: tutto al ponte");
  assertEquals((await f.chiedi("azione=comando&c=tutto_spento")).righe.esito, "ok: tutto spento 16:20");
});

Deno.test("comando sconosciuto: 400", async () => {
  const r = await finto().chiedi("azione=comando&c=balla");
  assertEquals(r.stato, 400);
  assertEquals(r.righe.esito, "comando sconosciuto");
});

Deno.test("un clima che non risponde non blocca l'altro", async () => {
  const f = finto({ propsRotte: [EVA] });
  let r = await f.chiedi("azione=stato");
  assertEquals(r.righe.eva, "non risponde");
  assertEquals(r.righe.soggiorno, "caldo 24.0  stanza 21.7  auto");
  r = await f.chiedi("azione=comando&c=eva_spento");
  assertEquals(r.righe.esito, "Eva non risponde");
});

Deno.test("FGLair giù: righe non risponde, il Comfort funziona lo stesso", async () => {
  const f = finto({ loginRotto: true });
  let r = await f.chiedi("azione=stato");
  assertEquals([r.righe.soggiorno, r.righe.eva], ["non risponde", "non risponde"]);
  r = await f.chiedi("azione=comando&c=tutto_comfort");
  assertEquals(r.righe.esito, "ok: tutto al ponte");
  r = await f.chiedi("azione=comando&c=soggiorno_caldo");
  assertEquals(r.righe.esito, "Soggiorno non risponde");
});

Deno.test("clima lento: risposta entro il limite", async () => {
  const f = finto({ propsLente: [SOG], limite: 150 });
  const t0 = Date.now();
  const r = await f.chiedi("azione=stato");
  assert(Date.now() - t0 < 1000);
  assertEquals(r.righe.soggiorno, "non risponde");
  assertEquals(r.righe.eva, "spento  stanza 20.3  manuale");
});

Deno.test("temperatura della stanza: sensore, altrimenti clima, altrimenti --", async () => {
  const f = finto({
    sensors: { rooms: [] },
    climi: { [SOG]: { mode: HEAT, sp: 240, disp: 7110 }, [EVA]: { mode: OFF, sp: 190 } },
  });
  const { righe } = await f.chiedi("azione=stato");
  assertEquals(righe.soggiorno, "caldo 24.0  stanza 21.1  auto");
  assertEquals(righe.eva, "spento  stanza --  manuale");
});

Deno.test("senza voce in autostate (dopo un Comfort): attesa", async () => {
  const { righe } = await finto({ autostate: { _season: "inverno" } }).chiedi("azione=stato");
  assert(righe.soggiorno.endsWith("attesa") && righe.eva.endsWith("attesa"));
});

Deno.test("righe sempre ASCII, senza apostrofo, al massimo 34 caratteri", () => {
  for (const mode of [0, 2, 3, 4, 5, 6, 9]) {
    for (const ultima of ["auto", "manuale", "attesa"]) {
      const r = rigaStato({ mode, sp: 23.5, temp: 21.7, ultima });
      assert(r.length <= 34 && /^[\x20-\x7e]*$/.test(r) && !r.includes("'"), r);
    }
  }
});
