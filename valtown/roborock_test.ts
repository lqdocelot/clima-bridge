// Test di roborock.ts (deno test --allow-env valtown/). Nessuna chiamata vera: web e broker MQTT finti.
// I vettori vengono da python-roborock 7.19 (la libreria di Home Assistant), con chiavi inventate.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type Config,
  type Conn,
  corpoRichiesta,
  creaRobot,
  credenzialiMqtt,
  decodificaV1,
  ErroreRoborock,
  firmaHawk,
  codificaV1,
  leggiRisposta,
  rigaRobot,
  timestampCodificato,
} from "./roborock.ts";

const KEY = "abcdefghijklmnop";
const TS = 1794160000;
const RRIOT = {
  u: "utenteU123", s: "segretoS456", h: "hmacH789", k: "chiaveK012",
  r: { a: "https://api-eu.roborock.com", m: "ssl://mqtt-eu-3.roborock.com:8883" },
};
const CORPO_RICHIESTA =
  '{"dps":{"101":"{\\"id\\":12345,\\"method\\":\\"app_segment_clean\\",\\"params\\":[{\\"segments\\":[16],\\"repeat\\":1}]}"},"t":1794160000}';
const RICHIESTA =
  "312e3000000309000010926af0b5800065008060096fdd988bb29ba97f5cb279d0574255a10c3dc309625fd7aa7603e4a4ae08c7d1bb64f38d50a2ba72b280f6d153b3177c227d3f3040ac64273524fb0b8992a340022a8907f1b5eb6aa386fcfafe996864e44069e3084104aa6d4d0a8f6a0e0fbff79bee9ccbd5159c4c46696628f383c880ce3dd90974e9f5131fc0cd2a00180a8bd1";
const RISPOSTA =
  "312e300000030a000010f76af0b58100660070e02eef62528495301d597184c1741f08dcf997070ea06fce0669990715ad59a51276f78b8c71a4ad5d0d7644662bf3d6fa3de59ed0b8fe6ba09927b664d2359db8e9d5df95b81dc1d876c31fa45cb55bb6bf3344ba6861c383f70d325b9b0b0945b5df6ddcc4cc14f0c50fd24ddbfd299e987d19";
const CORPO_RISPOSTA =
  '{"dps": {"102": "{\\"id\\": 12345, \\"result\\": [{\\"state\\": 8, \\"battery\\": 100}]}"}, "t": 1794160001}';

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const daHex = (s: string) => new Uint8Array(s.match(/../g)!.map((x) => parseInt(x, 16)));
const testo = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------- protocollo, confrontato con python-roborock
Deno.test("timestamp codificato come la libreria", () => {
  assertEquals(timestampCodificato(TS), "5800af6b");
});

Deno.test("credenziali MQTT dall'rriot", () => {
  assertEquals(credenzialiMqtt(RRIOT), {
    host: "mqtt-eu-3.roborock.com", porta: 8883, utente: "7564a54b", password: "6e18906760468cf8",
  });
});

Deno.test("firma Hawk identica alla libreria", () => {
  assertEquals(
    firmaHawk(RRIOT, "/user/scene/device/duidXYZ", TS, "nonce1"),
    'Hawk id="utenteU123",s="segretoS456",ts="1794160000",nonce="nonce1",mac="uU8TWVoh8Zk3q1ZES53amfC/OxxNI9kjZ2K2h1d1gH0="',
  );
  assertEquals(
    firmaHawk(RRIOT, "/user/scene/42/execute", TS, "nonce1"),
    'Hawk id="utenteU123",s="segretoS456",ts="1794160000",nonce="nonce1",mac="rn8DXzKnrBsYp1p7ltT47alzxRCO66NDSk9StVfl5ds="',
  );
});

Deno.test("corpo della richiesta V1 byte per byte", () => {
  assertEquals(corpoRichiesta(12345, "app_segment_clean", [{ segments: [16], repeat: 1 }], TS), CORPO_RICHIESTA);
});

Deno.test("messaggio V1 cifrato identico alla libreria", () => {
  const m = codificaV1({ seq: 777, random: 4242, timestamp: TS, protocollo: 101, corpo: testo(CORPO_RICHIESTA) }, KEY);
  assertEquals(hex(m), RICHIESTA);
});

Deno.test("risposta V1 decifrata e letta", () => {
  const m = decodificaV1(daHex(RISPOSTA), KEY);
  assertEquals([m.seq, m.random, m.timestamp, m.protocollo], [778, 4343, TS + 1, 102]);
  const corpo = new TextDecoder().decode(m.corpo);
  assertEquals(corpo, CORPO_RISPOSTA);
  assertEquals(leggiRisposta(corpo), { id: 12345, result: [{ state: 8, battery: 100 }] });
});

