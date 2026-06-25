// Smoke e2e LOCAL — levanta el app Express compilado (dist) en proceso y verifica los
// 3 endpoints + la ruta interna, sin Catalyst. Requiere build previo (`pnpm exec tsc -b`).
// Uso: pnpm smoke
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = require(resolve(root, "apps/catalyst/functions/api/dist/index.js"));

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}  ${extra}`));

const AUTH = { "X-Api-Key": "test-token" };
const body = { contact: { documento: "1.234.567-8", nombre: "Ana Pérez" }, opportunity: { nombre: "Revisión VW Amarok" } };

let r = await fetch(`${base}/v1/health`);
check("GET /v1/health → 200", r.status === 200);

r = await fetch(`${base}/v1/informes`);
let j = await r.json();
check("GET /v1/informes sin token → 401", r.status === 401, `got ${r.status}`);
check("  sobre de error con code", j?.error?.code === "UNAUTHENTICATED", JSON.stringify(j));

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body) });
j = await r.json();
check("POST sin X-Idempotency-Key → 400 VALIDATION_ERROR", r.status === 400 && j?.error?.code === "VALIDATION_ERROR", `got ${r.status}`);

const idem = { ...AUTH, "Content-Type": "application/json", "X-Idempotency-Key": "key-001" };
r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: idem, body: JSON.stringify(body) });
j = await r.json();
check("POST opportunity-contact → 201 created", r.status === 201 && j.status === "created", `got ${r.status} ${JSON.stringify(j)}`);
check("  stage = 'Agendamiento Ready' (server-side)", j?.opportunity?.stage === "Agendamiento Ready");
check("  X-Correlation-Id presente", Boolean(r.headers.get("x-correlation-id")));

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: idem, body: JSON.stringify(body) });
j = await r.json();
check("POST repetido misma clave → 200 duplicate", r.status === 200 && j.status === "duplicate", `got ${r.status}`);

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: idem, body: JSON.stringify({ ...body, opportunity: { nombre: "Otra" } }) });
j = await r.json();
check("POST misma clave + payload distinto → 409", r.status === 409 && j?.error?.code === "IDEMPOTENCY_CONFLICT", `got ${r.status}`);

r = await fetch(`${base}/v1/informes`, { headers: AUTH });
j = await r.json();
check("GET /v1/informes → 200 con data[]", r.status === 200 && Array.isArray(j.data), `got ${r.status}`);
check("  header X-Cap-Remaining presente", Boolean(r.headers.get("x-cap-remaining")));

r = await fetch(`${base}/v1/informes?accountId=acc_otra`, { headers: AUTH });
j = await r.json();
check("GET /v1/informes?accountId=... → 422 (allowlist estricta)", r.status === 422 && j?.error?.code === "UNPROCESSABLE", `got ${r.status}`);

r = await fetch(`${base}/v1/informes/acc_dev-INF-001/pdf`, { headers: AUTH });
const buf = Buffer.from(await r.arrayBuffer());
check("GET /v1/informes/:id/pdf → 200 application/pdf", r.status === 200 && r.headers.get("content-type") === "application/pdf", `got ${r.status}`);
check("  Cache-Control: no-store", r.headers.get("cache-control") === "no-store");
check("  cuerpo es un PDF (stream)", buf.toString("utf8").startsWith("%PDF"));

r = await fetch(`${base}/v1/informes/acc_otra-INF-999/pdf`, { headers: AUTH });
j = await r.json().catch(() => ({}));
check("GET pdf de informe ajeno → 404 NOT_FOUND (tenancy)", r.status === 404 && j?.error?.code === "NOT_FOUND", `got ${r.status}`);

r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nroSolicitud: 908812, stage: "Coordinación" }) });
check("POST /v1/internal/deal-estado sin secret → 401", r.status === 401, `got ${r.status}`);

const INT = { "Content-Type": "application/json", "x-internal-secret": "dev-internal-secret" };
r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ nroSolicitud: 908812, stage: "Coordinación" }) });
j = await r.json();
check("POST internal con secret → 200 skipped (stage sin mapear)", r.status === 200 && j.status === "skipped", `got ${r.status} ${JSON.stringify(j)}`);

r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ stage: "X" }) });
j = await r.json();
check("POST internal sin nroSolicitud → 400 VALIDATION_ERROR", r.status === 400 && j?.error?.code === "VALIDATION_ERROR", `got ${r.status}`);

console.log(`\nRESULT (local): ${pass} passed, ${fail} failed`);
server.close();
process.exit(fail === 0 ? 0 : 1);
