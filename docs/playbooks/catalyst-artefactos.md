---
title: "Playbook — Artefactos de Zoho Catalyst en cardoc-ml"
status: draft
last_reviewed: 2026-06-25
---

# Playbook — Artefactos de Zoho Catalyst en cardoc-ml

Catalyst es el backend serverless de cardoc. Este playbook mapea **cada artefacto de la plataforma** a su uso concreto en este repo, y cómo los **archivos de configuración** lo cablean al ciclo `init → deploy`. Regla de lectura: todo lo que aquí afirmamos está anclado al código en disco; todo `specific` de la API de Catalyst no confirmado en código va marcado **⚠️ verificar (docs oficiales/consola)**.

Doc relacionada: arquitectura general en [`../../ARQUITECTURA.md`](../../ARQUITECTURA.md), contratos HTTP en [`../../CONTRATOS.md`](../../CONTRATOS.md), build/bundle en [`./monorepo-build-y-bundling.md`](./monorepo-build-y-bundling.md), deploy en [`./deploy-y-rollback.md`](./deploy-y-rollback.md).

---

## TL;DR — qué usamos y qué no

| Artefacto Catalyst | ¿Se usa en cardoc? | Para qué | Estado |
|---|---|---|---|
| **Advanced I/O Function** | Sí | Express completo (`/v1/*`) en una sola función `api` | E-01 deployable |
| **DataStore** | Sí | 5 tablas (tokens, consumers, opportunities, audit, caps) vía ZCQL + SDK | Impl real (`catalyst.ts`) |
| **Catalyst Cache** | Planeado | Contadores del cap distribuido (hoy in-memory) | Gate pre-prod |
| **Connections** | Planeado | OAuth gestionado a Zoho CRM | Stub (E-02) |
| **Environment Variables** | Sí | Flags de modo + secretos (`ZOHO_*`, caps) | En uso |
| **Web Client Hosting** | **No** | — | No aplica |

---

## 1. Advanced I/O Functions — el corazón del runtime

La función `api` es una **Advanced I/O Function**: el tipo de función Catalyst que recibe el request HTTP crudo y le deja a tu código el control total del ciclo request/response. Eso es lo que permite montar un **Express entero** en vez de un handler por endpoint.

### Cómo está montada

- **Entry point** — `apps/catalyst/functions/api/src/index.ts` hace `import app from "./app"; export = app;`. El `export =` es **CommonJS**: Catalyst hace `require(main)` y espera el app exportado en `module.exports`. Por eso el bundle final se emite en formato `cjs` (ver §7).
- **El app Express** — `apps/catalyst/functions/api/src/app.ts` arma el `express()`, registra el pipeline de middlewares y las rutas. Una sola función sirve los 4 endpoints (`POST /v1/opportunity-contact`, `GET /v1/informes`, `GET /v1/informes/:id/pdf`, `GET /v1/health`) más `/` (liveness `cardoc api: live`).
- **Pipeline (orden fijo)** — definido en `app.ts`:

  ```
  express.json → correlationMiddleware → auditOnFinish        (globales)
  → [por ruta] attachContainer → authMiddleware → requireScope(scope) → cap(endpoint) → handler
  → errorMiddleware                                            (último, traduce al sobre de error único)
  ```

  `requireScope` y `cap` se montan **por ruta** (no por prefijo) porque cada endpoint tiene scope y cap distintos. Detalle del sobre de error y catálogo de códigos en [`../../CONTRATOS.md`](../../CONTRATOS.md).

### Configuración de plataforma

El descriptor de la función vive en `apps/catalyst/functions/api/catalyst-config.json`:

```json
{
  "deployment": { "name": "api", "stack": "node24", "type": "advancedio" },
  "execution":  { "main": "index.js" }
}
```

- `type: "advancedio"` → es lo que habilita el control total del request/response y el montaje de Express.
- `stack: "node24"` → runtime Node 24, alineado con el toolchain del repo (node 24.13). El bundle se compila con `target: node24`.
- `execution.main: "index.js"` → el archivo que Catalyst hace `require`. **No es** `src/index.ts`: es el `index.js` bundleado que genera esbuild (§7).

> **⚠️ verificar (docs oficiales/consola):** límite de tamaño de payload de request/response, soporte real de **streaming/chunked transfer** en Advanced I/O (necesario para `GET /v1/informes/:id/pdf`), timeouts de ejecución, memoria asignable y comportamiento de **cold-start** del plan contratado. Son gates de de-risk previos a producción — ver open questions.

---

## 2. DataStore — la base de datos

DataStore es la base relacional gestionada de Catalyst. cardoc la usa para **toda la persistencia operativa** (tokens, idempotencia, auditoría, caps).

