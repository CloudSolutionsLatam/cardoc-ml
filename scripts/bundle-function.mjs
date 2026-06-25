// Bundla una Catalyst function (TS + sus workspace deps @cardoc/*) en un único
// `index.js` CommonJS desplegable. Resuelve la fricción monorepo↔Catalyst: el
// `catalyst deploy` instala solo los EXTERNALS desde el package.json de la función
// (express, zcatalyst-sdk-node) — el resto (domain, providers, persistence, application)
// queda inlineado en el bundle, sin `workspace:*` que npm no entiende.
//
// Uso: node scripts/bundle-function.mjs <nombre>   (cwd = carpeta de la función)
import { build } from "esbuild";
import { resolve } from "node:path";

const name = process.argv[2] ?? "function";
const cwd = process.cwd();

await build({
  entryPoints: [resolve(cwd, "src/index.ts")],
  outfile: resolve(cwd, "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  // SOLO zcatalyst-sdk-node es external: lo provee el runtime de Catalyst. El resto
  // (express, zod, @cardoc/*) se INLINEA — Catalyst NO instala las deps del package.json,
  // así que externalizar express daba "Cannot find module 'express'" en runtime.
  external: ["zcatalyst-sdk-node"],
  logLevel: "info",
});

console.log(`✓ bundled ${name} → index.js`);
