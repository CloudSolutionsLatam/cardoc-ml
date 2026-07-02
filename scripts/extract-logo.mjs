/**
 * Extrae el logo de marca Portal ML (Anexo A de `docs/reference/pdf-backend/planning.md`)
 * y lo materializa como constante base64 en `packages/providers/src/ml-logo.ts`.
 *
 * El data-URI del Anexo A es una sola línea gigante (44.548 chars); este script la extrae
 * sin cargarla en un editor. Re-correr si el Anexo A cambia:
 *   node scripts/extract-logo.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANNING = resolve(ROOT, "docs/reference/pdf-backend/planning.md");
const OUT = resolve(ROOT, "packages/providers/src/ml-logo.ts");

const md = readFileSync(PLANNING, "utf8");
const m = md.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
if (!m) {
  console.error("No se encontró el data-URI del logo en planning.md (Anexo A)");
  process.exit(1);
}
const b64 = m[1];

// Sanity: decodifica y valida la cabecera PNG (89 50 4E 47).
const bytes = Buffer.from(b64, "base64");
const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
if (!isPng) {
  console.error("El binario decodificado NO es un PNG válido");
  process.exit(1);
}

const header = `/**
 * Logo de marca **Portal ML** (\`logo-ml.png\`, PNG) como base64 — para la portada del PDF.
 *
 * Fuente: \`docs/reference/pdf-backend/planning.md\` Anexo A (data-URI verbatim del portal).
 * Es un asset de marca (no un secreto): viaja embebido para que el generador sea autocontenido
 * (sin lecturas de disco en runtime → funciona bundleado en la función Catalyst).
 * pdf-lib lo consume directo con \`embedPng(ML_LOGO_PNG_BASE64)\` (acepta base64 sin prefijo data-URI).
 * Generado por \`scripts/extract-logo.mjs\` (no editar a mano).
 */
export const ML_LOGO_PNG_BASE64 =
  "`;

writeFileSync(OUT, header + b64 + '";\n', "utf8");
console.log(`ml-logo.ts escrito (${b64.length} chars base64, ${bytes.length} bytes PNG)`);
