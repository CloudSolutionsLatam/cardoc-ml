---
title: cardoc — Plan de Desarrollo
status: en-ejecucion
last_reviewed: 2026-06-25
---

# Plan de Desarrollo — cardoc API (Catalyst)

Plan de construcción que ejecuta la API `/v1` descrita en el [README.md](README.md), sobre la
[ARQUITECTURA.md](ARQUITECTURA.md) y con los targets de [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md)
como criterio de salida. El detalle de runtime y operación vive en [OPERACIONES.md](OPERACIONES.md);
el contrato de los endpoints en [CONTRATOS.md](CONTRATOS.md).

**Equipo**: 1 desarrollador. **Owner**: Nestor Toñanez. **Sprint**: 22/06 → 03/07/2026 (2 semanas
calendario). **Toolchain real verificado**: node 24.13, pnpm 10.29.2.

> **Estado al 2026-06-25**: **E-01 completo y verificado** (typecheck, tests, lint, smoke e2e y
> bundle en verde). **E-02 / E-03** tienen puertos y lógica de dominio listos; los adapters reales
> (Zoho CRM, Creator/WorkDrive, DataStore productivo) son stubs `NotImplemented` y están
> **bloqueados por las open questions** del cierre de este documento.

---

## 1. Mapa épicas ↔ cronograma ↔ owner

Una sola persona, dos semanas. El plan es secuencial por dependencia técnica, no por workstreams
paralelos. El de-risk de plataforma corre en paralelo porque no toca código.

| Épica | Alcance | Estado | Owner | Ventana |
|-------|---------|--------|-------|:-------:|
| **E-01** | Scaffold monorepo + hexagonal: dominio, puertos, use-cases, function Express, middlewares, mocks, CI, bundle, deploy-ready | ✅ **Completo y verificado** | Nestor | 22/06 |
| **E-02** | Adapters reales CRM: `ZohoCrmClient` (Contacts/Deals/Accounts) + Catalyst Connection OAuth + persistencia DataStore productiva | 🟡 Puertos + lógica listos; adapter stub | Nestor | 23–26/06 |
| **E-03** | Adapters reales Informes: `ZohoCreatorReportsSource` + WorkDrive + flujo PDF (lazy generate + write-back) | 🟡 Puertos + lógica listos; adapter stub | Nestor | 26–30/06 |
| **E-04** | Cap distribuido sobre Catalyst Cache (hoy contadores in-memory por contenedor) | ⬜ Pendiente | Nestor | 30/06–01/07 |
| **E-05** | Hardening de seguridad + tenancy: matriz scope × endpoint, cross-tenant 404, secret-scan en verde sostenido | ⬜ Parcial (gates ya en CI) | Nestor | 01–02/07 |
| **E-06** | Deploy a Catalyst dev + smoke e2e contra el entorno real + runbooks dry-run | ⬜ Pendiente | Nestor | 02–03/07 |
| **QA** | Transversal: gates de CI verdes en cada push, smoke post-deploy | 🟡 Continuo | Nestor | 22/06–03/07 |

**Lectura honesta del cronograma**: 1 dev en 2 semanas cubre E-01 (hecho) + E-02/E-03 **solo si**
las open questions de CRM y PDF se resuelven en los primeros 2 días. Cada open question abierta al
26/06 empuja su épica hacia afuera del sprint. Esto no es pesimismo: es la diferencia entre un plan
ejecutable y un deseo.

---

## 2. Criterios de aceptación (AC-01..AC-10) ↔ dónde se verifican

Los AC son el criterio de salida. Varios ya están **anclados en el código y en tests** de E-01;
otros se cierran al entrar los adapters reales. La columna "Verificación" apunta al artefacto que lo
demuestra (no a una afirmación).

