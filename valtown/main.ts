// Telecomando clima per Telegram — bot a bottoni (val.town, webhook).
// Env vars su val.town: TELEGRAM_TOKEN, FGLAIR_EMAIL, FGLAIR_PASSWORD, GH_PAT, ALLOWED_CHATS, WEBHOOK_SECRET

const TG = Deno.env.get("TELEGRAM_TOKEN")!;
const FG_EMAIL = Deno.env.get("FGLAIR_EMAIL")!;
const FG_PASS = Deno.env.get("FGLAIR_PASSWORD")!;
const GH_PAT = Deno.env.get("GH_PAT") || "";
const ALLOWED = (Deno.env.get("ALLOWED_CHATS") || "287353790").split(",").map((
  s,
) => s.trim());
const SECRET = Deno.env.get("WEBHOOK_SECRET") || "";

const SIGNIN = "https://user-field-eu.aylanetworks.com/users/sign_in.json";
const BASE = "https://ads-field-eu.aylanetworks.com/apiv1/";
const APP_ID = "FGLair-eu-id";
const APP_SECRET = "FGLair-eu-gpFbVBRoiJ8E3QWJ-QRULLL3j3U";
const REPO = "lqdocelot/clima-bridge";
const SENSORS_URL =
  "https://raw.githubusercontent.com/lqdocelot/clima-bridge/main/sensors.json";
const EMERGENCY_URL =
  "https://raw.githubusercontent.com/lqdocelot/clima-bridge/main/emergency.json";
const BACHECA_REPO = "lqdocelot/bacheca-frigo"; // bacheca del frigo (Kindle): workflow genera.yml
const GIORNATE: Record<string, string> = {
  upper: "Upper",
  lower: "Lower",
  riposo: "Riposo",
  scarica: "Scarica",
};