### Cómo se usa

- **Impl real:** `packages/persistence/src/catalyst.ts`. Decisión de diseño clave: **no importa `zcatalyst-sdk-node`**. Define una rebanada estructural mínima de la API del SDK (`CatalystAppLike`) y la función le pasa por duck-typing el `catalyst.initialize(req)` real (en `apps/catalyst/functions/api/src/container.ts`). Así `@cardoc/persistence` queda sin dependencia del SDK ni en runtime ni en tipos.
- **API del SDK efectivamente usada** (confirmada en código):
  - `app.datastore().table(name).insertRow(row)` / `.updateRow(row)`
  - `app.zcql().executeZCQLQuery(sql)` → devuelve `Array<{ <tableName>: { ...columns } }>` (de ahí el patrón `res[0][TABLE]` en todos los repos).
- **ZCQL** (Zoho Catalyst Query Language) es el dialecto SQL de la plataforma. cardoc lo usa para todos los `SELECT` (resolución de token por hash, lookup de oportunidad por `(account_id, idempotency_key)`, búsqueda de auditoría, config de cap). Inserts/updates van por `insertRow`/`updateRow`, no por ZCQL.

### Columnas de sistema que sí aprovechamos

| Columna | Tipo | Uso en cardoc |
|---|---|---|
| `ROWID` | PK que asigna Catalyst | Se lee tras el lookup y se usa como clave de `updateRow` (`touchLastUsed`, `markCreated`, `markError`, `revoke`). |
| `CREATEDTIME` | Timestamp de sistema | Orden cronológico del audit trail: `... ORDER BY CREATEDTIME ASC`. |

Las columnas de negocio van en **snake_case** en DataStore y se mapean a camelCase en el dominio (ej. `account_id` ↔ `accountId`). Las 5 tablas y su detalle de columnas están en [`./datastore-esquema.md`](./datastore-esquema.md).

### Constraint UNIQUE — se crea en la consola, no en código

La idempotencia se apoya en `UNIQUE(idempotency_key)` (single-column) sobre `crm_opportunities`. Catalyst no soporta UNIQUE compuesto por UI (solo single-column); el filtrado por `(account_id, idempotency_key)` que hace el código en el lookup es **lectura defensiva de tenancy**, no el constraint del índice. **Este constraint NO se declara en el repo**: se crea **en la consola de Catalyst** (así está documentado en el comentario de cabecera de `catalyst.ts`). El código asume que existe: `insertIfAbsent` intenta el insert y, si el UNIQUE rechaza el segundo concurrente, cae al `catch`, busca el existente y devuelve `created: false`. Esa es la red **física** anti-duplicación (estilo Stripe: mismo `NroSolicitud` + payload distinto → 409 `IDEMPOTENCY_CONFLICT`, lógica de fingerprint en el use-case).

> Acción operativa: el constraint `UNIQUE(idempotency_key)` en `crm_opportunities` es un paso **manual de provisioning en consola** que debe quedar en el checklist de deploy de cada environment. Ver [`./datastore-esquema.md`](./datastore-esquema.md) y [`./deploy-y-rollback.md`](./deploy-y-rollback.md).

> **⚠️ verificar (docs oficiales/consola):** mecanismo de **backup/export** del DataStore, **retención** y residencia de datos (PII bajo UY/AR/Wyoming), y quotas de filas/queries del plan. Open questions de plataforma.

---

## 3. Catalyst Cache — el cap distribuido (pendiente)

**Hoy los contadores del cap son in-memory, no Cache.** Esto está explícito en `apps/catalyst/functions/api/src/middleware/cap.ts`:

```
NOTA (gate de plataforma): los contadores acá son IN-MEMORY (por contenedor caliente).
El blueprint pide Catalyst Cache (TTL nativo, atomicidad del increment) para un cap distribuido real.
```

### Cómo funciona el cap hoy

`cap(endpoint)` mantiene un `Map<string, { count, resetAt }>` en memoria del proceso, con clave `consumerId|endpoint|window` y 3 ventanas (hora/día/semana). La **config de límites** sí sale de DataStore (`CapRepository.getConfig`, tabla `consumer_caps`) con fallback a env (`CARDOC_CAP_DEFAULT_HOUR/DAY/WEEK`). Al exceder, emite 429 `CAP_EXCEEDED` con headers `Retry-After`, `X-Cap-Window/Limit/Remaining`.

### Por qué Cache (el plan)

El problema del in-memory: **cada contenedor caliente tiene su propio Map**. Con N contenedores el límite efectivo es ~N×límite. Catalyst Cache aportaría un store **compartido entre contenedores** con TTL nativo (para el reset por ventana) e increment atómico (para no perder cuentas bajo concurrencia).

