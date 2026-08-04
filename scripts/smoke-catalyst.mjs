// Smoke e2e contra la función DESPLEGADA en Catalyst.
// Uso: NODE_OPTIONS=--use-system-ca pnpm smoke:catalyst   (la CA del sistema es necesaria
// en la red corporativa). Los defaults asumen dev en modo memory+mock (fixture `test-token`).
// Overrides para entornos con datastore/adapters reales (dev real o prod post-promoción):
//   BASE=<url>                 destino (prod: sin `.development`)
//   SMOKE_TOKEN=<token>        X-Api-Key de un consumidor REAL sembrado en consumer_tokens
//   SMOKE_NRO=<n>              NroSolicitud base ÚNICO por corrida (datastore persiste: reusar
//                              el mismo n convierte los `created` esperados en `duplicate`)
//   SMOKE_INFORME_ID=<id>      informe existente de la cuenta del token, para el check del PDF
// OJO en prod con CRM real: el POST crea Contacto+Deal de verdad — usar datos de prueba (§2 OPERACIONES).
const base = process.env.BASE || "https://ml-909785950.development.catalystserverless.com/server/api";
let pass = 0, fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}  ${extra}`));

const AUTH = { "X-Api-Key": process.env.SMOKE_TOKEN || "test-token" };
const JSONH = { ...AUTH, "Content-Type": "application/json" };
const NRO = Number(process.env.SMOKE_NRO) || 908812;
const INFORME_ID = process.env.SMOKE_INFORME_ID || "acc_dev-INF-001";
const body = { NroCedula: 45321890, NroSolicitud: NRO, Nombres: "Juan Carlos", Apellidos: "Pérez Rodríguez", CelularCliente: "099123456", MarcaVehiculo: "Chevrolet", ModeloVehiculo: "Onix", AnioVehiculo: 2022, MatriculaVehiculo: "SBA1234" };

console.log(`base = ${base}\n`);

// Warm-up (cold start): reintentar health hasta 200.
for (let i = 1; i <= 10; i++) {
  try { const r = await fetch(`${base}/v1/health`); if (r.status === 200) break; } catch { /* retry */ }
  await new Promise((s) => setTimeout(s, 2500));
}

let r = await fetch(`${base}/v1/health`);
let j = await r.json().catch(() => ({}));
check("GET /v1/health → 200 {status:ok}", r.status === 200 && j.status === "ok", `${r.status}`);

r = await fetch(`${base}/v1/informes`);
check("GET /v1/informes sin token → 401", r.status === 401, `${r.status}`);

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: JSONH, body: JSON.stringify(body) });
j = await r.json().catch(() => ({}));
check("POST opportunity-contact → 201 created", r.status === 201 && j.status === "created", `${r.status} ${JSON.stringify(j)}`);
check("  stage 'Nueva Solicitud' server-side", j?.opportunity?.stage === "Nueva Solicitud");
check("  X-Correlation-Id presente", Boolean(r.headers.get("x-correlation-id")));

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: JSONH, body: JSON.stringify(body) });
j = await r.json().catch(() => ({}));
check("POST repetido mismo NroSolicitud (sin header) → 200 duplicate (Capa 2)", r.status === 200 && j.status === "duplicate", `${r.status}`);

// Capa 1 (con X-Idempotency-Key): created → conflict (misma clave, payload distinto).
// La key incorpora el NRO para que cada corrida con SMOKE_NRO nuevo estrene key (datastore persiste).
const IDEM = { ...JSONH, "X-Idempotency-Key": `smoke-cat-${NRO}` };
const body1 = { ...body, NroSolicitud: NRO + 38 };
r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: IDEM, body: JSON.stringify(body1) });
j = await r.json().catch(() => ({}));
check("POST con idem-key → 201 created (Capa 1)", r.status === 201 && j.status === "created", `${r.status} ${JSON.stringify(j)}`);

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: IDEM, body: JSON.stringify({ ...body1, MarcaVehiculo: "Fiat" }) });
j = await r.json().catch(() => ({}));
check("POST misma idem-key + payload distinto → 409 (Capa 1)", r.status === 409 && j?.error?.code === "IDEMPOTENCY_CONFLICT", `${r.status}`);

r = await fetch(`${base}/v1/informes`, { headers: AUTH });
j = await r.json().catch(() => ({}));
check("GET /v1/informes → 200 data[]", r.status === 200 && Array.isArray(j.data), `${r.status}`);
check("  X-Cap-Remaining presente", Boolean(r.headers.get("x-cap-remaining")));

r = await fetch(`${base}/v1/informes/${INFORME_ID}/pdf`, { headers: AUTH });
const buf = Buffer.from(await r.arrayBuffer());
check("GET /v1/informes/:id/pdf → 200 application/pdf (streaming)", r.status === 200 && r.headers.get("content-type") === "application/pdf", `${r.status} ${r.headers.get("content-type")}`);
check("  cuerpo es un PDF (%PDF)", buf.toString("utf8").startsWith("%PDF"));
check("  Cache-Control: no-store", r.headers.get("cache-control") === "no-store");

r = await fetch(`${base}/v1/informes/acc_otra-INF-9/pdf`, { headers: AUTH });
j = await r.json().catch(() => ({}));
check("PDF de cuenta ajena → 404 NOT_FOUND (tenancy)", r.status === 404 && j?.error?.code === "NOT_FOUND", `${r.status}`);

console.log(`\nRESULT (Catalyst): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
