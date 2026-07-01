---
title: "Playbook — Build y bundling del monorepo"
status: stable
last_reviewed: 2026-06-25
---

# Playbook — Build y bundling del monorepo

Este playbook explica cómo se construye `cardoc-ml`: un monorepo **pnpm + TypeScript** que compila un grafo de packages con `tsc -b` (project references) y, para desplegar, **bundlea** cada Catalyst function con esbuild en un único `index.js` CommonJS. Es el documento que `cfe-catalyst` referenciaba pero nunca se escribió.

Regla mental para no confundirse: **el monorepo se compila con `tsc -b`; Catalyst se despliega con un bundle de esbuild.** Son dos pipelines distintos y deliberados. El primero existe porque tenemos un grafo de dependencias internas; el segundo existe porque `catalyst deploy` no entiende `workspace:*`.

Toolchain verificado en verde: Node **24.13**, pnpm **10.29.2**. `.nvmrc` fija `24`; `package.json` raíz declara `packageManager: pnpm@10.29.2` y `engines.node >=20`, `engines.pnpm >=10`.

---

## 1. Topología del workspace (pnpm)

El workspace se define en `pnpm-workspace.yaml` con dos globs:

```yaml
packages:
  - "packages/*"
  - "apps/catalyst/functions/*"
```

Cada glob es un workspace independiente con su propio `package.json`. La separación es intencional:

| Glob | Qué contiene | Naturaleza |
|------|--------------|------------|
| `packages/*` | Librerías compartidas: `@cardoc/domain`, `@cardoc/providers`, `@cardoc/persistence`, `@cardoc/application` | Código de negocio, testeable, sin acoplar a la plataforma |
| `apps/catalyst/functions/*` | Catalyst Advanced I/O functions; hoy una sola: `@cardoc/fn-api` | Unidad desplegable; cada una se despliega por separado |

Las dependencias internas se declaran con el protocolo `workspace:*` de pnpm. Ejemplo, `@cardoc/application`:

```json
"dependencies": {
  "@cardoc/domain": "workspace:*",
  "@cardoc/persistence": "workspace:*",
  "@cardoc/providers": "workspace:*"
}
```

pnpm resuelve esos `workspace:*` con **symlinks** al package del propio monorepo en lugar de bajar nada del registry. Eso es excelente para desarrollar y compilar localmente — y es exactamente lo que rompe en deploy (ver §4): `workspace:*` no es un specifier que npm/Catalyst sepa instalar.

> El detalle de qué hace cada package (puertos, adapters, use-cases, separación de capas) vive en [`../../ARQUITECTURA.md`](../../ARQUITECTURA.md). Acá solo nos importa el grafo de build.

---

## 2. Compilación: TypeScript project references + `tsc -b`

### 2.1 Config compartida

`tsconfig.base.json` (raíz) es la base que **todo** package y función extiende. Lo relevante para el build incremental:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true,
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- `composite: true` es el flag que **habilita project references**. Obliga a `tsc` a emitir `.d.ts` (`declaration: true`) y a llevar un `.tsbuildinfo` por proyecto para saber qué recompilar.
- `declaration` + `declarationMap`: cada package publica sus tipos; los consumidores tipan contra el `.d.ts` del proveedor, no contra su `.ts`.

### 2.2 Cada package emite a su propio `dist/`

Un package típico (`packages/*/tsconfig.json`) solo fija dónde lee y dónde emite:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"]
}
```

Y su `package.json` apunta el campo `main`/`types` al `dist/` emitido — p.ej. `@cardoc/domain`:

```json
"main": "dist/index.js",
"types": "dist/index.d.ts"
```

`dist/` y `*.tsbuildinfo` están en `.gitignore`: son artefactos, no fuente.

### 2.3 El grafo de referencias

Cada proyecto declara contra quién compila vía `references`. Esto es lo que ordena la compilación. El grafo real:

```
@cardoc/domain        (hoja — Node puro, sin dependencias internas)
   ▲      ▲      ▲
   │      │      └──────────────┐
@cardoc/providers   @cardoc/persistence
   ▲                    ▲
   └────────┬───────────┘
       @cardoc/application   (references: domain, providers, persistence)
            ▲
       @cardoc/fn-api        (references: domain, providers, persistence, application)
