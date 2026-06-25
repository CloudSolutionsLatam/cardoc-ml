// Servidor local de desarrollo — corre la API SIN Catalyst (no depende del hosting).
//
// La Catalyst Advanced I/O Function exporta el app Express (`export = app`) y es Catalyst
// quien normalmente lo escucha. Acá lo escuchamos nosotros: el mismo `app`, standalone.
// Lo único atado a Catalyst es el adapter DataStore (solo con CARDOC_PERSISTENCE=datastore);
// en modo memory/mock esto corre 100% local.
//
// Uso: pnpm dev   (compila con tsc -b y carga .env si existe vía --env-file-if-exists)
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = resolve(root, "apps/catalyst/functions/api/dist/index.js");

let app;
try {
  app = require(appPath);
} catch (e) {
  console.error(`✗ No pude cargar ${appPath}.`);
  console.error(`  ¿Corriste el build? -> pnpm exec tsc -b`);
  console.error(`  ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// 3030 por defecto (no 3000: ese suele estar tomado por la API del ERP — NestJS).
const port = Number(process.env.PORT ?? 3030);
const server = app.listen(port, () => {
  const modo = {
    persistencia: process.env.CARDOC_PERSISTENCE ?? "memory",
    crm: process.env.CARDOC_CRM_MODE ?? "mock",
    reports: process.env.CARDOC_REPORTS_MODE ?? "mock",
    ml: process.env.CARDOC_ML_MODE ?? "mock",
  };
  console.log(`\n  cardoc API (local, sin Catalyst) → http://127.0.0.1:${port}`);
  console.log(`  modo: ${JSON.stringify(modo)}`);
  console.log(`  health: curl http://127.0.0.1:${port}/v1/health`);
  if (modo.persistencia !== "datastore") {
    console.log(`  token dev: Authorization: Bearer test-token  (Cuenta acc_dev, todos los scopes)\n`);
  }
});

server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error(`✗ puerto ${port} ocupado. Probá con otro: PORT=3031 pnpm dev`);
    process.exit(1);
  }
  throw e;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