| AC | Criterio | Estado | Verificación (anclaje en código) |
|----|----------|--------|----------------------------------|
| **AC-01** | Los 3 endpoints `/v1` responden con el contrato definido; `/v1/health` abierto sin auth | ✅ E-01 | `apps/catalyst/functions/api/src/app.ts` (rutas + health), `routes/opportunity-contact.ts`, `routes/informes.ts` |
| **AC-02** | Validación de forma: payload y query validados con Zod; query `.strict()` rechaza filtros fuera de allowlist → 422 | ✅ E-01 | `packages/domain/src/schemas.ts` (`opportunityContactSchema`, `listInformesQuerySchema.strict()`); `routes/informes.ts` |
| **AC-03** | Sobre de error único `{ error: { code, message, correlationId, details? } }` con el catálogo completo de códigos/status | ✅ E-01 | `apps/catalyst/functions/api/src/middleware/errors.ts` (`ApiError`, `errorMiddleware`); ver [CONTRATOS.md](CONTRATOS.md) |
| **AC-04** | Correlación: `X-Correlation-Id` validado como UUID o regenerado, propagado en respuesta y auditoría | ✅ E-01 | `middleware/auth.ts` (`correlationMiddleware`, `UUID_RE`) |
| **AC-05** | Autenticación X-Api-Key: solo se persiste el `sha256` del token; token plano nunca se loguea ni guarda; vigencia (expiración/revocación) chequeada | ✅ E-01 (in-memory); 🟡 E-02 (DataStore real) | `middleware/auth.ts` (`authMiddleware`, `hashToken`), `packages/domain/src/tokens.ts`, `packages/persistence/src/entities.ts` |
| **AC-06** | Tenancy: `accountId` resuelto SIEMPRE del token, nunca del payload/query | ✅ E-01 | `middleware/auth.ts` (setea `req.accountId` del token), use-cases reciben `accountId` del `ctx`, no del body |
| **AC-07** | Cap configurable hora/día/semana por consumidor+endpoint → 429 `CAP_EXCEEDED` con `Retry-After` | 🟡 E-01 (in-memory por contenedor); ⬜ E-04 (distribuido en Cache) | `middleware/cap.ts` (3 ventanas, headers `X-Cap-*`, `Retry-After`) |
| **AC-08** | Idempotencia POST: `UNIQUE(account_id, idempotency_key)` (= `String(NroSolicitud)`) + `payloadFingerprint`; mismo NroSolicitud + payload distinto → 409; idempotencia por tenant | ✅ E-01 (lógica + tests); 🟡 E-02 (UNIQUE físico en DataStore) | `packages/application/src/create-opportunity-contact.ts`, `packages/domain/src/idempotency.ts`, `packages/persistence/src/catalyst.ts` (`insertIfAbsent`), test `create-opportunity-contact.test.ts` (5 casos) |
| **AC-09** | Auditoría append-only: middleware on-finish, 1 registro por request en los 3 endpoints; sin PII/payload/bytes de PDF | ✅ E-01 | `middleware/audit.ts` (`auditOnFinish`), `entities.ts` (`AuditLogEntry`), `catalyst.ts` (`append`, sin update/delete) |
| **AC-10** | Cross-tenant: acceso a recurso de otra Cuenta → 404 (no 403); 403 reservado a scope insuficiente | 🟡 E-01 (forma); ✅ al entrar adapter real | `routes/informes.ts` (`openPdf` valida tenancy → 404), `middleware/auth.ts` (`requireScope` → 403 solo por scope) |

> **Nota sobre la numeración AC**: AC-06..AC-10 están citados explícitamente en el código fuente
> (`entities.ts`, `cap.ts`, `audit.ts`, `auth.ts`, el test de idempotencia). AC-01..AC-05 mapean al
> comportamiento ya implementado y verificado de los endpoints, la validación, el sobre de error, la
> correlación y la autenticación. La definición canónica de cada AC vive en
> [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md).

---

## 3. Milestones con "definición de hecho"

