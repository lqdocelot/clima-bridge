// Roborock Qrevo per la bacheca del frigo (Kindle): routine dal web Roborock, stanze / pausa / base / stato via MQTT
// (protocollo V1 dei Qrevo). Spec: bacheca-frigo docs/superpowers/specs/2026-11-08-scheda-robot-design.md.
// Riferimento: python-roborock 7.19 (la libreria di Home Assistant); i test confrontano i byte con i suoi.
// Nessun segreto qui: rriot, duid e localKey arrivano dalla variabile d'ambiente ROBOROCK (telecomando.ts).
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

export type Rriot = { u: string; s: string; h: string; k: string; r: { a: string; m: string } };
export type Config = { rriot: Rriot; duid: string; localKey: string; homeId: number; modello?: string };
export type Conn = { read(b: Uint8Array): Promise<number | null>; write(b: Uint8Array): Promise<number>; close(): void };
export type Rete = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  connetti: (host: string, porta: number) => Promise<Conn>;
  adesso: () => number;                    // ms
  attendi: (ms: number) => Promise<void>;
  limite?: number;                         // ms per ogni attesa (web, connessione, risposta); 4000
};
export type Voce = { id: number; nome: string };
export type Tipo = "accesso" | "web" | "rete" | "tempo" | "inviato" | "robot" | "routine" | "stanza";

export class ErroreRoborock extends Error {
  constructor(public tipo: Tipo, messaggio: string) {
    super(messaggio);
  }
}

const enc = new TextEncoder(), dec = new TextDecoder();
const md5hex = (s: string) => createHash("md5").update(s).digest("hex");
const ascii = (s: string) => s.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/'/g, " ").slice(0, 34);

function entro<T>(p: Promise<T>, ms: number, cosa: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, no) => t = setTimeout(() => no(new ErroreRoborock("tempo", `${cosa}: tempo scaduto`)), ms)),
  ]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- messaggio V1
const SALT = "TXdfu$jyZ#TZHsg4";

export function timestampCodificato(ts: number): string {
  const h = ts.toString(16).padStart(8, "0");
  return [5, 6, 3, 7, 1, 2, 0, 4].map((i) => h[i]).join("");
}
const chiaveV1 = (ts: number, localKey: string) =>
  createHash("md5").update(timestampCodificato(ts) + localKey + SALT).digest();

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type MessaggioV1 = { seq: number; random: number; timestamp: number; protocollo: number; corpo: Uint8Array };

export function codificaV1(m: MessaggioV1, localKey: string): Uint8Array {
  const c = createCipheriv("aes-128-ecb", chiaveV1(m.timestamp, localKey), null);
  const cifrato = m.corpo.length ? Buffer.concat([c.update(m.corpo), c.final()]) : new Uint8Array(0);
  const out = new Uint8Array(19 + cifrato.length + 4);
  const dv = new DataView(out.buffer);
  out.set(enc.encode("1.0"), 0);
  dv.setUint32(3, m.seq);
  dv.setUint32(7, m.random);
  dv.setUint32(11, m.timestamp);
  dv.setUint16(15, m.protocollo);
  dv.setUint16(17, cifrato.length);
  out.set(cifrato, 19);
  dv.setUint32(19 + cifrato.length, crc32(out.subarray(0, 19 + cifrato.length)));
  return out;
}

export function decodificaV1(b: Uint8Array, localKey: string): MessaggioV1 {
  if (b.length < 23 || dec.decode(b.subarray(0, 3)) !== "1.0") throw new ErroreRoborock("robot", "messaggio V1 non valido");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint16(17);
  if (b.length < 19 + n + 4) throw new ErroreRoborock("robot", "messaggio V1 troncato");
  if (crc32(b.subarray(0, 19 + n)) !== dv.getUint32(19 + n)) throw new ErroreRoborock("robot", "CRC sbagliato");
  const timestamp = dv.getUint32(11);
  let corpo = new Uint8Array(0);
  if (n) {
    const d = createDecipheriv("aes-128-ecb", chiaveV1(timestamp, localKey), null);
    corpo = new Uint8Array(Buffer.concat([d.update(b.subarray(19, 19 + n)), d.final()]));
  }
  return { seq: dv.getUint32(3), random: dv.getUint32(7), timestamp, protocollo: dv.getUint16(15), corpo };
}

