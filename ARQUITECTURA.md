---
title: cardoc-ml — Arquitectura Técnica (API Catalyst)
status: borrador-para-validacion
last_reviewed: 2026-06-25
---

# Arquitectura Técnica — API en Zoho Catalyst

Diseño técnico del sistema destino de cardoc-ml: una API REST `/v1/*` sobre **Zoho
Catalyst** (Advanced I/O) que actúa de gateway delante de **Zoho CRM** y **Zoho
Creator/WorkDrive**, consumida por la integración de cada automotora.

El **método** de este documento (hexagonal, tenancy por token, sobre de error único,
auditoría on-finish, ADRs con rationale) se reutiliza del backend fiscal CFE. Nada
fiscal aplica acá: no hay CFE, DGI, Biller, Books ni Deluge en cardoc.

Plan de construcción: [PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md) ·
Targets de calidad: [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md) ·
Operación: [OPERACIONES.md](OPERACIONES.md) · Contratos: [CONTRATOS.md](CONTRATOS.md) ·
Superficie y arranque: [README.md](README.md).

---

## 1. Visión

cardoc-ml es **un único gateway** que expone tres capacidades a la integración de la
automotora, y que delante de Zoho hace de capa de control: autenticación scoped,
tenancy, idempotencia, cap de uso, auditoría y sobre de error estable. El consumidor
nunca habla con Zoho directo ni ve una URL, fileId o ruta interna.

