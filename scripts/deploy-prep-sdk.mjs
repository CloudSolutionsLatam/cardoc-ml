// Materializa los EXTERNALS del bundle como node_modules REAL en el function dir.
//
// esbuild deja `zcatalyst-sdk-node` como `require` externo (hace require dinámicos de
// submódulos que no puede inlinar). pnpm resuelve esa dep como SYMLINK dentro del
// node_modules del function, y `catalyst deploy` zippea el directorio: el symlink apunta
// FUERA del zip → en runtime da "Cannot find module 'zcatalyst-sdk-node'" (o './zcql/zcql').
// Este script instala el/los external(es) como ARCHIVOS reales (con sus transitivas) en
// <function>/node_modules, para que viajen en el zip.
//
// Idempotente: re-materializa siempre (necesario tras un `pnpm install`, que restaura el
// symlink de pnpm y "des-materializa" lo que dejó este script).
//
// Uso: node ../../../../scripts/deploy-prep-sdk.mjs   (cwd = carpeta de la función)
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXTERNALS } from "./function-externals.mjs";

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
const deps = pkg.dependencies ?? {};

// Versión EXACTA de cada external, tomada del package.json del function (fuente de verdad).
const wanted = {};
for (const name of EXTERNALS) {
  const version = deps[name];
  if (!version) {
    throw new Error(`external "${name}" no figura en dependencies de ${pkg.name}`);
  }
  wanted[name] = version;
}

// Staging aislado: package.json mínimo con SOLO los externals (sin las workspace:* que npm
// no entiende) → npm resuelve el closure completo (external + transitivas) como archivos flat.
const stage = join(tmpdir(), "cardoc-sdk-stage");
mkdirSync(stage, { recursive: true });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "cardoc-sdk-stage", version: "1.0.0", dependencies: wanted }, null, 2),
);

const baseOpts = process.env.NODE_OPTIONS ?? "";
const nodeOptions = baseOpts.includes("--use-system-ca") ? baseOpts : `${baseOpts} --use-system-ca`.trim();

console.log(`→ instalando externals reales: ${Object.entries(wanted).map(([n, v]) => `${n}@${v}`).join(", ")}`);
execSync("npm install --no-audit --no-fund --omit=dev", {
  cwd: stage,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

// Copia cada paquete real al node_modules del function, reemplazando el symlink de pnpm.
const stageNM = join(stage, "node_modules");
const fnNM = resolve(cwd, "node_modules");
mkdirSync(fnNM, { recursive: true });

let copied = 0;
for (const entry of readdirSync(stageNM, { withFileTypes: true })) {
  if (entry.name.startsWith(".")) continue; // .package-lock.json, .bin
  const dest = join(fnNM, entry.name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(stageNM, entry.name), dest, { recursive: true });
  copied++;
}
console.log(`✓ materializados ${copied} paquetes reales en ${pkg.name}/node_modules (external + transitivas)`);