export function corpoRichiesta(id: number, method: string, params: unknown, ts: number): string {
  return JSON.stringify({ dps: { "101": JSON.stringify({ id, method, params }) }, t: ts });
}

export type Risposta = { id: number; result?: unknown; error?: { code?: number; message?: string } };

export function leggiRisposta(corpo: string): Risposta | null {
  const dp = JSON.parse(corpo)?.dps?.["102"];
  if (dp == null) return null;
  return typeof dp === "string" ? JSON.parse(dp) : dp;
}

// ---------------------------------------------------------------- credenziali e firma del web
export function credenzialiMqtt(r: Rriot) {
  const u = new URL(r.r.m);
  return {
    host: u.hostname,
    porta: Number(u.port),
    utente: md5hex(`${r.u}:${r.k}`).slice(2, 10),
    password: md5hex(`${r.s}:${r.k}`).slice(16),
  };
}

export function firmaHawk(r: Rriot, path: string, ts: number, nonce: string): string {
  const pre = [r.u, r.s, nonce, String(ts), md5hex(path), "", ""].join(":");
  const mac = createHmac("sha256", r.h).update(pre).digest("base64");
  return `Hawk id="${r.u}",s="${r.s}",ts="${ts}",nonce="${nonce}",mac="${mac}"`;
}

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(6)))).replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------------------------------------------------------------- MQTT 3.1.1 minimo
function lunghezzaMqtt(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
}
const stringa = (s: string) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
const pacchetto = (primo: number, corpo: number[]) => new Uint8Array([primo, ...lunghezzaMqtt(corpo.length), ...corpo]);

type Pacchetto = { tipo: number; flag: number; corpo: Uint8Array };

class Lettore {
  private buf = new Uint8Array(0);
  private pezzo = new Uint8Array(4096);
  private inCorso: Promise<void> | null = null;
  constructor(private conn: Conn) {}

  private estrai(): Pacchetto | null {
    let mul = 1, n = 0, i = 1;
    while (true) {
      if (i >= this.buf.length) return null;
      const x = this.buf[i++];
      n += (x & 127) * mul;
      mul *= 128;
      if (!(x & 128)) break;
    }
    if (this.buf.length < i + n) return null;
    const p = { tipo: this.buf[0] >> 4, flag: this.buf[0] & 15, corpo: this.buf.slice(i, i + n) };
    this.buf = this.buf.slice(i + n);
    return p;
  }

  private leggi(): Promise<void> {
    if (!this.inCorso) {
      this.inCorso = this.conn.read(this.pezzo).then((n) => {
        this.inCorso = null;
        if (n === null) throw new ErroreRoborock("rete", "connessione chiusa");
        const nuovo = new Uint8Array(this.buf.length + n);
        nuovo.set(this.buf);
        nuovo.set(this.pezzo.subarray(0, n), this.buf.length);
        this.buf = nuovo;
      });
      this.inCorso.catch(() => {});          // una lettura lasciata a metà dalla chiusura non è un errore
    }
    return this.inCorso;
  }

  async prossimo(ms: number): Promise<Pacchetto> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const tempo = new Promise<never>((_, no) => t = setTimeout(() => no(new ErroreRoborock("tempo", "il robot non risponde")), ms));
    try {
      while (true) {
        const p = this.estrai();
        if (p) return p;
        await Promise.race([this.leggi(), tempo]);
      }
    } finally {
      clearTimeout(t);
    }
  }
}

type Rpc = (method: string, params?: unknown) => Promise<unknown>;