Deno.test("CRC sbagliato: messaggio rifiutato", () => {
  const rotta = daHex(RISPOSTA);
  rotta[rotta.length - 1] ^= 1;
  let errore = "";
  try {
    decodificaV1(rotta, KEY);
  } catch (e) {
    errore = String(e);
  }
  assert(errore.includes("CRC"));
});

Deno.test("leggiRisposta: dps senza 102 e risposta con errore", () => {
  assertEquals(leggiRisposta('{"dps":{"121":8},"t":1}'), null);
  assertEquals(leggiRisposta('{"dps":{"102":"{\\"id\\":5,\\"error\\":{\\"code\\":-10007,\\"message\\":\\"invalid status\\"}}"}}'), {
    id: 5, error: { code: -10007, message: "invalid status" },
  });
});

// ---------------------------------------------------------------- righe per il Kindle
Deno.test("righe di stato", () => {
  assertEquals(rigaRobot({ state: 8, battery: 87 }), "in carica  batteria 87%");
  assertEquals(rigaRobot({ state: 100, battery: 100 }), "carico  batteria 100%");
  assertEquals(rigaRobot({ state: 18, battery: 64 }), "pulisce  batteria 64%");
  assertEquals(rigaRobot({ state: 6303, battery: 64 }), "pulisce  batteria 64%");
  assertEquals(rigaRobot({ state: 6, battery: 30 }), "torna alla base  30%");
  assertEquals(rigaRobot({ state: 12, battery: 50, error_code: 8 }), "errore 8  batteria 50%");
  assertEquals(rigaRobot({ state: 23, battery: 50 }), "lava il mop");
  assertEquals(rigaRobot({ state: 101, battery: 0 }), "non in linea");
  assertEquals(rigaRobot({ state: 77, battery: 40 }), "stato 77  batteria 40%");
});

// ---------------------------------------------------------------- broker MQTT finto
const CFG: Config = { rriot: RRIOT, duid: "duidXYZ", localKey: KEY, homeId: 999 };
const TOPIC_IN = "rr/m/i/utenteU123/7564a54b/duidXYZ";
const TOPIC_OUT = "rr/m/o/utenteU123/7564a54b/duidXYZ";

function lunghezza(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
}
function stringa(s: string): number[] {
  const b = testo(s);
  return [b.length >> 8, b.length & 255, ...b];
}

type Opzioni = {
  connack?: number;                       // codice del CONNACK (0 = accettato)
  muto?: boolean;                         // il robot non risponde mai
  mutoDopo?: number;                      // il robot risponde solo alle prime N richieste
  rispondi?: (method: string, params: unknown) => unknown;
  errore?: string;                        // risposta 102 con error per questo metodo
  qos1?: boolean;                         // risposte con QoS 1
};

function broker(op: Opzioni = {}) {
  const ricevuti: { tipo: number; corpo: Uint8Array }[] = [];
  const metodi: [string, unknown][] = [];
  const daLeggere: number[] = [];
  let attesa: (() => void) | null = null;
  let chiusa = false;
  const manda = (b: number[]) => {
    daLeggere.push(...b);
    attesa?.();
  };
  let accumulo: number[] = [];
  const gestisci = (tipo: number, corpo: Uint8Array) => {
    ricevuti.push({ tipo, corpo });
    if (tipo === 1) manda([0x20, 2, 0, op.connack ?? 0]);
    if (tipo === 8) manda([0x90, 3, corpo[0], corpo[1], 0]);
    if (tipo === 3) {
      const lt = (corpo[0] << 8) | corpo[1];
      const topic = new TextDecoder().decode(corpo.slice(2, 2 + lt));
      assertEquals(topic, TOPIC_IN);
      const m = decodificaV1(corpo.slice(2 + lt), KEY);
      assertEquals(m.protocollo, 101);
      const dentro = JSON.parse(JSON.parse(new TextDecoder().decode(m.corpo)).dps["101"]);
      metodi.push([dentro.method, dentro.params]);
      if (op.muto || (op.mutoDopo !== undefined && metodi.length > op.mutoDopo)) return;
      const risposta = op.errore === dentro.method
        ? { id: dentro.id, error: { code: -10007, message: "invalid status" } }
        : { id: dentro.id, result: op.rispondi ? op.rispondi(dentro.method, dentro.params) : ["ok"] };
      // prima un messaggio estraneo (stato spinto dal robot), poi la risposta vera
      for (const corpoJson of [{ dps: { "121": 8 }, t: TS }, { dps: { "102": JSON.stringify(risposta) }, t: TS }]) {
        const v1 = codificaV1({
          seq: 1, random: 2, timestamp: TS, protocollo: corpoJson.dps["102"] ? 102 : 121,
          corpo: testo(JSON.stringify(corpoJson)),
        }, KEY);
        const id = op.qos1 ? [0, 9] : [];
        const resto = [...stringa(TOPIC_OUT), ...id, ...v1];
        manda([op.qos1 ? 0x32 : 0x30, ...lunghezza(resto.length), ...resto]);
      }
    }
  };
  const conn: Conn = {
    write(b: Uint8Array) {
      accumulo.push(...b);
      while (accumulo.length >= 2) {
        let mul = 1, n = 0, i = 1;
        while (true) {
          const x = accumulo[i++];
          n += (x & 127) * mul;
          mul *= 128;
          if (!(x & 128)) break;
        }
        if (accumulo.length < i + n) break;
        gestisci(accumulo[0] >> 4, new Uint8Array(accumulo.slice(i, i + n)));
        accumulo = accumulo.slice(i + n);
      }
      return Promise.resolve(b.length);
    },
    read(buf: Uint8Array) {
      return new Promise<number | null>((ok) => {
        const prova = () => {
          if (chiusa) return ok(null);
          if (!daLeggere.length) {
            attesa = prova;
            return;
          }
          attesa = null;
          const n = Math.min(buf.length, daLeggere.length);
          buf.set(daLeggere.splice(0, n));
          ok(n);
        };
        prova();
      });
    },
    close() {
      chiusa = true;
      attesa?.();
    },
  };
  return { conn, ricevuti, metodi, chiusa: () => chiusa };
}

