---
title: "Playbook — Esquema del DataStore (Catalyst)"
status: vigente
last_reviewed: 2026-06-25
---

# Playbook — Esquema del DataStore

Modelo de datos físico de cardoc-ml sobre **Zoho Catalyst DataStore**. Cinco tablas, columnas `snake_case`, accedidas vía ZCQL + DataStore API. Este documento es el contrato entre lo que el código espera (`@cardoc/persistence`) y lo que existe en la consola de Catalyst.

**Regla de oro:** las columnas las define el código en `packages/persistence/src/{entities.ts,catalyst.ts}`. Los **constraints (UNIQUE, índices)** los define **la mano del operador en la consola de Catalyst**. El código no puede crear índices; asume que existen. Si faltan, no hay error de compilación ni de arranque: la idempotencia **falla en silencio** (ver [§4](#4-constraints-que-se-crean-a-mano-crítico)).

Fuente en disco:
- `packages/persistence/src/entities.ts` — tipos de fila (camelCase del dominio).
- `packages/persistence/src/catalyst.ts` — impl DataStore (mapeo snake_case ↔ camelCase, ZCQL).
- `packages/persistence/src/repositories.ts` — puertos.
- `packages/persistence/src/memory.ts` — fakes in-memory (emulan el UNIQUE compuesto a mano).

---

## 1. Mapa de tablas

| Tabla (DataStore) | Entidad de dominio | Rol | Mutabilidad |
|---|---|---|---|
| `api_tokens` | `ApiToken` | Autenticación: hash del X-Api-Key → Cuenta + scopes | INSERT / UPDATE |
| `consumers` | `Consumer` | Una automotora = una Cuenta CRM = un consumidor | INSERT / UPDATE |
| `crm_opportunities` | `OpportunityRecord` | Red de idempotencia del POST (AC-08) | INSERT / UPDATE |
| `audit_log` | `AuditLogEntry` | Bitácora 1-registro/request (AC-09) | **INSERT-only (append-only)** |
| `consumer_caps` | `CapConfig` | Límites por consumidor+endpoint (config, no contadores) | INSERT / UPDATE |

> Los **nombres de tabla son literales** en `catalyst.ts` (constantes `TOKENS`, `CONSUMERS`, `OPPORTUNITIES`, `AUDIT`, `CAPS`). Si la tabla en consola se llama distinto, las queries fallan en runtime. No hay capa de mapeo de nombres de tabla.

### Partition key lógica

`account_id` (la Cuenta CRM = la automotora) es la **partition key lógica** del runtime. Toda query de runtime filtra por el `accountId` **derivado del token**, nunca del payload/query (tenancy AC-06/AC-10). Cross-tenant → **404** (ver [CONTRATOS.md](../../CONTRATOS.md)).

### Columnas de sistema (Catalyst)

Catalyst agrega columnas de sistema a toda tabla. El código usa estas dos — deben existir y comportarse como tales:

| Columna sistema | Uso en `catalyst.ts` | ⚠️ |
|---|---|---|
| `ROWID` | PK física; usada en todo `updateRow({ ROWID, ... })` | confirmado en código; semántica exacta → ⚠️ verificar (docs oficiales) |
| `CREATEDTIME` | `ORDER BY CREATEDTIME ASC` al leer `audit_log` por correlation | ⚠️ verificar (nombre/zona horaria de la columna en consola) |

---

## 2. Esquema por tabla

Tipo lógico = intención del dato en el dominio. El **tipo físico de columna en Catalyst** (Varchar/Text/BigInt/etc.) lo elige el operador al crear la tabla y debe ser compatible con el mapeo. Donde el código lee/escribe JSON o ISO-string, la columna física es texto.

### 2.1 `api_tokens`

Solo se persiste el **hash** del token; el plano nunca toca el DataStore (`entities.ts`).

| Columna (snake_case) | Campo dominio (camelCase) | Tipo lógico | Índice / único | Notas |
|---|---|---|---|---|
| `token_hash` | `tokenHash` | string (hash) | **UNIQUE recomendado** + índice de lookup | Se consulta por `WHERE token_hash = ...` en cada request autenticado |
| `consumer_id` | `consumerId` | string (FK→consumers) | índice (lookup por consumidor) | `listByConsumer` filtra por acá |
| `account_id` | `accountId` | string (Cuenta CRM) | — | Se inyecta en cada query de runtime |
| `scopes` | `scopes` | `Scope[]` serializado **JSON** | — | Texto; `JSON.stringify` al escribir, `JSON.parse` al leer |
| `expires_at` | `expiresAt` | ISO datetime \| null | — | Vigencia la decide el middleware de auth, no la tabla |
| `last_used_at` | `lastUsedAt` | ISO datetime \| null | — | `touchLastUsed` lo actualiza |
| `revoked_at` | `revokedAt` | ISO datetime \| null | — | `revoke` lo setea; ≠ null = revocado |

### 2.2 `consumers`

Una integración = una automotora = una Cuenta CRM (`Accounts`).

| Columna | Campo dominio | Tipo lógico | Índice / único | Notas |
|---|---|---|---|---|
| `consumer_id` | `consumerId` | string (PK lógica) | **UNIQUE recomendado** + índice | `getByConsumerId` |
| `crm_account_id` | `crmAccountId` | string (Cuenta CRM) | **UNIQUE recomendado** + índice | `getByAccountId`; ancla de la tenancy |
| `name` | `name` | string | — | Nombre de la automotora |
| `status` | `status` | enum `active` \| `suspended` | — | Texto |

### 2.3 `crm_opportunities`

Red física anti-duplicación del POST. El **UNIQUE compuesto es el corazón** de la idempotencia (ver [§4](#4-constraints-que-se-crean-a-mano-crítico)).

| Columna | Campo dominio | Tipo lógico | Índice / único | Notas |
|---|---|---|---|---|
| `account_id` | `accountId` | string | parte de **`UNIQUE(account_id, idempotency_key)`** | Del token, nunca del payload |
| `idempotency_key` | `idempotencyKey` | string | parte de **`UNIQUE(account_id, idempotency_key)`** | = `String(NroSolicitud)` (del body de ML) |
| `payload_fingerprint` | `payloadFingerprint` | string (hash) | — | `domain.idempotency.payloadFingerprint`; detecta mismo-NroSolicitud/payload-distinto → 409 |
| `contact_id` | `contactId` | string \| null | — | ID del Contacto CRM (se llena en `markCreated`) |
| `opportunity_id` | `opportunityId` | string \| null | — | ID del Deal CRM (se llena en `markCreated`) |
| `status` | `status` | enum `pending` \| `created` \| `error` | — | Texto; máquina de estados del intento |
| `correlation_id` | `correlationId` | string (UUID) | — | Traza la request originadora |
| `created_at` | `createdAt` | ISO datetime | — | |
| `updated_at` | `updatedAt` | ISO datetime | — | `markCreated`/`markError` lo refrescan |

### 2.4 `audit_log` — **append-only**

Bitácora escrita por el middleware on-finish: **1 registro por request** en los 3 endpoints (AC-09). Desde la aplicación **solo se hace INSERT** — no hay `UPDATE` ni `DELETE` en el código (`repositories.ts`: *"Append-only: solo inserta. Sin update ni delete."*).

| Columna | Campo dominio | Tipo lógico | Índice / único | Notas |
|---|---|---|---|---|
| `timestamp` | `timestamp` | ISO datetime | — | Momento del registro (app) |
| `correlation_id` | `correlationId` | string (UUID) | índice (búsqueda por traza) | `searchByCorrelationId` |
| `consumer_id` | `consumerId` | string | — | |
| `account_id` | `accountId` | string | — | |
| `endpoint` | `endpoint` | string (lógico) | — | p.ej. `opportunity-contact`, `informes-list`, `informes-pdf` |
| `outcome` | `outcome` | enum `success` \| `error` | — | Texto |
| `http_status` | `httpStatus` | integer | — | Código HTTP final |
| `latency_ms` | `latencyMs` | integer | — | `Date.now() - startMs` del correlationMiddleware |
| `error_code` | `errorCode` | string \| null | — | Code del catálogo de errores, o null si success |

> **Append-only se garantiza por disciplina de código, no por el DataStore.** Catalyst no marca tablas como append-only. Para hacerlo a prueba de operador conviene: (a) no dar permisos de UPDATE/DELETE al rol que usa la función, y (b) revisar en code-review que `audit_log` solo aparezca con `insertRow`. Mecanismo de control de permisos por tabla → ⚠️ verificar (consola Catalyst).

### 2.5 `consumer_caps`

**Config** de los caps, no los contadores. Los contadores de rate-limit viven hoy in-memory por contenedor en el middleware `cap` (de-risk pendiente: cap distribuido en Catalyst Cache, ver [OPERACIONES.md](../../OPERACIONES.md)).

| Columna | Campo dominio | Tipo lógico | Índice / único | Notas |
|---|---|---|---|---|
| `consumer_id` | `consumerId` | string | parte de lookup `(consumer_id, endpoint)` | `getConfig` filtra por ambos |
| `endpoint` | `endpoint` | string (lógico) | parte de lookup `(consumer_id, endpoint)` | |
| `limit_hour` | `limitHour` | integer \| null | — | null ⇒ el middleware usa `CARDOC_CAP_DEFAULT_HOUR` |
| `limit_day` | `limitDay` | integer \| null | — | null ⇒ `CARDOC_CAP_DEFAULT_DAY` |
| `limit_week` | `limitWeek` | integer \| null | — | null ⇒ `CARDOC_CAP_DEFAULT_WEEK` |

> Para `consumer_caps` conviene un **UNIQUE(consumer_id, endpoint)** para evitar config duplicada (el código hace `LIMIT 1` y tomaría una fila arbitraria si hubiera dos). Recomendado, no obligatorio para que funcione.

---

## 3. Mapeo snake_case (DataStore) ↔ camelCase (dominio)

El DataStore habla `snake_case`; el dominio habla `camelCase`. La traducción es **manual y centralizada en `catalyst.ts`** (no hay ORM ni convención automática). Cada repositorio tiene su `map(row)` de lectura y arma el objeto literal de escritura.

| Sentido | Dónde | Cómo |
|---|---|---|
| Lectura DataStore → dominio | `mapToken`, `map` de cada repo | `tokenHash: str(r["token_hash"])`, etc. |
| Escritura dominio → DataStore | `insertRow({...})` / `updateRow({...})` | `{ token_hash: token.tokenHash, ... }` |
| Tipos especiales | helpers en `catalyst.ts` | `str`, `strOrNull`, `numOrNull`, `parseJson` (scopes), `lit` (escape ZCQL) |

**Implicancia operativa:** si renombrás una columna en la consola, **no rompe el build** (TypeScript no ve el DataStore). Rompe en runtime, en silencio parcial (el `map` devuelve `""`/`null` para la columna ausente). Cualquier cambio de columna exige tocar `catalyst.ts` **y** la consola, en sincronía.

ZCQL: las queries son strings literales. Los inputs son server-derived; aun así se escapan con `lit()` (defensa). Lectura de filas: el resultado viene envuelto por nombre de tabla — `res[0][TABLA]` — patrón presente en todos los `findRaw`/`queryOne`.

---

## 4. Constraints que se crean A MANO (crítico)

> El DataStore API del SDK (`insertRow`/`updateRow`/`executeZCQLQuery`) **no crea ni gestiona índices ni constraints**. El esquema físico —columnas, tipos, índices, UNIQUE— se define **en la consola de Catalyst** (o por CLI/import de esquema → ⚠️ verificar si existe ese mecanismo). El código **asume** que el constraint ya existe.

### El UNIQUE de `crm_opportunities` es no-negociable

La idempotencia (estilo Stripe, AC-08) descansa en **`UNIQUE(account_id, idempotency_key)`**. El mecanismo en `insertIfAbsent` (`catalyst.ts`) es:

1. Intenta `insertRow(...)`.
2. Si el **UNIQUE** rechaza el segundo insert concurrente → cae al `catch`, busca el row existente con `findRaw(accountId, idempotencyKey)` y lo devuelve con `created: false`.

```text
insertIfAbsent:
  try insertRow  → created: true
  catch          → findRaw(account_id, idempotency_key) → row existente, created: false
```

**Si el UNIQUE NO existe en consola:** el `insertRow` del segundo request **no falla** → se inserta una fila duplicada → `created: true` ambas veces → se crean **Deals/Contactos duplicados** en CRM. **No hay excepción, no hay log de error, no hay 409.** La idempotencia **falla en silencio**. Es exactamente el modo de falla más caro y más difícil de detectar en producción.

El fake `InMemoryOpportunitiesRepository` (`memory.ts`) **emula** este UNIQUE a mano con un `Map` keyed por `` `${accountId}|${idempotencyKey}` ``. Por eso los tests pasan aunque el DataStore real no tenga el índice: **el verde de los tests NO prueba que el constraint exista en Catalyst.** Verificarlo es trabajo de consola.

### Inventario de constraints/índices a crear a mano

| Tabla | Constraint / índice | Obligatorio | Consecuencia si falta |
|---|---|---|---|
| `crm_opportunities` | **`UNIQUE(account_id, idempotency_key)`** | **Sí** | Idempotencia falla en silencio → duplicados en CRM |
| `api_tokens` | UNIQUE(`token_hash`) + índice lookup | Recomendado | Tokens duplicados; lookup más lento |
| `consumers` | UNIQUE(`consumer_id`), UNIQUE(`crm_account_id`) | Recomendado | Tenancy ambigua; `getByAccountId` arbitrario |
| `consumer_caps` | UNIQUE(`consumer_id`, `endpoint`) | Recomendado | Config de cap duplicada; `LIMIT 1` toma una al azar |
| `audit_log` | índice(`correlation_id`) | Recomendado | `searchByCorrelationId` lento (full scan) |

> Sintaxis/UI exacta para crear un UNIQUE compuesto en Catalyst DataStore → ⚠️ verificar (consola Catalyst / docs oficiales). Lo confirmado por el repo es que el código **depende** de él, no cómo se crea.

---

## 5. Checklist — crear las tablas para un proyecto nuevo

Para levantar el DataStore de un entorno limpio (nuevo proyecto Catalyst). Mecánica fina de cada paso en consola → ⚠️ verificar (docs oficiales); el **qué** está anclado al código.

- [ ] **Crear las 5 tablas** con los nombres EXACTOS: `api_tokens`, `consumers`, `crm_opportunities`, `audit_log`, `consumer_caps` (literales en `catalyst.ts`).
- [ ] **Columnas por tabla** según [§2](#2-esquema-por-tabla), en `snake_case`, con tipo físico compatible (texto para JSON/ISO-string; entero para `http_status`/`latency_ms`/límites).
- [ ] **UNIQUE(account_id, idempotency_key)** en `crm_opportunities` — **paso que no se puede saltear** ([§4](#4-constraints-que-se-crean-a-mano-crítico)).
- [ ] UNIQUE/índices recomendados del inventario de [§4](#inventario-de-constraintsíndices-a-crear-a-mano).
- [ ] **`audit_log` como append-only de hecho:** restringir permisos de UPDATE/DELETE del rol de la función si la plataforma lo permite → ⚠️ verificar (consola Catalyst).
- [ ] **Sembrar `consumers` + `api_tokens`** del primer consumidor real (en dev hay un token sembrado en memoria: `X-Api-Key: test-token`, Cuenta `acc_dev`, todos los scopes — vía `seed()` del fake, **no** toca el DataStore).
- [ ] **`consumer_caps`** opcional: si no hay fila, el middleware cae a `CARDOC_CAP_DEFAULT_HOUR/DAY/WEEK`. Crear filas solo para overrides por consumidor.
- [ ] **Variable de entorno** `CARDOC_PERSISTENCE=datastore` en el entorno con DataStore (vs `memory` para local/tests). Ver [secretos-y-connections.md](secretos-y-connections.md).
- [ ] **Smoke de verificación del UNIQUE:** disparar dos veces el POST con el mismo `NroSolicitud` y verificar que el segundo devuelve `created: false` / 409 — **no** una segunda fila. Es la única prueba real de que el constraint existe.
- [ ] **Backup/export del DataStore** y **retención de `audit_log`** definidos antes de producción → ⚠️ verificar (de-risk en [OPERACIONES.md](../../OPERACIONES.md)).

---

## 6. Notas de runtime

- **`accountId` siempre del token.** Los puertos de runtime (`repositories.ts`) reciben `accountId` como primer argumento obligatorio y filtran por él. Nunca del payload/query (AC-06/AC-10).
- **`memory.ts` ≠ persistencia real.** En serverless el estado del fake vive solo mientras el contenedor está caliente. Sirve para tests y local; el DataStore lo reemplaza vía `createCatalystRepositories(app)`.
- **El SDK no se importa en `@cardoc/persistence`.** `catalyst.ts` define una rebanada estructural (`CatalystAppLike`) que el `app` real de Catalyst satisface por duck-typing. El adapter del SDK vive en la capa function. Detalle en [ARQUITECTURA.md](../../ARQUITECTURA.md).

---

## Ver también

- [/CONTRATOS.md](../../CONTRATOS.md) — sobre de error, catálogo de codes, idempotencia y cross-tenant 404.
- [/ARQUITECTURA.md](../../ARQUITECTURA.md) — capas, puertos, tipado estructural sin SDK.
- [/OPERACIONES.md](../../OPERACIONES.md) — de-risk de plataforma (Cache para cap distribuido, retención de logs, backup/export, residencia de datos).
- [secretos-y-connections.md](secretos-y-connections.md) — `CARDOC_PERSISTENCE`, Connection OAuth a CRM, `.catalystrc`.
- [catalyst-artefactos.md](catalyst-artefactos.md) — `catalyst.json`, `catalyst-config.json`, estructura de la function.
- [/docs/README.md](../README.md) — índice de la documentación.