| Endpoint | Scope | Qué hace | Upstream |
|----------|-------|----------|----------|
| `POST /v1/opportunity-contact` | `opportunities:create` | Crea/reutiliza Contacto (dedup por cédula `NroCedula`) + crea Oportunidad en estado fijo `Nueva Solicitud`. Payload plano de ML; idempotente por `NroSolicitud` (del body). | Zoho CRM (Contacts/Deals/Accounts) |
| `GET /v1/informes` | `reports:read` | ⛔ **Descartado** ([ADR-0015](#adr-0015)): ML es push (outbound E-07), no pull. Ruta en mock; sin adapter Creator de listado. | — |
| `GET /v1/informes/:id/pdf` | `reports:pdf` | Stream autenticado del PDF, sin URL pública ni ubicación interna. | Zoho Creator + WorkDrive |
| `GET /v1/health` | — (abierto) | Health check para monitoreo de disponibilidad. | — |

**Decisión rectora**: la fuente de verdad del negocio vive en Zoho — CRM para la
relación comercial (Contactos, Oportunidades, Cuentas) y Creator para los Informes
(form `Analisis`, campo `pdf_url`). El DataStore de Catalyst es la capa de **control de
la API**, no de negocio: tokens, consumidores, registro de idempotencia, auditoría y
configuración de caps. Esto mantiene a Zoho como sistema de registro y a cardoc como
una superficie de integración delgada, auditable y desacoplable.

> **Estado (2026-06-25)**: E-01 (scaffold) completo y deployable. La lógica de E-02/E-03
> (use-cases + puertos) está construida; `ZohoCrmClient` **implementado** (E-02), mientras
> `ZohoCreatorReportsSource` sigue stub `NotImplemented`. Verde verificado: `tsc -b`,
> 7 tests (vitest), eslint, smoke e2e 16/16, bundle esbuild. Cronograma 22/06→03/07/2026,
> owner Nestor Toñanez, 1 dev.

## 2. Diagrama de componentes

```
  CONSUMIDOR                       cardoc-ml (Catalyst)                    ZOHO
                                                                          (upstream)
┌──────────────────┐      ┌───────────────────────────────────┐      ┌──────────────────┐
│ Integración de   │      │  Advanced I/O Function `api`         │      │ Zoho CRM         │
│ la automotora    │      │  (Express, Node 24, CommonJS)        │─────▶│  Contacts        │
│                  │─────▶│                                      │◀─────│  Deals           │
│ X-Api-Key: <token>   │      │  pipeline de middlewares (§4):       │      │  Accounts        │
│ (body AutoCheck) │◀─────│   json → correlation → audit →       │      ├──────────────────┤
│ X-Correlation-Id │      │   attachContainer → auth → scope →   │─────▶│ Zoho Creator     │
└──────────────────┘      │   cap → handler ; errors (último)    │◀─────│  app Informes    │
                          │                                      │      │  form `Analisis` │
                          │  use-cases (dominio puro, sin SDK)   │      │   (pdf_url)      │
                          │  puertos: CrmClient · ReportsSource  │      ├──────────────────┤
                          │  repos:  Tokens/Consumers/Opps/      │─────▶│ WorkDrive        │
                          │          Audit/Cap                   │◀─────│  (bytes del PDF) │
                          └──────────────┬───────────────────────┘      └──────────────────┘
                                         │
                                  ┌──────▼───────┐
                                  │ DataStore     │   capa de CONTROL (no de negocio):
                                  │ api_tokens    │   tokens, consumidores, idempotencia,
                                  │ consumers     │   auditoría append-only, config de caps
                                  │ crm_opportun. │
                                  │ audit_log     │   Auth a CRM = Catalyst Connection
                                  │ consumer_caps │   (OAuth gestionado). Secretos en
                                  └──────────────┘    Environment Variables, nunca en repo.
```

La autenticación a Zoho CRM se resuelve por **Catalyst Connection** (OAuth gestionado):
la función obtiene el `accessToken` y lo pasa al adapter en `CrmConnection`; el adapter
nunca lee secretos por su cuenta. Detalle de setup: ⚠️ verificar (docs oficiales/consola)
— ver [docs/playbooks/secretos-y-connections.md](docs/playbooks/secretos-y-connections.md).

## 3. Monorepo ports & adapters

Monorepo **pnpm workspaces** + TypeScript (project references), Node 24. La arquitectura
es hexagonal y la **regla** es verificable por la dirección de las dependencias: el
dominio no conoce ni a Express, ni a Catalyst, ni a Zoho.

```
cardoc-ml/
├── packages/
│   ├── domain/        # tipos, schemas Zod, idempotency, tokens — Node PURO, sin SDK
│   ├── providers/     # puertos CrmClient + ReportsSource + adapters — ÚNICO HTTP externo
│   ├── persistence/   # entities + repositorios (puertos) + impl DataStore + fakes memory
│   └── application/   # use-cases: orquestan dominio + puertos, sin saber de transporte
└── apps/catalyst/functions/api/   # Advanced I/O: Express + composición + middlewares + SDK
```

### Qué hace cada package

| Package | Responsabilidad | Tiene SDK / HTTP / Express |
|---------|-----------------|----------------------------|
| `@cardoc/domain` | Lenguaje interno del sistema: tipos (`Scope`, `ContactInput`, `InformeRevision`, …), schemas Zod (`opportunityContactSchema`, `listInformesQuerySchema`), `idempotency.payloadFingerprint`, `tokens.hashToken`/`generateToken`, la constante `FIXED_OPPORTUNITY_STAGE = "Nueva Solicitud"`. | No. Node puro (`node:crypto`, `zod`). |
| `@cardoc/providers` | Puertos `CrmClient` y `ReportsSource`, errores tipados (`UpstreamError`, `ReportNotFoundError`, `PdfNotAvailableError`, `NotImplementedError`), y los adapters: `MockCrmClient`/`MockReportsSource` (funcionales para dev/test/e2e) y `ZohoCrmClient`/`ZohoCreatorReportsSource` (stubs `NotImplemented`). | **Sí** — es el único lugar autorizado a HTTP externo (CRM/Creator/WorkDrive). |
| `@cardoc/persistence` | `entities` (filas del DataStore en camelCase), repositorios = **puertos** (`TokensRepository`, `ConsumersRepository`, `OpportunitiesRepository`, `AuditLogRepository`, `CapRepository`), `catalyst.ts` = impl DataStore, `memory.ts` = fakes in-memory. | DataStore por **tipado estructural** (`CatalystAppLike`), sin importar el SDK. |
| `@cardoc/application` | Use-cases: `createOpportunityContact`, `listInformes`, `streamReportPdf`. Orquestan dominio + puertos. | No. Solo tipos de los otros packages. |
| `apps/catalyst/functions/api` | La función: `app.ts` arma el Express, `container.ts` compone dependencias, `middleware/*` y `routes/*`. | **Sí** — único punto que importa `zcatalyst-sdk-node` (en `container.ts`) y monta Express. |

### La regla hexagonal (cómo se sostiene en el código)

1. **Dominio puro.** `@cardoc/domain` solo usa `node:crypto` y `zod`. `payloadFingerprint`
   y `hashToken` no dependen de plataforma. Es el lenguaje que habla todo el resto.

2. **HTTP solo en providers.** Toda llamada HTTP a un upstream (CRM, Creator, WorkDrive)
   vive en `packages/providers/`. Los adapters `Zoho*` son los únicos autorizados a `fetch`;
   los puertos son interfaces (`CrmClient`, `ReportsSource`) que el resto consume sin saber
   el transporte. Hoy esos adapters son stubs `NotImplemented` (E-02/E-03).

3. **SDK solo en la función.** `zcatalyst-sdk-node` se importa exactamente una vez, en
   `apps/catalyst/functions/api/src/container.ts` (`catalyst.initialize(req)`).
   `@cardoc/persistence/catalyst.ts` usa el DataStore por **tipado estructural** — define
   `CatalystAppLike` (la rebanada mínima del SDK: `datastore().table().insertRow/updateRow`
   y `zcql().executeZCQLQuery`) y la función le pasa su `app` real, que la satisface por
   duck-typing. Así `persistence` no tiene dependencia (ni runtime ni de tipos) del SDK.

4. **El adapter de streaming/SDK vive en la capa function, no en `packages/*`.** El puerto
   `ReportsSource.openPdf` devuelve un `Readable`; el `pipe(res)` y todo lo específico de
   Catalyst Advanced I/O quedan del lado de la función.

> Beneficio operativo: el sistema corre **completo** en local con `MockCrmClient` +
> `MockReportsSource` + repos in-memory, sin Catalyst ni Zoho. Es lo que hace verde al
> smoke e2e 16/16 hoy, con los adapters reales aún en stub.

## 4. Pipeline de un request

El orden de los middlewares es **fijo** y está codificado en `app.ts`. `requireScope` y
`cap` se montan **por ruta** (no por prefijo), porque cada endpoint tiene su scope y su
endpoint lógico de cap distintos.

```
express.json
  → correlationMiddleware   (global)  valida X-Correlation-Id como UUID o regenera;
                                       setea startMs y devuelve el header
  → auditOnFinish           (global)  registra res.on("finish") — 1 registro/request
  → [por ruta]
      attachContainer                 compone repos+adapters para este request (buildContainer)
      → authMiddleware                X-Api-Key → hashToken → resuelve consumerId/accountId/scopes
      → requireScope(scope)           403 FORBIDDEN_SCOPE si el token no tiene el scope
      → cap(endpoint)                 cuenta hora/día/semana → 429 CAP_EXCEEDED
      → handler                       valida forma (Zod) + headers, llama al use-case
  → errorMiddleware         (último)  traduce TODO al sobre de error único
```

Detalles que importan, anclados al código:

- **Correlación** (`middleware/auth.ts`): si el `X-Correlation-Id` entrante no matchea el
  regex UUID, se regenera con `randomUUID()`. Siempre se devuelve en la respuesta y se usa
  como hilo de toda la traza (auditoría, logs de error).
- **Auth** (`authMiddleware`): toma el `X-Api-Key`, lo hashea (`hashToken`) y resuelve la fila
  por hash (`tokens.resolveByHash`). El token plano nunca se persiste ni se loguea. Valida
  `revokedAt` y `expiresAt`; inválido/expirado/revocado → `401 UNAUTHENTICATED`. En éxito
  cuelga `consumerId`/`accountId`/`scopes` del request y hace `touchLastUsed`.
- **Orden auth → scope → cap**: el cap se evalúa **después** de auth+scope, así un 401/403
  no consume cuota.
- **Auditoría on-finish** (`middleware/audit.ts`): se suscribe a `res.on("finish")` y
  escribe **un** registro con `httpStatus`, `latencyMs` (de `startMs`), `correlationId`,
  `outcome` y `errorCode`. Se ejecuta para los 3 endpoints autenticados; `/v1/health`
  no tiene container → no se audita. No loguea payload, PII ni bytes del PDF.
- **Errores async** (`middleware/errors.ts`): Express 4 no captura rechazos de promesas;
  `asyncHandler` enruta cualquier rechazo a `next(err)`. `errorMiddleware` es el último y
  traduce todo al sobre único.

### Sobre de error único

Todos los endpoints responden el error con la misma forma (`middleware/errors.ts`):

```jsonc
{ "error": { "code": "CAP_EXCEEDED", "message": "…", "correlationId": "uuid", "details": { } } }
```

| Código | HTTP | Cuándo |
|--------|------|--------|
| `VALIDATION_ERROR` | 400 | El payload del POST no pasa el schema (campo requerido faltante / clave extra). |
| `UNAUTHENTICATED` | 401 | Falta el X-Api-Key, o token inválido/expirado/revocado. |
| `FORBIDDEN_SCOPE` | 403 | Token sin el scope del endpoint. **Único** uso de 403. |
| `NOT_FOUND` | 404 | Informe inexistente **o de otra Cuenta** (cross-tenant → 404, no 403). |
| `PDF_NOT_AVAILABLE` | 404 | El informe existe pero su PDF no está disponible ni se pudo generar. |
| `IDEMPOTENCY_CONFLICT` | 409 | Mismo `NroSolicitud` con payload distinto (estilo Stripe). |
| `UNPROCESSABLE` | 422 | Query de `GET /v1/informes` con un parámetro fuera de la allowlist (`.strict()`). |
| `CAP_EXCEEDED` | 429 | Cuota hora/día/semana superada (con `Retry-After`). |
| `UPSTREAM_ERROR` | 502 | Falla del upstream — etiqueta opaca (`crm`/`creator`/`workdrive`), nunca URL interna. |
| `INTERNAL_ERROR` | 500 | Error no clasificado. |

El catálogo es contractual; ver [CONTRATOS.md](CONTRATOS.md).

## 5. Modelo de datos (Catalyst DataStore)

Cinco tablas, columnas en **snake_case**. `account_id` (= la Cuenta CRM = la automotora)
es la **partition key lógica** del modelo de runtime: toda query la filtra por el
`account_id` derivado del token, **nunca** del payload (tenancy — §6).

| Tabla | Columnas | Notas |
|-------|----------|-------|
| `api_tokens` | `token_hash`, `consumer_id`, `account_id`, `scopes` (JSON), `expires_at`, `last_used_at`, `revoked_at` | Solo el **hash** del token. Rotación = insertar + revocar. |
| `consumers` | `consumer_id`, `crm_account_id`, `name`, `status` | 1 automotora = 1 consumidor. `crm_account_id` ancla la tenancy. |
| `crm_opportunities` | `account_id`, `idempotency_key`, `payload_fingerprint`, `contact_id`, `opportunity_id`, `status` (`pending`\|`created`\|`error`), `correlation_id`, `created_at`, `updated_at` | **`UNIQUE(account_id, idempotency_key)`** = red física anti-duplicación. |
| `audit_log` | `timestamp`, `correlation_id`, `consumer_id`, `account_id`, `endpoint`, `outcome`, `http_status`, `latency_ms`, `error_code` | **Append-only**: la app solo inserta. |
| `consumer_caps` | `consumer_id`, `endpoint`, `limit_hour`, `limit_day`, `limit_week` | Solo la **config** del cap; los contadores no viven acá (§7). |

Notas de implementación (de `catalyst.ts`):

- La impl mapea snake_case ↔ camelCase y usa ZCQL para lectura (`executeZCQLQuery`) y
  `insertRow`/`updateRow` para escritura. `scopes` se serializa como JSON string.
- `insertIfAbsent` intenta el `insertRow`; si el `UNIQUE(account_id, idempotency_key)`
  rechaza el segundo insert concurrente, relee el existente y devuelve `created: false`.
- El constraint `UNIQUE(account_id, idempotency_key)` **se crea en la consola de Catalyst**;
  no lo crea el código. Esquema y migraciones: ⚠️ verificar (docs oficiales/consola) —
  [docs/playbooks/datastore-esquema.md](docs/playbooks/datastore-esquema.md).

Esquema del POST (`schemas.ts`):

- `opportunityContactSchema` es `.strict()` → un campo extra en el body falla.
- `listInformesQuerySchema` es `.strict()` → un parámetro de query fuera de la allowlist
  (`estado`, `desde`, `hasta`, `matricula`, `cursor`, `limit`) → `422 UNPROCESSABLE`. Esto
  refuerza la tenancy: el consumidor no puede colar un filtro de Cuenta.

## 6. Modelo de seguridad y tenancy

**Tenancy: 1 automotora = 1 Cuenta CRM (`crm_account_id`, módulo Accounts) = 1
consumidor/token.** La Oportunidad se crea en el módulo Deals, en estado fijo
`Nueva Solicitud` fijado **server-side** (`FIXED_OPPORTUNITY_STAGE`), nunca del body.

| Mecanismo | Implementación |
|-----------|----------------|
| Autenticación | X-Api-Key token (`generateToken`: aleatorio ≥256 bits, base64url) → `sha256` (`hashToken`) → `api_tokens` resuelve `consumer_id` + `account_id` + `scopes`. El token plano nunca se persiste ni se loguea. |
| Autorización | `requireScope(scope)` por ruta: 403 `FORBIDDEN_SCOPE` si falta. Es el **único** uso de 403. |
| `accountId` SIEMPRE del token | El `account_id` se resuelve en `authMiddleware` y se inyecta en cada use-case/repo como primer argumento. **Jamás** viene del payload/query. |
| Cross-tenant → 404 | Pedir un informe de otra Cuenta no devuelve 403 (filtraría su existencia): el puerto filtra por `account_id` y devuelve `ReportNotFoundError` → **404 NOT_FOUND**. 403 queda reservado a scope. |
| Anti-enumeración de Cuenta | `listInformesQuerySchema.strict()`: cualquier intento de pasar un filtro de Cuenta por query → 422. |
| Secretos | Credenciales del CRM vía **Catalyst Connection** (OAuth gestionado) + Environment Variables; nunca en el repo (`.gitignore` + secret-scanning). El adapter recibe el token resuelto, no lo lee. |
| Auditoría | Middleware on-finish: 1 registro append-only por request en los 3 endpoints (`correlation_id`, `consumer_id`, `account_id`, `endpoint`, `outcome`, `http_status`, `latency_ms`, `error_code`). Sin payload ni PII. |
| Sin fuga upstream | El sobre de error usa etiquetas opacas (`crm`/`creator`/`workdrive`); nunca URL, fileId ni ruta interna. El stream del PDF va con `Cache-Control: no-store` y sin redirect 302. |

## 7. Cap de uso (rate limiting)

`cap(endpoint)` (`middleware/cap.ts`) cuenta en tres ventanas (hora/día/semana) por
`consumer_id` + endpoint lógico. La config sale de `consumer_caps` (`CapRepository`) con
fallback a los defaults de env (`CARDOC_CAP_DEFAULT_HOUR`/`DAY`/`WEEK`). Al exceder →
`429 CAP_EXCEEDED` con `Retry-After`; en cada respuesta setea `X-Cap-Window` /
`X-Cap-Limit` / `X-Cap-Remaining` de la ventana más ajustada.

> **Gate de plataforma**: hoy los contadores son **in-memory por contenedor** (`Map` en el
> middleware). Para un cap distribuido real (compartido entre contenedores calientes) el
> blueprint pide **Catalyst Cache** con TTL nativo e increment atómico. La atomicidad del
> increment en Catalyst Cache: ⚠️ verificar (docs oficiales/consola) — de-risk antes de
> producción. Hasta entonces el cap es por-instancia y aproximado.

## 8. Flujo del PDF (generación perezosa con caché)

El puerto `ReportsSource.openPdf(accountId, id)` encapsula el flujo; el use-case
`streamReportPdf` solo delega, y la ruta `streamPdfHandler` pipea el `Readable` a `res`
poniendo los headers **antes** del primer byte (`Content-Type`, `Content-Disposition`,
`Cache-Control: no-store`).

```
GET /v1/informes/:id/pdf
  → openPdf(accountId, id)         resuelve id→informe FILTRADO por la Cuenta del token
      ├─ informe no es de la Cuenta / no existe → ReportNotFoundError → 404 NOT_FOUND
      └─ leer Analisis.pdf_url:
           ├─ LLENO (link WorkDrive)  → stream desde WorkDrive
           └─ VACÍO                   → generar PDF en Catalyst
                                       → write-back del link a Analisis.pdf_url
                                       → stream
  → si no hay PDF ni se pudo generar → PdfNotAvailableError → 404 PDF_NOT_AVAILABLE
```

El form `Analisis` (campo `pdf_url`) en Zoho Creator es el **source of truth**: la primera
lectura genera y cachea; las siguientes reusan el link. El consumidor nunca ve la URL ni
la ubicación. Si el stream falla **antes** del primer byte → 502 `UPSTREAM_ERROR`
(`upstream: "workdrive"`); si ya empezó → se corta la conexión (`res.destroy`).

> **Open questions de negocio (no resueltas — no inventar)**:
> - **Cómo se genera** el PDF cuando `Analisis.pdf_url` está vacío: plantilla nativa de
>   Creator vs HTML→PDF en Catalyst vs servicio existente, y **de qué datos** sale.
> - **Relación** entre el form `Informes` y el form `Analisis`.
>
> **De-risk de plataforma (⚠️ verificar — docs oficiales/consola)**:
> - Streaming chunked real y tope de payload en Advanced I/O.

## 9. Build y deploy

- **TypeScript**: `pnpm exec tsc -b` (project references). Verde verificado en E-01.
- **Bundling** (`scripts/bundle-function.mjs`): esbuild, `format: cjs`, `target: node24`,
  `external: ['zcatalyst-sdk-node']` (lo provee el runtime; require lazy en datastore mode).
  Inlina `express`, `zod` y los `@cardoc/*`. **Catalyst NO instala las deps del `package.json`**
  — por eso `express` va inlineado (el smoke 2026-06-25 lo confirmó). Genera `index.js` (~1.3 MB). Entry: `src/index.ts` hace
  `export = app` (CommonJS); Catalyst hace `require(main)`.
- **Configs**: `apps/catalyst/catalyst.json` `{ functions: { source: 'functions',
  targets: ['api'] } }` · `functions/api/catalyst-config.json` `{ deployment: { name:'api',
  stack:'node24', type:'advancedio' }, execution: { main:'index.js' } }` ·
  `.catalystrc.example` (versionado) vs `.catalystrc` (gitignored). Timezone
  `America/Montevideo`. `package.json` raíz: `pnpm.onlyBuiltDependencies: ['esbuild']`.
- **Toolchain real**: Node 24.13, pnpm 10.29.2.

> **Gotcha de install** (red corporativa con CA propia / intercepción TLS):
> `NODE_OPTIONS=--use-system-ca pnpm install`.

Comandos exactos del CLI `catalyst` (init/deploy) y estructura de configs: confirmados.
Detalle fino del deploy/rollback: [docs/playbooks/deploy-y-rollback.md](docs/playbooks/deploy-y-rollback.md)
y [docs/playbooks/monorepo-build-y-bundling.md](docs/playbooks/monorepo-build-y-bundling.md).

### Variables de entorno

| Variable | Valores / uso |
|----------|---------------|
| `CARDOC_PERSISTENCE` | `datastore` \| (default) `memory` |
| `CARDOC_CRM_MODE` | `zoho` \| (default) `mock` |
| `CARDOC_REPORTS_MODE` | `creator` \| (default) `mock` |
| `CARDOC_CAP_DEFAULT_HOUR` / `_DAY` / `_WEEK` | Defaults del cap (1000 / 10000 / 50000). |
| `ZOHO_CRM_API_DOMAIN` | Dominio de la API de Zoho (default dev `https://www.zohoapis.com`). |
| `ZOHO_CRM_ACCESS_TOKEN` | Placeholder de dev; en producción lo provee la Connection. |
| `ZOHO_CRM_CONNECTOR_NAME` | Nombre del conector OAuth. |

Token de dev sembrado en memoria: `X-Api-Key: test-token` (todos los scopes, Cuenta `acc_dev`).

## 10. Decisiones de arquitectura (ADR-style)

Resumen. **Log canónico** (con contexto y consecuencia): [docs/decisions/README.md](docs/decisions/README.md).
Confirmadas por Nestor Toñanez, 2026-06-25.

| # | Decisión | Alternativa descartada | Rationale |
|---|----------|------------------------|-----------|
| 1 | **Catalyst como gateway de control** delante de Zoho; el DataStore guarda control (tokens, idempotencia, auditoría, caps), no negocio | CRM/Creator como única capa, sin gateway | Zoho no provee auth scoped por consumidor, idempotencia, cap ni auditoría uniforme; el gateway las centraliza y deja a Zoho como sistema de registro. |
| 2 | **Idempotencia en 2 capas:** `X-Idempotency-Key` opcional → DataStore Catalyst (Capa 1: fast-path + `409` payload-distinto) · `EXTERNAL_ID`=NroSolicitud único en el CRM → `DUPLICATE_DATA` (Capa 2: verdad durable) | header único obligatorio / depender solo del middleware | Defensa en profundidad: el header es opt-in al fast-path; el CRM nunca duplica. Ver [ADR-0002](docs/decisions/README.md#adr-0002). |
| 3 | **Dedup de Contacto por `NroCedula`** (campo `Cedula` custom en Contacts) | email (ML no lo manda) / teléfono | ML manda `NroCedula` y no email; la cédula es la identidad estable. Por eso `NroCedula` es requerido en el schema. |
| 4 | **Auth a Zoho CRM = Catalyst Connection** (OAuth gestionado) | Token estático en env / OAuth a mano | Catalyst gestiona refresh y rotación; el adapter recibe el `accessToken` resuelto y nunca toca secretos. |
| 5 | **Cross-tenant → 404** (no 403) | 403 para acceso cruzado | 403 confirmaría la existencia del recurso ajeno. 404 no filtra; 403 queda reservado a falta de scope. |
| 6 | **`accountId` siempre del token** | Aceptar `accountId` del payload/query | Es la base de la tenancy: el consumidor no puede elegir Cuenta. Reforzado con `.strict()` en la query. |
| 7 | **Auditoría on-finish, 1 registro/request, append-only** | Auditar dentro de cada use-case | Captura `httpStatus`/`latencyMs` ya conocidos al cierre; cubre también los GET (sin use-case) y los errores tempranos (401/403/429). |
| 8 | **Adapter de streaming/SDK en la capa function**, no en `packages/*` | Meter el SDK/stream en `persistence` o `providers` | Mantiene la regla hexagonal: dominio/puertos sin SDK; `persistence` usa el DataStore por tipado estructural. El sistema corre completo en local sin Catalyst. |
| 9 | **HTTP externo solo en `providers`** (adapters `Zoho*`) | Llamar a Zoho desde use-cases o rutas | Aísla el upstream tras un puerto: los Mock permiten e2e sin Zoho, y los adapters reales entran en E-02/E-03 sin tocar el resto. |
| 10 | **Bundle esbuild: inlina todo salvo `zcatalyst-sdk-node`** (express incluido; SDK del runtime, lazy) | externalizar `express` (Catalyst no instala las deps del `package.json`) | Smoke 2026-06-25: `express` external daba `Cannot find module`. Único external = `zcatalyst-sdk-node`. |
| 11 | **Contadores de cap in-memory por ahora** | Bloquear E-01 hasta tener Catalyst Cache | E-01 entrega un cap funcional por-instancia; el cap distribuido (Catalyst Cache, increment atómico) es de-risk pre-producción — ⚠️ verificar. |

## 11. Pendientes de validación (de-risk pre-producción)

Las open questions de **negocio** (generación del PDF, relación `Informes`↔`Analisis`,
API names de los módulos CRM estándar) y de **plataforma** (streaming/payload en
Advanced I/O, atomicidad del increment en Cache, setup de la Connection OAuth, residencia
de la PII, SLA/quotas/cold-start, retención de logs, backup/export del DataStore) viven en
el registro único — **[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)**. No se repiten acá
para evitar drift.

---

_Referencias: [README.md](README.md) · [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md) ·
[OPERACIONES.md](OPERACIONES.md) · [PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md) ·
[CONTRATOS.md](CONTRATOS.md) · [docs/README.md](docs/README.md) ·
playbooks: [catalyst-artefactos](docs/playbooks/catalyst-artefactos.md) ·
[monorepo-build-y-bundling](docs/playbooks/monorepo-build-y-bundling.md) ·
[deploy-y-rollback](docs/playbooks/deploy-y-rollback.md) ·
[secretos-y-connections](docs/playbooks/secretos-y-connections.md) ·
[datastore-esquema](docs/playbooks/datastore-esquema.md) ·
runbooks: [_template](docs/runbooks/_template.md)_