async function sessione<T>(cfg: Config, rete: Rete, lavoro: (rpc: Rpc) => Promise<T>): Promise<T> {
  const lim = rete.limite ?? 4000;
  const c = credenzialiMqtt(cfg.rriot);
  const conn = await entro(rete.connetti(c.host, c.porta), lim, "connessione MQTT");
  const l = new Lettore(conn);
  const dentro = `rr/m/i/${cfg.rriot.u}/${c.utente}/${cfg.duid}`, fuori = `rr/m/o/${cfg.rriot.u}/${c.utente}/${cfg.duid}`;
  const casuale = () => Math.floor(Math.random() * 0x7fffffff);
  try {
    const id = "bacheca" + casuale().toString(36);
    await conn.write(pacchetto(0x10, [...stringa("MQTT"), 4, 0xc2, 0, 60, ...stringa(id), ...stringa(c.utente), ...stringa(c.password)]));
    const ack = await l.prossimo(lim);
    if (ack.tipo !== 2) throw new ErroreRoborock("rete", "risposta MQTT inattesa");
    if (ack.corpo[1] === 4 || ack.corpo[1] === 5) throw new ErroreRoborock("accesso", `MQTT rifiutato (${ack.corpo[1]})`);
    if (ack.corpo[1] !== 0) throw new ErroreRoborock("rete", `MQTT rifiutato (${ack.corpo[1]})`);
    await conn.write(pacchetto(0x82, [0, 1, ...stringa(fuori), 0]));
    while ((await l.prossimo(lim)).tipo !== 9);   // SUBACK: solo dopo si pubblica
    let seq = 1;
    const rpc: Rpc = async (method, params = []) => {
      const idRichiesta = 10000 + Math.floor(Math.random() * 22767);
      const ts = Math.floor(rete.adesso() / 1000);
      const v1 = codificaV1({
        seq: seq++, random: casuale(), timestamp: ts, protocollo: 101,
        corpo: enc.encode(corpoRichiesta(idRichiesta, method, params, ts)),
      }, cfg.localKey);
      await conn.write(pacchetto(0x30, [...stringa(dentro), ...v1]));
      while (true) {
        const p = await l.prossimo(lim);
        if (p.tipo !== 3) continue;
        const lt = (p.corpo[0] << 8) | p.corpo[1];
        const topic = dec.decode(p.corpo.subarray(2, 2 + lt));
        let da = 2 + lt;
        if ((p.flag >> 1) & 3) {                      // QoS 1: si conferma
          await conn.write(new Uint8Array([0x40, 2, p.corpo[da], p.corpo[da + 1]]));
          da += 2;
        }
        if (topic !== fuori) continue;
        let m: MessaggioV1;
        try {
          m = decodificaV1(p.corpo.subarray(da), cfg.localKey);
        } catch {
          continue;
        }
        if (m.protocollo !== 102) continue;
        const r = leggiRisposta(dec.decode(m.corpo));
        if (!r || r.id !== idRichiesta) continue;
        if (r.error) throw new ErroreRoborock("robot", r.error.message ?? JSON.stringify(r.error));
        return r.result;
      }
    };
    return await lavoro(rpc);
  } finally {
    try {
      await conn.write(new Uint8Array([0xe0, 0]));
    } catch { /* già chiusa */ }
    try {
      conn.close();
    } catch { /* già chiusa */ }
  }
}

// ---------------------------------------------------------------- righe per il Kindle
// deno-lint-ignore no-explicit-any
export function rigaRobot(s: any): string {
  if (!s || typeof s !== "object") return "--";
  const st = Number(s.state), b = Number(s.battery);
  const batt = Number.isFinite(b) ? `  batteria ${b}%` : "";
  let r: string;
  if (st === 8) r = `in carica${batt}`;
  else if (st === 100) r = `carico${batt}`;
  else if (st === 3 || st === 2) r = `fermo${batt}`;
  else if ([5, 11, 17, 18].includes(st) || (st >= 6301 && st <= 6307)) r = `pulisce${batt}`;
  else if (st === 6 || st === 15) r = `torna alla base${Number.isFinite(b) ? `  ${b}%` : ""}`;
  else if (st === 10) r = `in pausa${batt}`;
  else if (st === 12) r = `errore ${s.error_code ?? "?"}${batt}`;
  else if (st === 22) r = "svuota il cestino";
  else if ([23, 25, 26].includes(st)) r = "lava il mop";
  else if (st === 14) r = "si aggiorna";
  else if (st === 29) r = "crea la mappa";
  else if (st === 101) r = "non in linea";
  else r = `stato ${st}${batt}`;
  return ascii(r);
}

// ---------------------------------------------------------------- il robot
export type Robot = {
  elenco(): Promise<{ routine: Voce[]; stanze: Voce[] }>;
  stato(): Promise<string>;
  routine(id: number): Promise<{ nome: string; stato: string }>;
  stanza(segmento: number): Promise<{ nome: string; stato: string }>;
  pausa(): Promise<string>;
  base(): Promise<string>;
};