> **⚠️ verificar (docs oficiales/consola):** que la API de Catalyst Cache exponga un **increment atómico** (tipo `INCRBY`) y **TTL por clave**, y su semántica exacta (¿el TTL se fija al crear o se puede renovar?, ¿el increment es read-modify-write o atómico server-side?). Sin atomicidad confirmada, el cap distribuido no es correcto. **Este es un gate de de-risk explícito antes de producción** — ver open questions de plataforma.

---

## 4. Auth a Zoho CRM — self-client a nivel código (E-02)

Una **Connection** de Catalyst gestiona el ciclo OAuth (token + refresh) contra un servicio Zoho, para que la función no maneje refresh tokens a mano. cardoc la usa para autenticar contra **Zoho CRM** (módulos Contacts/Deals/Accounts).

### Estado en código (E-02 implementado)

En `container.ts`, `resolveZohoAccessToken()` obtiene el token por **self-client del SDK**
(`connection({...}).getConnector().getAccessToken()`) con `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`;
override directo con `ZOHO_CRM_ACCESS_TOKEN` (dev). **No** se usa la Connection de consola (bug del
refresh token). La resolución es lazy y memoizada por request.

El adapter real `ZohoCrmClient` vive en `@cardoc/providers` (**implementado**, único lugar con HTTP
externo); recibe el token vía `CrmConnection.getAccessToken()`. La resolución del token corresponde
a la **capa function**, no a `packages/*`.

Variable asociada: `ZOHO_CRM_CONNECTOR_NAME` (nombre del conector/Connection a referenciar en runtime).

> **⚠️ verificar (docs oficiales/consola):** el **setup de la Connection** en consola (alta del conector OAuth, scopes de Zoho CRM, dominio de DC), y la **API exacta del SDK** para obtener el access token gestionado en runtime (nombre del método, si requiere el nombre del conector, manejo de refresh). El detalle de provisioning y secretos está en [`./secretos-y-connections.md`](./secretos-y-connections.md).

---

## 5. Environment Variables — flags y secretos

Catalyst inyecta variables de entorno por environment. cardoc las usa para dos cosas: **selección de modo** (DI por flag, sin recompilar) y **secretos**.

| Variable | Rol | Valores / notas |
|---|---|---|
| `CARDOC_PERSISTENCE` | Modo | `datastore` → repos reales; otro → in-memory sembrado |
| `CARDOC_CRM_MODE` | Modo | `zoho` → `ZohoCrmClient`; otro → `MockCrmClient` |
| `CARDOC_REPORTS_MODE` | Modo | `creator` → `ZohoCreatorReportsSource`; otro → `MockReportsSource` |
| `CARDOC_CAP_DEFAULT_HOUR` / `_DAY` / `_WEEK` | Config | Defaults del cap (fallback si no hay fila en `consumer_caps`) |
| `ZOHO_CRM_API_DOMAIN` | Secreto/config | Default `https://www.zohoapis.com` |
| `ZOHO_CRM_ACCESS_TOKEN` | Secreto | **Placeholder de dev**; en prod lo reemplaza la Connection (§4) |
| `ZOHO_CRM_CONNECTOR_NAME` | Config | Nombre del conector OAuth |

El switch de modos vive en `container.ts` (`useDatastore`, `useZohoCrm`, `useCreator`). En modo dev (sin `datastore`) se siembra en memoria un consumidor + token (`X-Api-Key: test-token`, todos los scopes, Cuenta `acc_dev`) — útil para el smoke e2e, **nunca** para prod.

> Nota de seguridad: `ZOHO_CRM_ACCESS_TOKEN` como env var es solo dev. La gestión real de secretos va por Connection + env vars del environment de Catalyst, no versionadas. Ver [`./secretos-y-connections.md`](./secretos-y-connections.md) y [`../../OPERACIONES.md`](../../OPERACIONES.md).

---

## 6. Web Client Hosting — no se usa

Catalyst ofrece hosting de SPA/cliente web (Web Client Hosting). **cardoc no lo usa.** El proyecto es API-only: el único servidor de assets es indirecto (los PDFs viven en WorkDrive, no servidos por Catalyst). Si en el futuro hiciera falta un panel, sería el artefacto a evaluar; hoy no hay nada que documentar.

---

## 7. Archivos de configuración y el ciclo init → deploy

Tres archivos cablean el repo a Catalyst. Layout real (la raíz de Catalyst es `apps/catalyst/`, **no** la raíz del repo):