| Milestone | Definición de "hecho" | Épicas | Objetivo |
|-----------|----------------------|--------|:--------:|
| **M0 — Scaffold deployable** | Monorepo hexagonal en verde: `tsc -b`, vitest, eslint (fronteras), smoke e2e, bundle esbuild → `index.js`. Function desplegable con mocks. AC-01..AC-04, AC-06, AC-08 (lógica), AC-09 cubiertos | E-01 | ✅ 22/06 |
| **M1 — CRM real e2e** | `POST /v1/opportunity-contact` crea Contacto+Oportunidad real en Zoho CRM vía Connection OAuth, con `CARDOC_CRM_MODE=zoho` y `CARDOC_PERSISTENCE=datastore`. UNIQUE físico activo. AC-05/AC-08 cerrados contra plataforma | E-02 | 26/06 |
| **M2 — Informes + PDF real** | `GET /v1/informes` lista desde Creator; `GET /v1/informes/:id/pdf` streamea PDF real (lazy generate + write-back a `Analisis.pdf_url`). AC-10 cerrado contra plataforma | E-03 | 30/06 |
| **M3 — Cap distribuido + hardening** | Cap atómico sobre Catalyst Cache (no in-memory); matriz scope × endpoint verde; cross-tenant 404 verificado; secret-scan limpio | E-04, E-05 | 01/07 |
| **M4 — Producción dev verificada** | Deploy a Catalyst dev; smoke e2e contra el entorno real verde; runbooks con dry-run ejecutado | E-06 | 03/07 |

**Regla de salida**: ningún milestone se da por "hecho" sin su gate de CI en verde y, para M1/M2/M4,
sin un smoke contra el componente real (no mock). Un milestone sin evidencia ejecutable no está hecho.

---

## 4. E-01 — Scaffold (cerrado y verificado)

Estado de hecho, documentado para trazabilidad. Lo construido y en verde:

| Componente | Entregable | Anclaje |
|------------|-----------|---------|
| `@cardoc/domain` | Tipos, schemas Zod, `payloadFingerprint`, `hashToken`/`generateToken`. Node puro, sin SDK | `packages/domain/src/{types,schemas,idempotency,tokens}.ts` |
| `@cardoc/providers` | Puertos `CrmClient` + `ReportsSource` + errores tipados; `MockCrmClient`/`MockReportsSource` funcionales; `ZohoCrmClient`/`ZohoCreatorReportsSource` stubs. **Único** lugar con HTTP externo | `packages/providers/src/{crm-client,reports-source,errors}.ts` |
| `@cardoc/persistence` | Entities, repositorios (puertos), `catalyst.ts` (impl DataStore por tipado estructural, sin importar el SDK), `memory.ts` (fakes) | `packages/persistence/src/{entities,repositories,catalyst,memory}.ts` |
| `@cardoc/application` | Use-cases `createOpportunityContact`, `listInformes`, `streamReportPdf` | `packages/application/src/*.ts` |
| `@cardoc/fn-api` | Function Advanced I/O (stack node24): `index.ts` → `export = app` (CommonJS), `app.ts` arma el Express; pipeline de middlewares de orden fijo | `apps/catalyst/functions/api/src/*` |
| CI + bundle | Workflow con typecheck/test/lint/secret-scan; `bundle-function.mjs` (esbuild, cjs, target node24, external `zcatalyst-sdk-node` (express inline)) → `index.js` (~1.3 MB) | `.github/workflows/ci.yml`, `scripts/bundle-function.mjs` |

**Verificación en verde (toolchain real)**:

```bash
# Red corporativa con CA propia / intercepción TLS — sin esto, el install falla en el handshake:
NODE_OPTIONS=--use-system-ca pnpm install

pnpm -r run typecheck   # tsc -b (project references)
pnpm -r run test        # vitest: 7 tests
pnpm run lint           # eslint (fronteras hexagonales)
# smoke e2e: 16/16
pnpm --filter @cardoc/fn-api run build   # tsc -b + esbuild → index.js
```

> **GOTCHA de install**: en la red corporativa el `pnpm install` requiere
> `NODE_OPTIONS=--use-system-ca`. Sin la CA del sistema, el install rompe en TLS. Va en el README
> y debe ir en cualquier runbook de onboarding.

---

## 5. E-02 — Adapters CRM reales (bloqueada por open questions)

**Listo**: el puerto `CrmClient`, el use-case `createOpportunityContact` (con la garantía
anti-duplicación), el repo DataStore (`CatalystOpportunitiesRepository.insertIfAbsent` que captura el
rechazo del UNIQUE), y el contrato de la `CrmConnection`.

**Pendiente (adapter `ZohoCrmClient`)**:

| Tarea | Salida | Bloqueo |
|-------|--------|---------|
| Implementar `findContactByCedula` / `createContact` / `createOpportunity` contra Zoho CRM REST | Stubs `NotImplemented` → HTTP real | **CRM-Q1** (API names de módulos estándar); CRM-Q2 ✅ resuelta |
| Resolver la Catalyst Connection OAuth en runtime (hoy `resolveCrmConnection` devuelve stub) | `accessToken` real desde la Connection gestionada | **CAT-Q5** (setup Connection) |
| Activar `CARDOC_PERSISTENCE=datastore`: crear tablas y el `UNIQUE(account_id, idempotency_key)` en consola | Idempotencia con red física, no solo lógica | **CAT-Q2** (atomicidad) — el UNIQUE del DataStore es el ancla; ⚠️ verificar (docs oficiales/consola) que el `insertRow` rechaza el segundo concurrente |
| Sembrar `consumers` + `api_tokens` reales (hash del token, scopes, Cuenta) | 1 automotora = 1 Cuenta CRM = 1 token | — |

**Definición de hecho (M1)**: con `CARDOC_CRM_MODE=zoho` y `CARDOC_PERSISTENCE=datastore`, un POST
real crea Contacto (dedup por cédula `NroCedula`) + Oportunidad en estado `Nueva Solicitud`
(fijado server-side, módulo Deals); reintento con mismo `NroSolicitud` → `duplicate`; mismo número con
payload distinto → 409.

---

## 6. E-03 — Adapters Informes + PDF reales (bloqueada por open questions)

**Listo**: el puerto `ReportsSource`, los use-cases `listInformes` / `streamReportPdf`, el handler
que streamea sin exponer URL pública ni ubicación interna (`Content-Disposition`, `Cache-Control:
no-store`, manejo de error de stream → 502).

**Pendiente (adapter `ZohoCreatorReportsSource`)**:

| Tarea | Salida | Bloqueo |
|-------|--------|---------|
| `listByAccount` / `findById` contra Creator (form `Informes`, filtro de Cuenta agregado por backend) | Stub → lectura real | **CRM/PDF-Q** (relación `Informes` ↔ `Analisis`) |
| `openPdf`: leer `Analisis.pdf_url`; si lleno → stream desde WorkDrive; si vacío → **generar PDF + write-back** | PDF servido sin URL pública | **PDF-Q1, PDF-Q2** (cómo se genera y de qué datos) |
| Validación de tenancy en `openPdf`: recurso de otra Cuenta → 404 (AC-10) | Cross-tenant indistinguible de inexistente | — |

**Definición de hecho (M2)**: con `CARDOC_REPORTS_MODE=creator`, el listado y el stream del PDF
funcionan contra Creator/WorkDrive reales, con el flujo lazy-generate + write-back operativo, y un
PDF ajeno a la Cuenta del token devuelve 404.

---

## 7. Estrategia de testing y gates de CI

El criterio: cada AC tiene un test que lo viola si se rompe. Los gates corren en cada push
(`.github/workflows/ci.yml`).

| Nivel | Qué cubre | Estado | Cuándo corre |
|-------|-----------|--------|--------------|
| **Unit (dominio)** | `payloadFingerprint` determinístico/insensible al orden; `hashToken` estable y no reversible | ✅ 3 tests | CI, cada push |
| **Use-cases** | `createOpportunityContact`: crea / duplicate / conflict / idempotencia por tenant (AC-08) | ✅ 4 tests | CI, cada push |
| **Contract (adapters)** | Cada adapter Zoho contra sandbox/entorno real | ⬜ Pendiente (E-02/E-03) — `packages/providers` hoy `passWithNoTests` | CI nightly + pre-release |
| **Integración (repos)** | Repos DataStore reales, auth, idempotencia física, scope cruzado | ⬜ Pendiente (E-02) — `packages/persistence` hoy `passWithNoTests` | CI, cada push (tras E-02) |
| **Smoke e2e** | Thin-slice del POST end-to-end (in-memory + Mock CRM) — 16/16 en verde | ✅ E-01 | Cada push + post-deploy |
| **Lint (fronteras)** | eslint que prohíbe `fetch`/HTTP fuera de `packages/providers` y el SDK fuera de la capa function | ✅ | CI, cada push |
| **Secret-scan** | gitleaks sobre la historia completa (`fetch-depth: 0`), binario directo (sin licencia del wrapper) | ✅ Gate | CI, cada push |