type Web = { metodo: string; url: string; auth: string };
function web(risposte: Record<string, unknown>, chiamate: Web[], status = 200) {
  return (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    chiamate.push({ metodo: init?.method ?? "GET", url: u, auth: new Headers(init?.headers).get("Authorization") ?? "" });
    const path = new URL(u).pathname;
    const r = risposte[path];
    if (r === undefined) return Promise.resolve(new Response('{"success":false,"msg":"boh"}', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(r), { status }));
  };
}

function robot(op: Opzioni = {}, risposte: Record<string, unknown> = {}, status = 200) {
  const b = broker(op);
  const chiamate: Web[] = [];
  const connessioni: [string, number][] = [];
  const r = creaRobot(CFG, {
    fetch: web(risposte, chiamate, status),
    connetti: (host, porta) => {
      connessioni.push([host, porta]);
      return Promise.resolve(b.conn);
    },
    adesso: () => TS * 1000,
    attendi: () => Promise.resolve(),
    limite: 300,
  });
  return { r, b, chiamate, connessioni };
}

const STATO = (state: number, battery = 90) => (m: string) => m === "get_status" ? [{ state, battery }] : ["ok"];

Deno.test("sessione MQTT: CONNECT con le credenziali, SUBACK prima di pubblicare, risposta col suo id", async () => {
  const { r, b, connessioni } = robot({ rispondi: STATO(8, 87) });
  assertEquals(await r.stato(), "in carica  batteria 87%");
  assertEquals(connessioni, [["mqtt-eu-3.roborock.com", 8883]]);
  assertEquals(b.ricevuti.map((p) => p.tipo), [1, 8, 3, 14]);   // CONNECT, SUBSCRIBE, PUBLISH, DISCONNECT
  const connect = new TextDecoder().decode(b.ricevuti[0].corpo);
  assert(connect.includes("7564a54b") && connect.includes("6e18906760468cf8"));
  assert(new TextDecoder().decode(b.ricevuti[1].corpo).includes(TOPIC_OUT));
  assert(b.chiusa());
});

Deno.test("risposte con QoS 1: si legge lo stesso", async () => {
  const { r } = robot({ qos1: true, rispondi: STATO(100, 100) });
  assertEquals(await r.stato(), "carico  batteria 100%");
});

Deno.test("CONNACK rifiutato: errore di accesso", async () => {
  const { r } = robot({ connack: 5 });
  const e = await assertRejects(() => r.stato(), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "accesso");
});

Deno.test("robot muto: errore di tempo, connessione chiusa", async () => {
  const { r, b } = robot({ muto: true });
  const e = await assertRejects(() => r.stato(), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "tempo");
  assert(b.chiusa());
});

Deno.test("stanza: prima lo stato, poi app_segment_clean col segmento, poi di nuovo lo stato", async () => {
  const { r, b } = robot({ rispondi: (m) => m === "get_status" ? [{ state: 18, battery: 70 }] : m === "get_room_mapping" ? [[16, "111", 14], [17, "222", 14]] : ["ok"] },
    { "/user/homes/999/rooms": { success: true, result: [{ id: 111, name: "Cucina" }, { id: 222, name: "Soggiorno" }] } });
  assertEquals(await r.stanza(17), { nome: "Soggiorno", stato: "pulisce  batteria 70%" });
  assertEquals(b.metodi.map(([m]) => m), ["get_status", "get_room_mapping", "app_segment_clean", "get_status"]);
  assertEquals(b.metodi[2][1], [{ segments: [17], repeat: 1 }]);
});