```
apps/catalyst/
├── catalyst.json                        # proyecto: qué funciones desplegar
├── .catalystrc.example                  # plantilla (versionada)
├── .catalystrc                          # vínculo a proyecto/env real (gitignored)
└── functions/api/
    ├── catalyst-config.json             # descriptor de la función api
    ├── package.json                     # metadata (Catalyst NO instala estas deps; express/zod/@cardoc/* se inlinan, el SDK se shippea a mano)
    ├── src/…                            # fuente TS
    ├── node_modules/                    # SDK real shippeado (zcatalyst-sdk-node + transitivas), lo materializa deploy:prep
    └── index.js                         # bundle CJS (lo genera esbuild; lo requiere Catalyst)
```

### `catalyst.json` (nivel proyecto)

```json
{ "functions": { "source": "functions", "targets": ["api"] } }
```

Declara que las funciones están bajo `functions/` y que el target a desplegar es `api`. Es el manifiesto que lee el CLI para saber **qué** desplegar.

### `catalyst-config.json` (por función)

Descrito en §1: `name`, `stack: node24`, `type: advancedio`, `main: index.js`. Es el descriptor de runtime de cada función.

### `.catalystrc` vs `.catalystrc.example`

- `.catalystrc.example` — **versionado**, es plantilla. Trae estructura (`projects`, `defaults`, `actives`, `env`) con placeholders (`<CATALYST_PROJECT_ID>`, `<DOMAIN_ID>`, `<DEV_ENV_ID>`) y `timezone: America/Montevideo`.
- `.catalystrc` — **gitignored**. Liga el clon local a un proyecto/environment **concreto** (IDs reales). Lo genera/actualiza `catalyst init` al vincular el proyecto. Nunca se versiona: cada dev/CI lo materializa.

Flujo: copiar el `.example` a `.catalystrc` y completar con IDs reales, o dejar que `catalyst init` lo escriba.

### Cómo encaja en init → deploy

| Fase | Qué pasa | Artefacto que toca |
|---|---|---|
| **init** | `catalyst init` vincula el clon local a un proyecto/env y escribe `.catalystrc` | `.catalystrc` |
| **build** (pre-deploy, propio del repo) | `pnpm exec tsc -b` + `scripts/bundle-function.mjs` (esbuild → `index.js`, format `cjs`, target `node24`; express/zod/`@cardoc/*` se **inlinan**, `zcatalyst-sdk-node` se **externaliza**) | `index.js`, `catalyst-config.json` (`main`) |
| **deploy:prep** (pre-deploy, propio del repo) | `scripts/deploy-prep-sdk.mjs` materializa `zcatalyst-sdk-node` + sus transitivas como `node_modules` **real** en el function dir (el runtime de Catalyst NO provee el SDK) | `node_modules/` |
| **deploy** | `catalyst deploy` lee `catalyst.json` (target `api`), sube el `index.js` bundleado + el `node_modules` shippeado con el SDK | `catalyst.json`, `catalyst-config.json`, `index.js`, `node_modules/` |

El detalle por qué se bundlea (resolver `workspace:*` que npm no entiende en deploy) está en [`./monorepo-build-y-bundling.md`](./monorepo-build-y-bundling.md). El procedimiento operativo de deploy y rollback en [`./deploy-y-rollback.md`](./deploy-y-rollback.md).

> **⚠️ verificar (docs oficiales/consola):** los **comandos exactos** del CLI (`catalyst init`, `catalyst deploy`) y sus flags (selección de env, `--only`, etc.) según la versión de CLI instalada. La estructura de los configs y el ciclo init→deploy están confirmados en repo; las opciones finas del CLI, no.

---

## Open questions de plataforma (gates de de-risk antes de producción)

No resolver inventando — son validaciones pendientes contra docs oficiales/consola:

- **Advanced I/O:** streaming/chunked real y tope de payload.
- **Catalyst Cache:** atomicidad del increment y TTL por clave para el cap distribuido (hoy in-memory por contenedor).
- **Connection OAuth a CRM:** setup en consola y API de resolución de token en runtime.
- **Datos:** región/residencia (PII UY/AR/Wyoming), retención de logs, backup/export del DataStore.
- **Plan:** SLA, quotas y cold-start.

Estado del proyecto y cronograma (sprint 22/06→03/07/2026, owner Nestor Toñanez): [`../../PLAN-DE-DESARROLLO.md`](../../PLAN-DE-DESARROLLO.md). Atributos de calidad relacionados: [`../../ATRIBUTOS-DE-CALIDAD.md`](../../ATRIBUTOS-DE-CALIDAD.md). Para incidentes operativos usar el [`../runbooks/_template.md`](../runbooks/_template.md).