**Gates específicos que deben quedar verdes antes de M3** (matriz de fitness de seguridad):

| Gate | Qué prueba | Resultado esperado |
|------|-----------|--------------------|
| **A → B = 404** | Token de Cuenta A pide un informe/PDF de Cuenta B | 404 (no 403, no 200) — AC-10 |
| **Idempotencia concurrente** | Dos POST simultáneos con misma `(account_id, idempotency_key)` | 1 creado + 1 duplicate; nunca 2 Oportunidades — AC-08 |
| **Matriz scope × endpoint** | Cada token con scope insuficiente contra cada endpoint protegido | 403 `FORBIDDEN_SCOPE` (no 404, no 200) — AC-10 vs scope |
| **Secret-scan** | Repo + historia | Cero hallazgos |

> La idempotencia concurrente y el A→B=404 **reales** se cierran contra el DataStore (E-02) y los
> adapters (E-03); en E-01 están cubiertos a nivel de lógica/use-case con fakes. El UNIQUE del
> DataStore es la red física: ⚠️ verificar (docs oficiales/consola) el comportamiento exacto del
> `insertRow` ante violación de UNIQUE concurrente antes de declarar el gate cerrado.

---

## 8. Build, bundle y deploy

Confirmado en el repo:

```bash
# 1) Compilar el monorepo (project references)
pnpm exec tsc -b

# 2) Bundlear la function (esbuild → index.js cjs, external zcatalyst-sdk-node (express inlineado))
pnpm --filter @cardoc/fn-api run build

# 3) Primera vez: vincular proyecto/env (genera .catalystrc, gitignored)
catalyst init

# 4) Deploy
catalyst deploy
```

**Configs versionadas** (anclaje real):
- `apps/catalyst/catalyst.json` → `{ functions: { source: "functions", targets: ["api"] } }`
- `apps/catalyst/functions/api/catalyst-config.json` → `{ deployment: { name: "api", stack: "node24", type: "advancedio" }, execution: { main: "index.js" } }`
- `apps/catalyst/.catalystrc.example` (plantilla versionada, timezone `America/Montevideo`) vs `.catalystrc` (gitignored, IDs reales)
- `package.json` raíz: `pnpm.onlyBuiltDependencies: ["esbuild"]`

> El CLI `catalyst init` / `catalyst deploy` y la estructura de configs están **confirmados**. Los
> flags finos del deploy, las quotas del plan y el comportamiento de cold-start: ⚠️ verificar
> (docs oficiales/consola). Detalle operativo y rollback en
> [docs/playbooks/deploy-y-rollback.md](docs/playbooks/deploy-y-rollback.md) y
> [docs/playbooks/monorepo-build-y-bundling.md](docs/playbooks/monorepo-build-y-bundling.md).

---

## 9. Variables de entorno (toggles de modo)

El container (`apps/catalyst/functions/api/src/container.ts`) compone los adapters según estos flags.
En dev todo corre con mocks; en Catalyst los secretos viven en Console → Environment Variables,
nunca en el repo.

| Variable | Valores | Default dev |
|----------|---------|-------------|
| `CARDOC_PERSISTENCE` | `datastore` \| (otro → memory sembrado) | `memory` |
| `CARDOC_CRM_MODE` | `zoho` \| (otro → MockCrmClient) | `mock` |
| `CARDOC_REPORTS_MODE` | `creator` \| (otro → MockReportsSource) | `mock` |
| `CARDOC_CAP_DEFAULT_HOUR/DAY/WEEK` | enteros (fallback si el consumidor no tiene cap propio) | 1000 / 10000 / 50000 |
| `ZOHO_CRM_API_DOMAIN` | dominio de API Zoho | `https://www.zohoapis.com` |
| `ZOHO_CRM_ACCESS_TOKEN` | fallback dev-only; **no figura en `.env.example`** (en prod lo resuelve la Connection) | `dev-token` |
| `ZOHO_CRM_CONNECTOR_NAME` | nombre del conector | `zoho_crm_conn` |

