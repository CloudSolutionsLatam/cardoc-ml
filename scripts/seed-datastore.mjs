// Seed del DataStore de Catalyst via la REST ADMIN API (sin SDK, sin bucket de Stratus, sin ZAID).
//
// Endpoint documentado: POST https://api.catalyst.zoho.com/baas/v1/project/{project_id}/table/{tabla}/row
// Auth: header "Authorization: Zoho-oauthtoken <access_token>". El access token se obtiene refrescando
// el self-client (scope ZohoCatalyst.tables.rows.*). Idempotente: GET de las filas -> dedupe -> POST
// solo lo que falta. Reutilizable (prod/re-seeds).
//
// Uso:
//   NODE_OPTIONS=--use-system-ca node --env-file=.env scripts/seed-datastore.mjs consumer_caps
//   (tabla opcional; default consumer_caps. Tambien: consumers)
//
// Env vars (NUNCA al repo; van en .env gitignored):
//   CATALYST_REFRESH_TOKEN            - refresh token con scope ZohoCatalyst.tables.rows.CREATE/READ.
//   CATALYST_CLIENT_ID / _SECRET      - self-client (fallback a ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET).
//   CATALYST_ACCESS_TOKEN             - (alternativa one-shot) access token directo, sin refresh.
//   CATALYST_PROJECT_ID   (default 57305000000083001)
//   CATALYST_ACCOUNTS_URL (default https://accounts.zoho.com)  - DC del self-client.
//   CATALYST_API_ORIGIN   (default https://api.catalyst.zoho.com)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

const TABLES = {
  consumer_caps: { csv: "scripts/datastore-bootstrap/consumer_caps.csv", key: ["consumer_id", "endpoint"] },
  consumers: { csv: "scripts/datastore-bootstrap/consumers.csv", key: ["consumer_id"] },
};

const tableName = process.argv[2] ?? "consumer_caps";
const spec = TABLES[tableName];
if (!spec) {
  console.error(`Tabla no soportada: ${tableName}. Opciones: ${Object.keys(TABLES).join(", ")}`);
  process.exit(1);
}

const clientId = env.CATALYST_CLIENT_ID ?? env.ZOHO_CLIENT_ID;
const clientSecret = env.CATALYST_CLIENT_SECRET ?? env.ZOHO_CLIENT_SECRET;
const refreshToken = env.CATALYST_REFRESH_TOKEN;
const accessTokenEnv = env.CATALYST_ACCESS_TOKEN;
const projectId = env.CATALYST_PROJECT_ID ?? "57305000000083001";
const accountsUrl = (env.CATALYST_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/$/, "");
const apiOrigin = (env.CATALYST_API_ORIGIN ?? "https://api.catalyst.zoho.com").replace(/\/$/, "");

if (!accessTokenEnv && !(clientId && clientSecret && refreshToken)) {
  console.error("Falta: CATALYST_ACCESS_TOKEN  o  (CATALYST_CLIENT_ID + CATALYST_CLIENT_SECRET + CATALYST_REFRESH_TOKEN)");
  process.exit(1);
}

const ROW_URL = `${apiOrigin}/baas/v1/project/${projectId}/table/${tableName}/row`;

/** Refresca el self-client -> access token (o usa el directo). */
async function getAccessToken() {
  if (accessTokenEnv) return accessTokenEnv;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error(`refresh del token fallo (${res.status}): ${JSON.stringify(json)}`);
  return json.access_token;
}

/** Llama la REST admin del DataStore; parsea el sobre {status,data} de Catalyst. */
async function api(method, token, payload) {
  const res = await fetch(ROW_URL, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${res.status}: respuesta no-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.status === "failure") {
    throw new Error(`${method} ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

/** Parsea CSV simple -> filas objeto; Int para columnas numericas, omite celdas vacias. */
function parseCsv(path) {
  const [header, ...lines] = readFileSync(resolve(root, path), "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.filter(Boolean).map((line) => {
    const vals = line.split(",");
    const row = {};
    cols.forEach((c, i) => {
      const v = vals[i];
      if (v !== undefined && v !== "") row[c] = /^\d+$/.test(v) ? Number(v) : v;
    });
    return row;
  });
}

const rows = parseCsv(spec.csv);
const keyOf = (r) => spec.key.map((k) => String(r[k])).join("|");

async function main() {
  console.log(`Seed -> tabla '${tableName}' (proyecto ${projectId}) via REST admin`);
  const token = await getAccessToken();

  // Dedupe: leer filas existentes.
  const existing = await api("GET", token);
  const seen = new Set((existing.data ?? []).map(keyOf));

  const toInsert = rows.filter((r) => !seen.has(keyOf(r)));
  if (!toInsert.length) {
    console.log(`Nada que hacer: las ${rows.length} filas ya estaban cargadas.`);
    return;
  }
  const out = await api("POST", token, toInsert);
  for (const r of toInsert) console.log(`  + ${JSON.stringify(r)}`);
  console.log(`\nOK: ${toInsert.length} fila(s) insertada(s); ${seen.size} ya existian. (status: ${out.status})`);
}

main().catch((e) => {
  console.error("\nFallo el seed:", e?.message ?? e);
  process.exit(1);
});
