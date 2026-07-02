// Instrumento de sembrado de caps (decisión §10 D6, mail Cardoc 2026-07-02).
//
// ÚNICA FUENTE DE VERDAD de los límites por consumidor+endpoint: editá `CAPS` y corré
// `node scripts/seed-caps.mjs`. Regenera `datastore-bootstrap/consumer_caps.csv` (para el
// import de columnas / carga en consola) e imprime las filas listas para "Add Row".
//
// Mapeo endpoint → label de cap() en app.ts: POST=opportunity-contact, GET informes=informes-list,
// GET PDF=informes-pdf. Ventana: el mail fijó SOLO la horaria; day/week quedan vacíos → el código
// cae a los defaults de env (CARDOC_CAP_DEFAULT_DAY/WEEK) como guardrail no vinculante.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONSUMER_ID = "consumer_ml"; // Cuenta ML (única automotora hoy). Un consumer_id por integración.

/** limit_hour por endpoint. day/week: "" = sin override (usa el default de env). */
const CAPS = [
  { endpoint: "opportunity-contact", hour: 60, day: "", week: "" }, // POST alta
  { endpoint: "informes-list", hour: 120, day: "", week: "" }, //     GET /informes (Endpoint 2, hoy diferido)
  { endpoint: "informes-pdf", hour: 100, day: "", week: "" }, //      GET /informes/:id/pdf
];

const HEADER = "consumer_id,endpoint,limit_hour,limit_day,limit_week";
const rows = CAPS.map((c) => `${CONSUMER_ID},${c.endpoint},${c.hour},${c.day},${c.week}`);

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "datastore-bootstrap", "consumer_caps.csv");
writeFileSync(outPath, `${HEADER}\n${rows.join("\n")}\n`, "utf8");

console.log(`✓ ${outPath} regenerado con ${CAPS.length} filas.\n`);
console.log("Catalyst Console → Data Store → tabla `consumer_caps` → Add Row (una por endpoint):");
for (const c of CAPS) {
  console.log(
    `  consumer_id=${CONSUMER_ID}  endpoint=${c.endpoint}  limit_hour=${c.hour}` +
      `  limit_day=${c.day || "(vacío→default)"}  limit_week=${c.week || "(vacío→default)"}`,
  );
}
console.log("\nPara cambiar valores: editá CAPS arriba y re-ejecutá. En dev/memory los caps caen a defaults (no se siembran).");