```

`packages/application/tsconfig.json` referencia a sus tres dependencias:

```json
"references": [
  { "path": "../domain" },
  { "path": "../providers" },
  { "path": "../persistence" }
]
```

Y la función `apps/catalyst/functions/api/tsconfig.json` referencia a las cuatro:

```json
"references": [
  { "path": "../../../../packages/domain" },
  { "path": "../../../../packages/providers" },
  { "path": "../../../../packages/persistence" },
  { "path": "../../../../packages/application" }
]
```

### 2.4 El solution file y `tsc -b`

El `tsconfig.json` de la raíz **no compila nada por sí mismo**: es un *solution file* que solo enumera los proyectos. `files: []` lo deja sin código propio; `references` lista el grafo entero:

```json
{
  "files": [],
  "references": [
    { "path": "packages/domain" },
    { "path": "packages/providers" },
    { "path": "packages/persistence" },
    { "path": "packages/application" },
    { "path": "apps/catalyst/functions/api" }
  ]
}
```

Cuando corrés desde la raíz:

```bash
pnpm exec tsc -b
```

el modo build (`-b`) hace tres cosas que `tsc` plano no hace:

1. **Recorre el grafo y compila en orden topológico.** `domain` antes que `application`, `application` antes que `fn-api`. Un proyecto se compila contra los `.d.ts` ya emitidos de sus referencias — por eso el orden no es negociable, y por eso `composite`/`declaration` son obligatorios.
2. **Es incremental.** Con los `.tsbuildinfo` decide qué proyectos cambiaron y recompila solo eso.
3. **Falla rápido si una referencia no es `composite`** o si hay un ciclo.

Atajos equivalentes:

- `pnpm -r run build` recorre cada workspace y corre su script `build`. En los packages `build` es `tsc -b`; en la función es `tsc -b && node ../../../../scripts/bundle-function.mjs api` (ver §4).
- `pnpm -r run typecheck` es lo mismo en seco — solo chequea tipos, mismo grafo.

> El grafo de `tsc -b` y el grafo de `references` deben coincidir. Si agregás una dependencia interna nueva, actualizá **ambos**: el `dependencies` (`workspace:*`) del `package.json` y el `references` del `tsconfig.json`. Si no, `tsc -b` no la compila antes y vas a ver errores de `.d.ts` faltante.

---

## 3. Qué produce el build, paso a paso

| Etapa | Comando | Entrada | Salida |
|-------|---------|---------|--------|
| Compilar el monorepo | `pnpm exec tsc -b` | `packages/*/src`, `apps/.../api/src` | un `dist/` con `.js` + `.d.ts` por proyecto |
| Bundlear la función | `node scripts/bundle-function.mjs api` (cwd = carpeta de la función) | `apps/.../api/src/index.ts` + deps `@cardoc/*` | `apps/.../api/index.js` + `index.js.map` |
| Shipear el SDK real | `node scripts/deploy-prep-sdk.mjs` (cwd = carpeta de la función) | externals de `function-externals.mjs` | `apps/.../api/node_modules` con el SDK real (§4.4) |
| Desplegar | `catalyst deploy` | `index.js` + `node_modules` (SDK) + `catalyst-config.json` | función `api` en el env activo |

El comando que junta compilación + bundle es `build`; el que además materializa el SDK real y deja todo listo para deployar es `predeploy`, tal como lo declara `@cardoc/fn-api`:

```bash
pnpm --filter @cardoc/fn-api run build
# → tsc -b && node ../../../../scripts/bundle-function.mjs api  → index.js

pnpm --filter @cardoc/fn-api run predeploy
# → pnpm build && pnpm deploy:prep  (deploy:prep = node ../../../../scripts/deploy-prep-sdk.mjs)
```

`index.js` e `index.js.map` están **gitignored** (`apps/catalyst/functions/*/index.js`): se generan en cada deploy, no se versionan.

---

## 4. Por qué se bundlea con esbuild (la fricción monorepo ↔ Catalyst)

Esta es la decisión central del playbook.

### 4.1 El problema

Cuando `catalyst deploy` empaqueta una function, **no instala las dependencias** del `package.json` de la función: zipea el directorio tal como está y lo sube. Ese `package.json` tiene `@cardoc/*` declarados como `workspace:*`:

```json
"devDependencies": {
  "@cardoc/application": "workspace:*",
  "@cardoc/domain": "workspace:*",
  "@cardoc/persistence": "workspace:*",
  "@cardoc/providers": "workspace:*"
}
```

`workspace:*` es un specifier propio de pnpm que solo tiene sentido dentro del monorepo (resuelve por symlink) — no existe en ningún registry. Si desplegáramos el `tsc` plano (`dist/index.js` con `require("@cardoc/application")`), la función explotaría en runtime con `Cannot find module '@cardoc/application'`, porque en el runtime no hay ningún `@cardoc/*` (nadie los instaló ni viajaron en el zip). De ahí que todo lo interno tenga que quedar **inlineado** en el bundle.

### 4.2 La solución: inlinear TODO salvo el SDK, que se externaliza y se shippea

`scripts/bundle-function.mjs` corre esbuild con esta configuración exacta:

```js
import { EXTERNALS } from "./function-externals.mjs";

await build({
  entryPoints: [resolve(cwd, "src/index.ts")],
  outfile: resolve(cwd, "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  // Catalyst NO instala las deps del package.json: express, zod y los @cardoc/* se inlinan.
  // El SDK es la EXCEPCIÓN: no se puede inlinar (require dinámicos) → externalizado + shippeado.
  external: EXTERNALS, // ["zcatalyst-sdk-node"] — ver scripts/function-externals.mjs
  logLevel: "info",
});
```

La lista de externals **no** se escribe a mano en este script: vive en `scripts/function-externals.mjs`, que es la **fuente única** (la consumen tanto `bundle-function.mjs` como `deploy-prep-sdk.mjs`, ver §4.4). Hoy contiene un solo paquete: `zcatalyst-sdk-node`.

Decisiones, una por una:

| Opción | Valor | Por qué |
|--------|-------|---------|
| `bundle` | `true` | Sigue todos los `import` y los mete en un solo archivo. Todo el código `@cardoc/*` (domain, providers, persistence, application) queda **inlineado** → ya no hay `workspace:*` que resolver en deploy. |
| `format` | `cjs` | La función expone `export = app` (CommonJS); Catalyst Advanced I/O carga el módulo como CJS. |
| `target` | `node24` | El runtime del stack es node24 (ver `catalyst-config.json`). No transpilar de más. |
| `platform` | `node` | Resolución y builtins de Node, no de browser. |
| `external` | `EXTERNALS` (`["zcatalyst-sdk-node"]`) | **No se inlinea** porque el SDK hace `require()` dinámicos de sus submódulos (p.ej. `./zcql/zcql`) que esbuild no puede resolver estáticamente. El runtime de Catalyst **tampoco lo provee**: se shippea como `node_modules` real vía `deploy-prep-sdk.mjs` (§4.4). Todo lo demás (`express`, `zod`, `@cardoc/*`) SÍ se inlinea, porque Catalyst **no** instala las deps del `package.json`. |
| `sourcemap` | `true` | Genera `index.js.map` para que los stack traces de runtime mapeen al TS. |

### 4.3 La frontera externals vs. inlineados

Es la línea que hay que entender:

- **External (solo `zcatalyst-sdk-node`)** → queda como `require("zcatalyst-sdk-node")` en el bundle. No se inlina porque el SDK hace `require()` dinámicos de sus submódulos (p.ej. `./zcql/zcql`) que esbuild no resuelve estáticamente: inlinarlo revienta en runtime con `Cannot find module './zcql/zcql'`. Y el runtime de Catalyst **no lo provee**: si se externaliza pero no se shippea, revienta con `Cannot find module 'zcatalyst-sdk-node'`. La salida es shipearlo como `node_modules` real (§4.4).
- **Inlineado (todo el resto)** → `express`, y `@cardoc/*` con sus dependencias transitivas que vienen del registry (p.ej. `zod`, que usa `@cardoc/domain`), se copian dentro de `index.js`. Catalyst **no** instala las deps del `package.json`, así que si algo no está inlineado y no se shippea, no existe en runtime.

Resultado: un `index.js` autocontenido que en runtime solo hace `require("zcatalyst-sdk-node")` — resuelto contra el `node_modules` real que materializa `deploy-prep-sdk.mjs`. Cero `workspace:*`, cero dependencia del registry que Catalyst tenga que instalar.

> Corolario de diseño: el adapter de streaming / SDK vive **en la capa function**, no en `packages/*`. Los packages son Node puro y testeables; el acoplamiento a Catalyst se concentra en `fn-api`, que es justamente lo que el bundle empaqueta. Ver [`../../ARQUITECTURA.md`](../../ARQUITECTURA.md).

### 4.4 Shipear el SDK como `node_modules` real (`deploy-prep-sdk.mjs`)

Externalizar el SDK no alcanza: hay que **entregarlo** junto al bundle, porque el runtime de Catalyst no lo provee. `scripts/deploy-prep-sdk.mjs` materializa cada external de `function-externals.mjs` (con sus transitivas) como **archivos reales** dentro de `apps/catalyst/functions/api/node_modules`:

1. Arma un staging aislado con un `package.json` mínimo que declara solo los externals (versión exacta tomada del `package.json` de la función, la fuente de verdad).
2. Corre `npm install` en ese staging → resuelve el closure completo (external + transitivas) como archivos flat.
3. Copia cada paquete al `node_modules` de la función, **reemplazando el symlink de pnpm**.

Por qué el symlink no sirve: pnpm resuelve `zcatalyst-sdk-node` como un symlink que apunta fuera de la carpeta de la función. Cuando `catalyst deploy` zipea el directorio, el symlink apunta **afuera del zip** → en runtime da `Cannot find module 'zcatalyst-sdk-node'` (o `'./zcql/zcql'`). Copiar archivos reales hace que el SDK viaje dentro del zip.

> ⚠️ Gotcha de idempotencia: cualquier `pnpm install` **restaura el symlink** de pnpm y "des-materializa" lo que dejó este script. Por eso `deploy:prep` se re-corre siempre antes de deployar (está encadenado en `predeploy`, ver §5 y §7). Si deployás tras un `pnpm install` sin re-correr `predeploy`/`deploy:prep`, el runtime vuelve a fallar con `Cannot find module`.

---

## 5. Artefactos de deploy de la función

El bundle por sí solo no se despliega: Catalyst necesita su metadata, y el SDK tiene que viajar en el zip. Lo que convive en `apps/catalyst/functions/api/` al deployar:

| Archivo | Rol |
|---------|-----|
| `index.js` (generado) | El bundle CJS que ejecuta el runtime. `catalyst-config.json` lo apunta con `execution.main`. |
| `node_modules/` (generado) | El SDK real (`zcatalyst-sdk-node` + transitivas) que materializa `deploy-prep-sdk.mjs` (§4.4). Es lo que resuelve el `require("zcatalyst-sdk-node")` externalizado; viaja dentro del zip. |
| `package.json` | Declara `main: index.js`. Catalyst **no** instala estas deps en deploy: el bundle es autocontenido salvo `zcatalyst-sdk-node`, que se shippea como `node_modules` real (no lo provee el runtime). |
| `catalyst-config.json` | `{ deployment: { name: "api", stack: "node24", type: "advancedio" }, execution: { main: "index.js" } }` |

A nivel proyecto, `apps/catalyst/catalyst.json` declara qué functions se despliegan:

```json
{ "functions": { "source": "functions", "targets": ["api"] } }
```

El binding al proyecto/env real (`.catalystrc`) está **gitignored**; se versiona solo `.catalystrc.example` (timezone `America/Montevideo`). El detalle completo de artefactos Catalyst está en [`./catalyst-artefactos.md`](./catalyst-artefactos.md); el flujo de publicación y vuelta atrás en [`./deploy-y-rollback.md`](./deploy-y-rollback.md).

> ⚠️ verificar (docs oficiales/consola): el tope de tamaño del artefacto / payload en Advanced I/O. Que `catalyst deploy` **no** instala las `dependencies` del `package.json` (solo zipea el directorio) está confirmado por el smoke — por eso hay que shipear el SDK como `node_modules` real (§4.4). El CLI (`catalyst init` / `catalyst deploy`) y la estructura de configs también están confirmados; el límite de tamaño no.

---

## 6. Gotchas de instalación (red corporativa)

Dos cosas tienen que estar bien para que `pnpm install` y el build pasen en limpio.

### 6.1 `pnpm.onlyBuiltDependencies: ["esbuild"]`

`package.json` raíz:

```json
"pnpm": { "onlyBuiltDependencies": ["esbuild"] }
```

pnpm 10 **no ejecuta los scripts de instalación (`postinstall`) de las dependencias por defecto** — es una protección contra supply-chain. Pero `esbuild` necesita su `postinstall` para bajar el binario nativo de la plataforma; sin eso, el binario no queda disponible y `bundle-function.mjs` falla. Esta allowlist le da permiso **solo a esbuild** para correr su build script. Si algún día se necesita otro paquete con binario nativo (p.ej. otro toolchain), se agrega explícitamente a esta lista — nunca se abre el permiso de forma global.

### 6.2 `NODE_OPTIONS=--use-system-ca` para el install

En la red corporativa de Unicorp (CA propia / intercepción TLS), un `pnpm install` plano falla la verificación del certificado contra el registry. El install correcto:

```bash
NODE_OPTIONS=--use-system-ca pnpm install
```

`--use-system-ca` le dice a Node que confíe en el almacén de certificados del **sistema operativo** (donde está instalada la CA corporativa), en vez de usar solo el bundle de CAs propio de Node. Es la diferencia entre `install` en verde y un muro de errores `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `self-signed certificate in certificate chain`.

> Equivalente PowerShell (Windows): `$env:NODE_OPTIONS = "--use-system-ca"; pnpm install`. La gotcha aplica también a cualquier comando que tenga que llegar al registry.

---

## 7. Checklist — build local en verde

```bash
# 1. Instalar (red corporativa)
NODE_OPTIONS=--use-system-ca pnpm install

# 2. Compilar el grafo entero (orden topológico, incremental)
pnpm exec tsc -b

# 3. Calidad
pnpm -r run test      # suite local (vitest)
pnpm lint             # eslint .

# 4. Preparar el deploy: build (tsc -b + esbuild → index.js) + materializar el SDK real
#    OJO: si corriste `pnpm install` (paso 1), esto RE-materializa el SDK (§4.4). No lo salteés.
pnpm --filter @cardoc/fn-api run predeploy   # = pnpm build && pnpm deploy:prep

# 5. Deploy (desde apps/catalyst, CA corporativa)
cd apps/catalyst
NODE_OPTIONS=--use-system-ca catalyst deploy --only functions:api --ignore-scripts
```

> ⚠️ Orden no negociable: `predeploy` **después** de cualquier `pnpm install`. Un `pnpm install` restaura el symlink de pnpm y "des-materializa" el SDK (§4.4); si deployás sin re-correr `predeploy`, el runtime falla con `Cannot find module`.

Estado verificado en verde al `2026-06-25`: `tsc -b`, suite local (25 tests) + smoke local 21/21, eslint, bundle esbuild, y alta real en Catalyst (datastore + Zoho) vía `scripts/smoke-catalyst-crm.mjs` 5/5. Si alguno falla tras un cambio, el sospechoso #1 es desalineación entre `dependencies` (`workspace:*`) y `references` (§2.4), un externals mal puesto en el bundle (§4.2), o haber deployado sin re-correr `predeploy` tras un `pnpm install` (§4.4).

---

## Documentos relacionados

- [`./catalyst-artefactos.md`](./catalyst-artefactos.md) — qué es cada archivo de config de Catalyst.
- [`./deploy-y-rollback.md`](./deploy-y-rollback.md) — publicar y volver atrás.
- [`./secretos-y-connections.md`](./secretos-y-connections.md) — variables de entorno y la Connection OAuth a CRM.
- [`../../ARQUITECTURA.md`](../../ARQUITECTURA.md) — capas, puertos/adapters, por qué los packages son Node puro.
- [`../../OPERACIONES.md`](../../OPERACIONES.md) · [`../../PLAN-DE-DESARROLLO.md`](../../PLAN-DE-DESARROLLO.md) — operación y cronograma.
- [`../README.md`](../README.md) — índice de la documentación.
