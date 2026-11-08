// FGLair (Ayla, cloud dei condizionatori Fujitsu): login, proprietà, scrittura.
// Ogni chiamata ha un limite di tempo, così un cloud lento non blocca chi la usa (telecomando del Kindle).
const SIGNIN = "https://user-field-eu.aylanetworks.com/users/sign_in.json";
const BASE = "https://ads-field-eu.aylanetworks.com/apiv1/";
const APP_ID = "FGLair-eu-id";
const APP_SECRET = "FGLair-eu-gpFbVBRoiJ8E3QWJ-QRULLL3j3U";

export const OFF = 0, AUTO = 2, COOL = 3, DRY = 4, FAN = 5, HEAT = 6;
export type Props = Record<string, { key: number; value: number }>;

export async function fgLogin(email: string, password: string, ms = 4000): Promise<string> {
  const r = await fetch(SIGNIN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: { email, password, application: { app_id: APP_ID, app_secret: APP_SECRET } } }),
    signal: AbortSignal.timeout(ms),
  });
  const tok = (await r.json()).access_token;
  if (!tok) throw new Error("login FGLair rifiutato");
  return tok;
}

export async function fgProps(token: string, dsn: string, ms = 4000): Promise<Props> {
  const r = await fetch(BASE + `dsns/${dsn}/properties.json`, {
    headers: { Authorization: "auth_token " + token },
    signal: AbortSignal.timeout(ms),
  });
  const m: Props = {};
  for (const p of await r.json()) {
    if (p.property) m[p.property.name] = { key: p.property.key, value: p.property.value };
  }
  return m;
}

export async function fgSet(token: string, key: number, value: number, ms = 4000): Promise<void> {
  const r = await fetch(BASE + `properties/${key}/datapoints.json`, {
    method: "POST",
    headers: { Authorization: "auth_token " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ datapoint: { value: String(value) } }),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`FGLair ${r.status}`);
}