Token de dev sembrado en memoria: `X-Api-Key: test-token` (todos los scopes, Cuenta `acc_dev`).
Esquema completo del DataStore en
[docs/playbooks/datastore-esquema.md](docs/playbooks/datastore-esquema.md); manejo de la Connection
OAuth y secretos en [docs/playbooks/secretos-y-connections.md](docs/playbooks/secretos-y-connections.md).

---

## 10. Dependencias externas (fuera del control del dev)

| Dependencia | Impacta a | Mitigación |
|-------------|-----------|------------|
| Definición del negocio de PDF (cómo se genera, de qué datos, relación `Informes`↔`Analisis`) | E-03 / M2 | Resolver con el dueño funcional **antes** del 26/06; sin esto E-03 no arranca |
| API names exactos de los módulos estándar Contacts/Deals/Accounts (Stage = `Nueva Solicitud` ✅; campos `Cedula`/`EXTERNAL_ID` ✅ creados) | E-02 / M1 | Confirmar los API names estándar con quien administra el CRM; el resto del mapeo ya está |
| Setup de la Catalyst Connection OAuth a CRM | E-02 / M1 | Provisionar en consola en paralelo a E-01→E-02 |
| Validaciones de plataforma Catalyst (de-risk pre-producción) | E-04 / M3 / M4 | Correr en paralelo, no toca código de E-01 |

---

## 11. Open questions / validaciones de plataforma pendientes

Marcadas como tales. **No se resuelven inventando**: se cierran con el dueño funcional (negocio/CRM)
o con la consola/docs de Catalyst.

### Negocio (bloquean E-02/E-03)

- **PDF-Q1**: cuando `Analisis.pdf_url` está vacío, ¿cómo se genera el PDF? (plantilla nativa de
  Creator vs HTML→PDF en Catalyst vs servicio existente).
- **PDF-Q2**: ¿de qué datos sale el PDF y cuál es la relación entre los forms `Informes` y `Analisis`?
- **CRM-Q1**: API names exactos de los módulos Contacts / Deals / Accounts.
- **CRM-Q2**: ✅ Resuelto (Nestor 2026-06-30) — Stage de Deals = `Nueva Solicitud` (provisional); campos custom `Cedula` (Contacts) y `EXTERNAL_ID` (Deals) creados.

### Plataforma Catalyst (de-risk antes de producción)

Los detalles finos de Cache / Connections / quotas **no están confirmados** en el repo ni en los
HECHOS — todos llevan ⚠️ verificar (docs oficiales/consola):

- **CAT-Q1**: streaming/chunked real y tope de payload en Advanced I/O. ⚠️ verificar (docs oficiales/consola).
- **CAT-Q2**: atomicidad del increment en Catalyst Cache para el cap distribuido (hoy los contadores
  son in-memory por contenedor, ver `middleware/cap.ts`). ⚠️ verificar (docs oficiales/consola).
- **CAT-Q3**: comportamiento del `UNIQUE(account_id, idempotency_key)` ante inserts concurrentes en
  el DataStore (la red física de AC-08). ⚠️ verificar (docs oficiales/consola).
- **CAT-Q4**: región / residencia de datos para PII (UY / AR / Wyoming). ⚠️ verificar (docs oficiales/consola).
- **CAT-Q5**: setup y rotación de la Connection OAuth a CRM. ⚠️ verificar (docs oficiales/consola).
- **CAT-Q6**: SLA / quotas / cold-start del plan contratado. ⚠️ verificar (docs oficiales/consola).
- **CAT-Q7**: retención de logs y mecanismo de backup/export del DataStore. ⚠️ verificar (docs oficiales/consola).

---

## 12. Runbooks pendientes (dry-run pre-producción)

A escribir desde [docs/runbooks/_template.md](docs/runbooks/_template.md) antes de M4, cada uno con
su dry-run: outage de CRM · outage de Creator/WorkDrive · cap mal configurado · token comprometido
(rotación de emergencia) · PDF que no se genera (`Analisis.pdf_url` vacío). Un runbook sin dry-run es
una expresión de deseo.

---

_Arquitectura: [ARQUITECTURA.md](ARQUITECTURA.md) · Calidad: [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md) ·
Operación: [OPERACIONES.md](OPERACIONES.md) · Contrato: [CONTRATOS.md](CONTRATOS.md) ·
Playbooks: [docs/README.md](docs/README.md)_
