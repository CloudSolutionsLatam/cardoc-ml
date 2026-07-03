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
const JSONH = { ...AUTH, "Content-Type": "application/json" };
const body = { NroCedula: 45321890, NroSolicitud: 908812, Nombres: "Juan Carlos", Apellidos: "Pérez Rodríguez", CelularCliente: "099123456", MarcaVehiculo: "Chevrolet", ModeloVehiculo: "Onix", AnioVehiculo: 2022, MatriculaVehiculo: "SBA1234" };

let r = await fetch(`${base}/v1/health`);
check("GET /v1/health → 200", r.status === 200);

r = await fetch(`${base}/v1/informes`);
let j = await r.json();
check("GET /v1/informes sin token → 401", r.status === 401, `got ${r.status}`);
check("  sobre de error con code", j?.error?.code === "UNAUTHENTICATED", JSON.stringify(j));

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: JSONH, body: JSON.stringify({ NroCedula: 1, Nombres: "A", Apellidos: "B" }) });
j = await r.json();
check("POST sin NroSolicitud → 400 VALIDATION_ERROR", r.status === 400 && j?.error?.code === "VALIDATION_ERROR", `got ${r.status}`);

const IDEM = { ...JSONH, "X-Idempotency-Key": "smoke-908812" }; // header opcional → activa Capa 1 (Catalyst)

// Capa 1 (con X-Idempotency-Key): created → duplicate → conflict
r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: IDEM, body: JSON.stringify(body) });
j = await r.json();
check("POST (con idem-key) → 201 created", r.status === 201 && j.status === "created", `got ${r.status} ${JSON.stringify(j)}`);
check("  stage = 'Nueva Solicitud' (server-side)", j?.opportunity?.stage === "Nueva Solicitud");
check("  X-Correlation-Id presente", Boolean(r.headers.get("x-correlation-id")));

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: IDEM, body: JSON.stringify(body) });
j = await r.json();
check("POST repetido misma idem-key → 200 duplicate (Capa 1)", r.status === 200 && j.status === "duplicate", `got ${r.status}`);

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: IDEM, body: JSON.stringify({ ...body, MarcaVehiculo: "Fiat" }) });
j = await r.json();
check("POST misma idem-key + payload distinto → 409 (Capa 1)", r.status === 409 && j?.error?.code === "IDEMPOTENCY_CONFLICT", `got ${r.status}`);

// Capa 2 (sin header): dedup en el CRM por EXTERNAL_ID
const body2 = { ...body, NroSolicitud: 908899 };
r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: JSONH, body: JSON.stringify(body2) });
j = await r.json();
check("POST sin header (NroSolicitud nuevo) → 201 created (Capa 2)", r.status === 201 && j.status === "created", `got ${r.status}`);

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: JSONH, body: JSON.stringify(body2) });
j = await r.json();
check("POST repetido sin header → 200 duplicate (Capa 2, dedup CRM)", r.status === 200 && j.status === "duplicate", `got ${r.status}`);

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

r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nroSolicitud: 908812, stage: "Nueva Solicitud" }) });
check("POST /v1/internal/deal-estado sin secret → 401", r.status === 401, `got ${r.status}`);

const INT = { "Content-Type": "application/json", "x-internal-secret": "dev-internal-secret" };
r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ nroSolicitud: 908812, stage: "Nueva Solicitud" }) });
j = await r.json();
check("POST internal 'Nueva Solicitud' → 200 sent PENDIENTE", r.status === 200 && j.status === "sent" && j.estado === "PENDIENTE", `got ${r.status} ${JSON.stringify(j)}`);

r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ nroSolicitud: 908812, stage: "Cancelado" }) });
j = await r.json();
check("POST internal 'Cancelado' → 200 skipped (stage no notificable)", r.status === 200 && j.status === "skipped", `got ${r.status} ${JSON.stringify(j)}`);

// Mapeo B2B real (E-07): Agendado B2B → COORDINACIÓN (ML en modo mock).
r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ nroSolicitud: 908812, stage: "Agendado B2B" }) });
j = await r.json();
check("POST internal 'Agendado B2B' → 200 sent COORDINACIÓN", r.status === 200 && j.status === "sent" && j.estado === "COORDINACIÓN", `got ${r.status} ${JSON.stringify(j)}`);

// FINALIZADO sin LinkResultado → 422 (validación de dominio, NO 502: ML nunca se llama).
r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ nroSolicitud: 908812, stage: "Completado" }) });
j = await r.json();
check("POST internal 'Completado' sin LinkResultado → 422 UNPROCESSABLE", r.status === 422 && j?.error?.code === "UNPROCESSABLE", `got ${r.status} ${JSON.stringify(j)}`);

r = await fetch(`${base}/v1/internal/deal-estado`, { method: "POST", headers: INT, body: JSON.stringify({ stage: "X" }) });
j = await r.json();
check("POST internal sin nroSolicitud → 400 VALIDATION_ERROR", r.status === 400 && j?.error?.code === "VALIDATION_ERROR", `got ${r.status}`);

console.log(`\nRESULT (local): ${pass} passed, ${fail} failed`);
server.close();
process.exit(fail === 0 ? 0 : 1);
