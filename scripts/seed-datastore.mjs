// Seed del DataStore de Catalyst VIA SDK (sin consola, sin bucket de Stratus).
//
// Usa `zcatalyst-sdk-node` en modo STANDALONE con una credencial OAuth de scope ZohoCatalyst
// (RefreshToken o AccessToken). Reutiliza el self-client (client_id/secret) con un refresh token
// nuevo acunado para Catalyst. Idempotente: dedupea contra lo ya cargado (getPagedRows) e inserta
// solo lo que falta. Reutilizable para prod/re-seeds.
//
// Uso:
//   CATALYST_REFRESH_TOKEN=... CATALYST_PROJECT_KEY=<ZAID> \
//   CATALYST_CLIENT_ID=... CATALYST_CLIENT_SECRET=... \
//   node scripts/seed-datastore.mjs consumer_caps
//
//   (tabla opcional; default consumer_caps. Tambien: consumers)
//   Alternativa one-shot: CATALYST_ACCESS_TOKEN=... (en vez del refresh).
//
// Env vars (NUNCA al repo):
//   CATALYST_CLIENT_ID / CATALYST_CLIENT_SECRET  - self-client (fallback a ZOHO_CLIENT_ID/SECRET).
//   CATALYST_REFRESH_TOKEN                        - refresh token con scope ZohoCatalyst.tables.ALL.
//   CATALYST_ACCESS_TOKEN                         - (alternativa) access token de corta vida.
//   CATALYST_PROJECT_ID    (default 57305000000083001)  - proyecto ML.
//   CATALYST_PROJECT_KEY   - ZAID del proyecto (Consola -> Project Settings). Obligatorio.
//   CATALYST_ENVIRONMENT   (default Development)
//   CATALYST_ORG_ID        (default 909785950)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Config por tabla: CSV fuente + columnas que forman la clave de dedup.
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

const env = process.env;
const clientId = env.CATALYST_CLIENT_ID ?? env.ZOHO_CLIENT_ID;
const clientSecret = env.CATALYST_CLIENT_SECRET ?? env.ZOHO_CLIENT_SECRET;
const refreshToken = env.CATALYST_REFRESH_TOKEN;
const accessToken = env.CATALYST_ACCESS_TOKEN;
const projectId = env.CATALYST_PROJECT_ID ?? "57305000000083001";
const projectKey = env.CATALYST_PROJECT_KEY;
const environment = env.CATALYST_ENVIRONMENT ?? "Development";

// El SDK lee el org id de esta env var para rutear la request.
env.X_ZOHO_CATALYST_ORG_ID = env.CATALYST_ORG_ID ?? env.X_ZOHO_CATALYST_ORG_ID ?? "909785950";

const missing = [];
if (!projectKey) missing.push("CATALYST_PROJECT_KEY (ZAID del proyecto)");
if (!accessToken && !(clientId && clientSecret && refreshToken)) {
  missing.push("CATALYST_ACCESS_TOKEN  o  (CATALYST_CLIENT_ID + CATALYST_CLIENT_SECRET + CATALYST_REFRESH_TOKEN)");
}
if (missing.length) {
  console.error("Faltan env vars:\n  - " + missing.join("\n  - "));
  process.exit(1);
}

// SDK materializado en el function dir (external del bundle; ver deploy-prep-sdk.mjs).
const catalyst = require(resolve(root, "apps/catalyst/functions/api/node_modules/zcatalyst-sdk-node"));

const credential = accessToken
  ? catalyst.credential.accessToken({ access_token: accessToken })
  : catalyst.credential.refreshToken({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });

const app = catalyst.initializeApp({ project_id: projectId, project_key: projectKey, environment, credential }, "seed");

/** Parsea un CSV simple (sin comillas) -> filas objeto; Int para columnas numericas, omite celdas vacias. */
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
const keyOf = (r) => spec.key.map((k) => r[k]).join("");

async function main() {
  console.log(`Seed -> tabla '${tableName}' (proyecto ${projectId}, env ${environment})`);
  const table = app.datastore().table(tableName);

  // Dedupe: leer filas existentes (mismo scope que el insert: tables.rows.READ; sin ZCQL).
  const page = await table.getPagedRows({ maxRows: 200 });
  const seen = new Set((page.data ?? []).map((r) => spec.key.map((k) => String(r[k])).join("")));

  const toInsert = rows.filter((r) => !seen.has(keyOf(r)));
  if (!toInsert.length) {
    console.log(`Nada que hacer: las ${rows.length} filas ya estaban cargadas.`);
    return;
  }
  for (const r of toInsert) {
    await table.insertRow(r);
    console.log(`  + ${JSON.stringify(r)}`);
  }
  console.log(`\nOK: ${toInsert.length} fila(s) insertada(s); ${seen.size} ya existian.`);
}

main().catch((e) => {
  console.error("\nFallo el seed:", e?.message ?? e);
  if (/invalid|token|credential|scope/i.test(String(e?.message))) {
    console.error("  Revisa el refresh token (scope ZohoCatalyst.tables.ALL), el CATALYST_PROJECT_KEY (ZAID) y el DC del self-client.");
  }
  process.exit(1);
});
