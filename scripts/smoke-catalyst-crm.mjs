// Probe del alta REAL sobre la función DESPLEGADA en modo datastore + zoho.
// Crea registros reales en el CRM (Cuenta ML). Usá NroSolicitud frescos cada corrida.
// Uso: NODE_OPTIONS=--use-system-ca NRO=908870 node scripts/smoke-catalyst-crm.mjs
const base = process.env.BASE || "https://ml-909785950.development.catalystserverless.com/server/api";
const NRO = Number(process.env.NRO || 908870);
const KEY = process.env.IDEMKEY || `ml-${NRO}`;

const AUTH = { "X-Api-Key": "test-token", "Content-Type": "application/json" };
const H = { ...AUTH, "X-Idempotency-Key": KEY };
const body = (n) => ({
  NroCedula: 45321890, NroSolicitud: n, Nombres: "Juan Carlos", Apellidos: "Pérez Rodríguez",
  CelularCliente: "099123456", MarcaVehiculo: "Chevrolet", ModeloVehiculo: "Onix",
  AnioVehiculo: 2022, MatriculaVehiculo: "SBA1234",
});

let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n + "  " + x)));

console.log(`base = ${base} · NroSolicitud = ${NRO}/${NRO + 1} · idem-key = ${KEY}\n`);

// Warm-up (cold start)
for (let i = 0; i < 10; i++) {
  try { const r = await fetch(`${base}/v1/health`); if (r.status === 200) break; } catch { /* retry */ }
  await new Promise((s) => setTimeout(s, 2500));
}

// Capa 2 (sin header) — dedup del CRM por EXTERNAL_ID
let r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: AUTH, body: JSON.stringify(body(NRO)) });
let j = await r.json().catch(() => ({}));
check(`POST sin header (NroSolicitud=${NRO}) → 201 created`, r.status === 201 && j.status === "created", `${r.status} ${JSON.stringify(j)}`);
const oppId = j?.opportunity?.id;
check(`  stage 'Nueva Solicitud'`, j?.opportunity?.stage === "Nueva Solicitud");

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: AUTH, body: JSON.stringify(body(NRO)) });
j = await r.json().catch(() => ({}));
check(`POST repetido (sin header) → 200 duplicate, mismo Deal`, r.status === 200 && j.status === "duplicate" && j?.opportunity?.id === oppId, `${r.status} ${JSON.stringify(j)}`);

// Capa 1 (con X-Idempotency-Key) — DataStore en Catalyst
r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: H, body: JSON.stringify(body(NRO + 1)) });
j = await r.json().catch(() => ({}));
check(`POST con idem-key → 201 created (Capa 1)`, r.status === 201 && j.status === "created", `${r.status} ${JSON.stringify(j)}`);

r = await fetch(`${base}/v1/opportunity-contact`, { method: "POST", headers: H, body: JSON.stringify({ ...body(NRO + 1), MarcaVehiculo: "Fiat" }) });
j = await r.json().catch(() => ({}));
check(`POST misma idem-key + payload distinto → 409 (Capa 1)`, r.status === 409 && j?.error?.code === "IDEMPOTENCY_CONFLICT", `${r.status} ${JSON.stringify(j)}`);

console.log(`\nRESULT (Catalyst CRM real): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