Deno.test("stanza che non c'è più: non si manda niente", async () => {
  const { r, b } = robot({ rispondi: (m) => m === "get_status" ? [{ state: 8, battery: 70 }] : [[16, "111"]] },
    { "/user/homes/999/rooms": { success: true, result: [{ id: 111, name: "Cucina" }] } });
  const e = await assertRejects(() => r.stanza(30), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "stanza");
  assert(!b.metodi.some(([m]) => m === "app_segment_clean"));
});

Deno.test("robot muto: il comando non parte", async () => {
  const { r, b } = robot({ muto: true });
  await assertRejects(() => r.base(), ErroreRoborock);
  assertEquals(b.metodi.map(([m]) => m), ["get_status"]);
});

Deno.test("pausa e base", async () => {
  const p = robot({ rispondi: STATO(10, 55) });
  assertEquals(await p.r.pausa(), "in pausa  batteria 55%");
  assertEquals(p.b.metodi.map(([m]) => m), ["get_status", "app_pause", "get_status"]);
  const c = robot({ rispondi: STATO(6, 55) });
  assertEquals(await c.r.base(), "torna alla base  55%");
  assertEquals(c.b.metodi.map(([m]) => m), ["get_status", "app_charge", "get_status"]);
});

Deno.test("errore del robot nella risposta", async () => {
  const { r } = robot({ rispondi: STATO(8), errore: "app_charge" });
  const e = await assertRejects(() => r.base(), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "robot");
  assert((e as ErroreRoborock).message.includes("invalid status"));
});

Deno.test("routine: elenco firmato Hawk, avvio dal web, poi lo stato", async () => {
  const { r, b, chiamate } = robot({ rispondi: STATO(5, 80) }, {
    "/user/scene/device/duidXYZ": { success: true, result: [{ id: 42, name: "Dopo cena", enabled: true }, { id: 43, name: "Lava tutto" }] },
    "/user/scene/42/execute": { success: true, result: null },
  });
  assertEquals(await r.routine(42), { nome: "Dopo cena", stato: "pulisce  batteria 80%" });
  assertEquals(chiamate.map((c) => [c.metodo, new URL(c.url).pathname]), [
    ["GET", "/user/scene/device/duidXYZ"], ["POST", "/user/scene/42/execute"],
  ]);
  assert(chiamate.every((c) => c.auth.startsWith('Hawk id="utenteU123",s="segretoS456",ts="1794160000"')));
  assertEquals(b.metodi.map(([m]) => m), ["get_status", "get_status"]);
});

Deno.test("routine sparita: errore, niente avvio", async () => {
  const { r, chiamate } = robot({ rispondi: STATO(8) }, { "/user/scene/device/duidXYZ": { success: true, result: [] } });
  const e = await assertRejects(() => r.routine(42), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "routine");
  assert(!chiamate.some((c) => c.metodo === "POST"));
});

Deno.test("web 401: errore di accesso", async () => {
  const { r } = robot({}, { "/user/scene/device/duidXYZ": { success: false, msg: "token invalid" } }, 401);
  const e = await assertRejects(() => r.elenco(), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "accesso");
});

Deno.test("elenco: routine e solo le stanze della mappa, col segmento come id", async () => {
  const { r } = robot({ rispondi: (m) => m === "get_room_mapping" ? [[16, "111", 14], [18, "333", 14]] : ["ok"] }, {
    "/user/scene/device/duidXYZ": { success: true, result: [{ id: 42, name: "Dopo cena" }] },
    "/user/homes/999/rooms": { success: true, result: [{ id: 111, name: "Cucina" }, { id: 222, name: "Garage" }] },
  });
  assertEquals(await r.elenco(), {
    routine: [{ id: 42, nome: "Dopo cena" }],
    stanze: [{ id: 16, nome: "Cucina" }, { id: 18, nome: "Stanza 18" }],
  });
});

Deno.test("comando partito ma senza risposta: inviato", async () => {
  const { r, b } = robot({ rispondi: STATO(8), mutoDopo: 1 });
  const e = await assertRejects(() => r.base(), ErroreRoborock);
  assertEquals((e as ErroreRoborock).tipo, "inviato");
  assertEquals(b.metodi.map(([m]) => m), ["get_status", "app_charge"]);
});

Deno.test("stato finale perso: il comando resta buono, stato --", async () => {
  const { r } = robot({ rispondi: STATO(8), mutoDopo: 2 });
  assertEquals(await r.pausa(), "--");
});