const OFF = 0, COOL = 3, DRY = 4, FAN = 5, HEAT = 6;
// 🔥 Caldo: come l'accensione del Comfort invernale del ponte (TARGET_WINTER, ventola minima, alette su)
const CALDO_T = Number(Deno.env.get("TARGET_WINTER") || 24);
const MODENAME: Record<number, string> = {
  0: "Spento",
  2: "Auto",
  3: "❄️ Cool",
  4: "💧 Dry",
  5: "🌀 Vento",
  6: "🔥 Caldo",
};
const FANNAME: Record<number, string> = {
  0: "🤫 Silenz.",
  1: "Bassa",
  2: "Media",
  3: "Alta",
  4: "Auto",
};
const VDIR_MAX = 6;
const ROOMS: Record<string, { name: string; dsn: string }> = {
  S: { name: "🛋️ Soggiorno", dsn: "AC000W002919142" },
  C: { name: "🛏️ Camera Eva", dsn: "AC000W002919128" },
};
const TMIN = 17, TMAX = 30;
const SAFE_T = 26;

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function fgLogin(): Promise<string> {
  const body = JSON.stringify({
    user: {
      email: FG_EMAIL,
      password: FG_PASS,
      application: { app_id: APP_ID, app_secret: APP_SECRET },
    },
  });
  const r = await fetch(SIGNIN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return (await r.json()).access_token;
}
async function fgProps(token: string, dsn: string) {
  const r = await fetch(BASE + `dsns/${dsn}/properties.json`, {
    headers: { Authorization: "auth_token " + token },
  });
  const arr = await r.json();
  const m: Record<string, { key: number; value: number }> = {};
  for (const p of arr) {
    if (p.property) {
      m[p.property.name] = { key: p.property.key, value: p.property.value };
    }
  }
  return m;
}
function fgSet(token: string, key: number, value: number | string) {
  return fetch(BASE + `properties/${key}/datapoints.json`, {
    method: "POST",
    headers: {
      Authorization: "auth_token " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ datapoint: { value: String(value) } }),
  });
}
function ghPresence(ev: string) {
  if (!GH_PAT) return Promise.resolve();
  return fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/presence.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GH_PAT,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs: { action: ev } }),
    },
  );
}
function ghEmergency(action: string) {
  if (!GH_PAT) return Promise.resolve();
  return fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/emergency.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GH_PAT,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs: { action } }),
    },
  );
}
// ▶️ Auto (comfort.yml) = riprendi automatico: azzera emergenza + tutti gli override manuali.
// Con dsn vale per UNA sola stanza (emergenza e altre stanze restano come sono).
function ghComfort(dsn = "") {
  if (!GH_PAT) return Promise.resolve();
  return fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/comfort.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GH_PAT,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs: { dsn } }),
    },
  );
}
async function commandAll(token: string, mode: "off" | "safe") {
  for (const k of ["S", "C"]) {
    const p = await fgProps(token, ROOMS[k].dsn);
    if (mode === "off") {
      await fgSet(token, p.operation_mode.key, OFF);
    } else {
      await fgSet(token, p.operation_mode.key, COOL);
      await fgSet(token, p.adjust_temperature.key, SAFE_T * 10);
      await fgSet(token, p.fan_speed.key, 0);
      if (p.af_vertical_swing) await fgSet(token, p.af_vertical_swing.key, 0);
      if (p.af_vertical_direction) {
        await fgSet(token, p.af_vertical_direction.key, 1);
      }
    }
  }
}
async function emergencyStatus(): Promise<string | null> {
  try {
    const e = await (await fetch(EMERGENCY_URL + "?t=" + Date.now())).json();
    if (
      (e.mode === "off" || e.mode === "safe") &&
      Date.now() / 1000 < (e.until || 0)
    ) {
      const until = new Date(e.until * 1000).toLocaleString("it-IT", {
        timeZone: "Europe/Rome",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `🆘 EMERGENZA ${
        e.mode === "off" ? "Tutto spento" : "Modalità sicura"
      } attiva fino al ${until}`;
    }
  } catch (_e) { /* ignora */ }
  return null;
}
async function readStates(token: string) {
  const st: Record<
    string,
    {
      mode: number;
      sp: number;
      temp: number | null;
      fan: number;
      vsw: number;
      vdir: number;
    }
  > = {};
  for (const k of ["S", "C"]) {
    const p = await fgProps(token, ROOMS[k].dsn);
    const dt = p.display_temperature?.value;
    st[k] = {
      mode: p.operation_mode.value,
      sp: p.adjust_temperature.value / 10,
      temp: dt ? (dt - 5000) / 100 : null,
      fan: p.fan_speed?.value ?? 4,
      vsw: p.af_vertical_swing?.value ?? 0,
      vdir: p.af_vertical_direction?.value ?? 1,
    };
  }
  return st;
}
// Data a cui vale la scelta della dieta (ora italiana): dopo le 20 vale per domani.
export function dataDieta(now = new Date()): { iso: string; label: string } {
  const parti = (d: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("it-IT", {
        timeZone: "Europe/Rome",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        weekday: "long",
      }).formatToParts(d).map((p) => [p.type, p.value]),
    );
  let p = parti(now);
  if (Number(p.hour) >= 20) {
    p = parti(new Date(now.getTime() + 24 * 3600 * 1000));
  }
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    label: `${p.weekday} ${Number(p.day)}/${Number(p.month)}`,
  };
}
function menuDieta() {
  return {
    inline_keyboard: [
      [{ text: "Upper", callback_data: "D:upper" }, {
        text: "Lower",
        callback_data: "D:lower",
      }],
      [{ text: "Riposo", callback_data: "D:riposo" }, {
        text: "Scarica",
        callback_data: "D:scarica",
      }],
    ],
  };
}
// Lancia il workflow della bacheca con la scelta; ritorna lo stato HTTP (2xx = accettato, 0 = niente token).
async function ghDieta(giornata: string, data: string): Promise<number> {
  if (!GH_PAT) return 0;
  const r = await fetch(
    `https://api.github.com/repos/${BACHECA_REPO}/actions/workflows/genera.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GH_PAT,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { giornata, data } }),
    },
  );
  return r.status;
}

function panel(
  st: Record<
    string,
    {
      mode: number;
      sp: number;
      temp: number | null;
      fan: number;
      vsw: number;
      vdir: number;
    }
  >,
) {
  const rows: unknown[] = [];
  for (const k of ["S", "C"]) {
    const s = st[k];
    const r = ROOMS[k];
    const info = `${r.name}: ${MODENAME[s.mode] || s.mode}${
      s.mode !== OFF ? " " + s.sp + "°C" : ""
    }${s.temp != null ? " · " + s.temp.toFixed(1) + "°" : ""} · 💨 ${
      FANNAME[s.fan] || s.fan
    }${s.vsw ? " · ↕️" : ""}`;
    rows.push([{ text: info, callback_data: "R" }]);
    rows.push([{ text: "✅ Accendi", callback_data: `${k}:on` }, {
      text: "⛔ Spegni",
      callback_data: `${k}:off`,
    }, { text: "▶️ Auto", callback_data: `${k}:auto` }]);
    rows.push([{ text: "➖", callback_data: `${k}:-` }, {
      text: `${s.sp}°C`,
      callback_data: "R",
    }, { text: "➕", callback_data: `${k}:+` }]);
    rows.push([{ text: "🔥 Caldo", callback_data: `${k}:heat` }, {
      text: "❄️ Cool",
      callback_data: `${k}:cool`,
    }, { text: "💧 Dry", callback_data: `${k}:dry` }, {
      text: "🌀 Vento",
      callback_data: `${k}:fan`,
    }]);
    rows.push([
      { text: "🤫", callback_data: `${k}:f0` },
      { text: "Bassa", callback_data: `${k}:f1` },
      { text: "Media", callback_data: `${k}:f2` },
      { text: "Alta", callback_data: `${k}:f3` },
      { text: "Auto", callback_data: `${k}:f4` },
    ]);
    rows.push([{ text: "↕️ Oscilla", callback_data: `${k}:vs` }, {
      text: "⬆️ Su",
      callback_data: `${k}:vu`,
    }, { text: "⬇️ Giù", callback_data: `${k}:vd` }]);
  }
  rows.push([{ text: "🏋️ Dieta", callback_data: "D" }]);
  rows.push([{ text: "🌡️ Temperature casa", callback_data: "T" }]);
  rows.push([{ text: "🏠 Casa", callback_data: "P:casa" }, {
    text: "🚪 Fuori",
    callback_data: "P:fuori",
  }, { text: "🔄 Aggiorna", callback_data: "R" }]);
  rows.push([{ text: "🆘 Tutto spento", callback_data: "E:off" }, {
    text: "🛡️ Sicura",
    callback_data: "E:safe",
  }, { text: "▶️ Auto tutti", callback_data: "E:comfort" }]);
  return { inline_keyboard: rows };
}
export default async function (req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("ok");
  if (SECRET && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) {
    return new Response("forbidden", { status: 401 });
  }
  const upd = await req.json();
  const cb = upd.callback_query;
  const msg = upd.message || upd.edited_message;
  const chat = cb ? cb.message.chat.id : msg?.chat.id;
  if (chat == null) return new Response("ok");
  if (!ALLOWED.includes(String(chat))) {
    await tg("sendMessage", {
      chat_id: chat,
      text:
        `⛔ Non autorizzato.\nIl tuo ID Telegram è: ${chat}\nPassalo a chi gestisce il bot.`,
    });
    return new Response("ok");
  }
  // Dieta per la bacheca del frigo: gestita PRIMA del login FGLair, così funziona anche se FGLair è giù.
  const testo: string = msg?.text?.trim() || "";
  if (testo.startsWith("/dieta") || cb?.data === "D") {
    if (cb) await tg("answerCallbackQuery", { callback_query_id: cb.id });
    await tg("sendMessage", {
      chat_id: chat,
      text: `🏋️ Dieta di ${dataDieta().label}: quale giornata?`,
      reply_markup: menuDieta(),
    });
    return new Response("ok");
  }
  if (cb && typeof cb.data === "string" && cb.data.startsWith("D:")) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    const g = cb.data.slice(2);
    if (!Object.hasOwn(GIORNATE, g)) return new Response("ok");
    const { iso, label } = dataDieta();
    const stato = await ghDieta(g, iso).catch(() => 0);
    const ok = stato >= 200 && stato < 300;
    console.log("dieta", g, iso, "dispatch", stato);
    await tg("editMessageText", {
      chat_id: chat,
      message_id: cb.message.message_id,
      text: ok
        ? `✅ Dieta di ${label}: ${
          GIORNATE[g]
        } — sul Kindle al prossimo aggiornamento`
        : `⚠️ Non riuscito (codice ${stato}), riprova`,
      ...(ok ? {} : { reply_markup: menuDieta() }),
    });
    return new Response("ok");
  }

  const token = await fgLogin();
  if (msg) {
    const [st, es] = await Promise.all([readStates(token), emergencyStatus()]);
    await tg("sendMessage", {
      chat_id: chat,
      text: "🌡️ Telecomando clima casa" + (es ? "\n" + es : ""),
      reply_markup: panel(st),
    });
    return new Response("ok");
  }
  if (cb) {
    const data: string = cb.data;
    if (data === "T") {
      try {
        const s = await (await fetch(SENSORS_URL + "?t=" + Date.now())).json();
        const lines = (s.rooms || []).map((
          r: { name: string; t: number; h: number | null },
        ) => `${r.name}: ${r.t}°${r.h != null ? " · " + r.h + "%" : ""}`).join(
          "\n",
        );
        await tg("answerCallbackQuery", { callback_query_id: cb.id });
        await tg("sendMessage", {
          chat_id: chat,
          text: `🌡️ Temperature casa (agg. ${s.updated || "?"})\n${lines}`,
        });
      } catch (_e) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Errore lettura temperature",
        });
      }
      return new Response("ok");
    }
    let note = "Fatto";
    if (data === "R") {
      note = "Aggiornato";
    } else if (data.startsWith("P:")) {
      await ghPresence(data.slice(2));
      note = data.slice(2) === "casa" ? "🏠 Casa" : "🚪 Fuori";
    } else if (data.startsWith("E:")) {
      const act = data.slice(2);
      let txt = "";
      if (act === "off") {
        await ghEmergency("off");
        await commandAll(token, "off");
        note = "🆘 Tutto spento";
        txt =
          "🆘 Tutto spento attivo per ~24h.\nPer riprendere l'automatico premi ▶️ Auto.";
      } else if (act === "safe") {
        await ghEmergency("safe");
        await commandAll(token, "safe");
        note = "🛡️ Modalità sicura";
        txt =
          "🛡️ Modalità sicura attiva per ~24h.\nPer riprendere l'automatico premi ▶️ Auto.";
      } else {
        await ghComfort();
        note = "▶️ Auto";
        txt = "▶️ Automatico ripreso: emergenza e override manuali azzerati.";
      }
      await tg("sendMessage", { chat_id: chat, text: txt });
    } else if (data.endsWith(":auto")) {
      // ▶️ Auto di una stanza: comfort.yml, che lancia subito un giro del ponte (1-2 min)
      const k = data.split(":")[0];
      await ghComfort(ROOMS[k].dsn);
      note = "▶️ Auto " + ROOMS[k].name;
      await tg("sendMessage", {
        chat_id: chat,
        text: `▶️ ${ROOMS[k].name}: torna in automatico tra 1-2 minuti.` +
          "\nD'inverno: caldo a 24°, ventola minima, alette in alto.",
      });
    } else {
      const [k, act] = data.split(":");
      const p = await fgProps(token, ROOMS[k].dsn);
      const sp = p.adjust_temperature.value / 10;
      if (act === "on" || act === "cool") {
        await fgSet(token, p.operation_mode.key, COOL);
      } else if (act === "heat") {
        await fgSet(token, p.operation_mode.key, HEAT);
        await fgSet(token, p.adjust_temperature.key, Math.round(CALDO_T * 10));
        if (p.fan_speed) await fgSet(token, p.fan_speed.key, 0);
        if (p.af_vertical_swing) await fgSet(token, p.af_vertical_swing.key, 0);
        if (p.af_vertical_direction) {
          await fgSet(token, p.af_vertical_direction.key, 1);
        }
      } else if (act === "off") await fgSet(token, p.operation_mode.key, OFF);
      else if (act === "dry") await fgSet(token, p.operation_mode.key, DRY);
      else if (act === "fan") await fgSet(token, p.operation_mode.key, FAN);
      else if (act === "+") {
        await fgSet(
          token,
          p.adjust_temperature.key,
          Math.round(Math.min(TMAX, sp + 1) * 10),
        );
      } else if (act === "-") {
        await fgSet(
          token,
          p.adjust_temperature.key,
          Math.round(Math.max(TMIN, sp - 1) * 10),
        );
      } else if (act[0] === "f") {
        await fgSet(token, p.fan_speed.key, Number(act[1]));
      } else if (act === "vs") {
        await fgSet(
          token,
          p.af_vertical_swing.key,
          p.af_vertical_swing.value ? 0 : 1,
        );
      } else if (act === "vu") {
        await fgSet(token, p.af_vertical_swing.key, 0);
        await fgSet(
          token,
          p.af_vertical_direction.key,
          Math.max(1, p.af_vertical_direction.value - 1),
        );
      } else if (act === "vd") {
        await fgSet(token, p.af_vertical_swing.key, 0);
        await fgSet(
          token,
          p.af_vertical_direction.key,
          Math.min(VDIR_MAX, p.af_vertical_direction.value + 1),
        );
      }
      note = `${ROOMS[k].name.replace(/^\S+ /, "")}: ${act}`;
    }
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: note });
    const st = await readStates(token);
    await tg("editMessageReplyMarkup", {
      chat_id: chat,
      message_id: cb.message.message_id,
      reply_markup: panel(st),
    });
    return new Response("ok");
  }
  return new Response("ok");
}