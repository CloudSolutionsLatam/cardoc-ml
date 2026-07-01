// Bundla una Catalyst function (TS + sus workspace deps @cardoc/*) en un único
// `index.js` CommonJS desplegable. Resuelve la fricción monorepo↔Catalyst: el
// `catalyst deploy` instala solo los EXTERNALS desde el package.json de la función
// (express, zcatalyst-sdk-node) — el resto (domain, providers, persistence, application)
// queda inlineado en el bundle, sin `workspace:*` que npm no entiende.
//
// Uso: node scripts/bundle-function.mjs <nombre>   (cwd = carpeta de la función)
import { build } from "esbuild";
import { resolve } from "node:path";
import { EXTERNALS } from "./function-externals.mjs";

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
  // Los EXTERNALS (ver scripts/function-externals.mjs) NO se inlinan: `zcatalyst-sdk-node` hace
  // `require` dinámicos de submódulos (`./zcql/zcql`) que esbuild no puede resolver. Se shippean
  // como node_modules REAL en el function dir vía scripts/deploy-prep-sdk.mjs (los symlinks de
  // pnpm se rompen al zipear) — ver ADR-0010. El resto (express, zod, @cardoc/*) SÍ se inlinea
  // (Catalyst no instala deps del package.json).
  external: EXTERNALS,
  logLevel: "info",
});

console.log(`✓ bundled ${name} → index.js`);