export function creaRobot(cfg: Config, rete: Rete): Robot {
  const lim = rete.limite ?? 4000;
  const DOPO = 1500;                                  // il robot cambia stato qualche istante dopo il comando

  // deno-lint-ignore no-explicit-any
  const web = async (metodo: string, path: string): Promise<any> => {
    const ts = Math.floor(rete.adesso() / 1000);
    const r = await entro(rete.fetch(cfg.rriot.r.a.replace(/\/+$/, "") + path, {
      method: metodo,
      headers: { Authorization: firmaHawk(cfg.rriot, path, ts, nonce()) },
      signal: AbortSignal.timeout(lim),
    }), lim, "web Roborock");
    if (r.status === 401 || r.status === 403) throw new ErroreRoborock("accesso", `web ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j?.success) throw new ErroreRoborock("web", `web ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    return j.result;
  };

  // deno-lint-ignore no-explicit-any
  const statoDa = async (rpc: Rpc) => rigaRobot(((r: any) => Array.isArray(r) ? r[0] : r)(await rpc("get_status")));
  // deno-lint-ignore no-explicit-any
  const routineLista = async (): Promise<Voce[]> => ((await web("GET", `/user/scene/device/${cfg.duid}`)) ?? []).map((s: any) => ({
    id: Number(s.id), nome: String(s.name ?? `Routine ${s.id}`),
  }));
  const nomiStanze = async () =>
    // deno-lint-ignore no-explicit-any
    new Map<string, string>(((await web("GET", `/user/homes/${cfg.homeId}/rooms`)) ?? []).map((s: any) => [String(s.id), String(s.name)]));
  const mappa = (r: unknown): [number, string][] => {        // get_room_mapping: [[segmento, iot_id], …]
    if (!Array.isArray(r)) return [];
    if (r.length === 2 && !Array.isArray(r[0])) return [[Number(r[0]), String(r[1])]];
    return r.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [Number(p[0]), String(p[1])]);
  };
  // comando partito ma senza risposta: «inviato»; stato finale perso: «--» (il comando resta buono)
  const invia = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      if (e instanceof ErroreRoborock && e.tipo === "tempo") throw new ErroreRoborock("inviato", "risposta al comando non arrivata");
      throw e;
    }
  };
  const statoDopo = async (rpc: Rpc) => {
    await rete.attendi(DOPO);
    return await statoDa(rpc).catch(() => "--");
  };
  const comando = (method: string, params?: unknown) =>
    sessione(cfg, rete, async (rpc) => {
      await statoDa(rpc);                          // il robot risponde? altrimenti il comando non parte
      await invia(() => rpc(method, params));
      return statoDopo(rpc);
    });

  return {
    async elenco() {
      const [routine, nomi, m] = await Promise.all([
        routineLista(), nomiStanze(), sessione(cfg, rete, (rpc) => rpc("get_room_mapping")),
      ]);
      return { routine, stanze: mappa(m).map(([seg, iot]) => ({ id: seg, nome: nomi.get(iot) ?? `Stanza ${seg}` })) };
    },
    stato: () => sessione(cfg, rete, statoDa),
    async routine(id) {
      const r = (await routineLista()).find((x) => x.id === id);
      if (!r) throw new ErroreRoborock("routine", `routine ${id} non trovata`);
      const stato = await sessione(cfg, rete, async (rpc) => {
        await statoDa(rpc);
        await web("POST", `/user/scene/${id}/execute`);
        return statoDopo(rpc);
      });
      return { nome: r.nome, stato };
    },
    async stanza(segmento) {
      const nomi = nomiStanze();
      nomi.catch(() => {});
      return await sessione(cfg, rete, async (rpc) => {
        await statoDa(rpc);
        const voce = mappa(await rpc("get_room_mapping")).find(([s]) => s === segmento);
        if (!voce) throw new ErroreRoborock("stanza", `stanza ${segmento} non trovata`);
        const nome = (await nomi.catch(() => new Map<string, string>())).get(voce[1]) ?? `Stanza ${segmento}`;
        await invia(() => rpc("app_segment_clean", [{ segments: [segmento], repeat: 1 }]));
        return { nome, stato: await statoDopo(rpc) };
      });
    },
    pausa: () => comando("app_pause"),
    base: () => comando("app_charge"),
  };
}

// ---------------------------------------------------------------- val.town
export const reteVera: Rete = {
  fetch: (url, init) => fetch(url, init),
  connetti: (hostname, port) => Deno.connectTls({ hostname, port }),
  adesso: () => Date.now(),
  attendi: (ms) => new Promise((r) => setTimeout(r, ms)),
};
