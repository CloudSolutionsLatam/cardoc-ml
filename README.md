---
title: cardoc-ml — API Catalyst (opportunity-contact + informes de revisión)
status: E-02 completo (alta real validada en Catalyst)
last_reviewed: 2026-06-30
---

# cardoc API

API en **Zoho Catalyst** (Advanced I/O) para automotoras. Tres endpoints `/v1`:

| Endpoint | Scope | Qué hace |
|----------|-------|----------|
| `POST /v1/opportunity-contact` | `opportunities:create` | Crea/reutiliza Contacto (dedup por cédula) + crea Oportunidad `Nueva Solicitud` en **Zoho CRM** (Deals/Accounts). Payload plano de ML; idempotente por `NroSolicitud`. |
| `GET /v1/informes` | `reports:read` | ⛔ **Descartado** ([ADR-0015](docs/decisions/README.md#adr-0015)): ML es push (outbound E-07), no pull. |
| `GET /v1/informes/{id}/pdf` | `reports:pdf` | Stream autenticado del PDF, sin URL pública ni ubicación interna. |

> **Estado: E-02 completo y deployable.** Verde verificado: `tsc -b`, `eslint`, bundle esbuild,
> 25 tests (vitest) + smoke local 21/21, y **alta real validada en Catalyst** (datastore + Zoho CRM)
> vía `smoke-catalyst-crm.mjs` 5/5 (Deal en stage `Nueva Solicitud`). El adapter
> **CRM (`ZohoCrmClient`) ya está implementado y validado** (E-02); solo
> `ZohoCreatorReportsSource` (Creator/WorkDrive) sigue stub → entra en E-03.
>
> ```bash
> pnpm install && pnpm -r run typecheck && pnpm -r run test && pnpm run lint
> ```
>
> En la red corporativa (intercepción TLS con CA propia) el `pnpm install` necesita la
> CA del sistema: `NODE_OPTIONS=--use-system-ca pnpm install`.

## Documentación

> **¿Arrancás una sesión de IA?** Empezá por [docs/ASSISTANT.md](docs/ASSISTANT.md) — la
> puerta de entrada: árbol de decisión por tarea, vocabulario y reglas duras. Fijala con
> `@docs/ASSISTANT.md`.

| Documento | Contenido |
|-----------|-----------|
| [docs/ASSISTANT.md](docs/ASSISTANT.md) | **Puerta de entrada para sesiones de IA**: qué abrir según la tarea + reglas |
| [ARQUITECTURA.md](ARQUITECTURA.md) | Diseño técnico: hexagonal, pipeline de middlewares, modelo de datos, seguridad, ADRs |
| [CONTRATOS.md](CONTRATOS.md) | Referencia de la API: endpoints, headers, sobre de error, ejemplos curl (entregable E-06) |
| [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md) | Atributos rectores + targets/"cómo se verifica" + validaciones de plataforma |
| [OPERACIONES.md](OPERACIONES.md) | Entornos, deploy/rollback, onboarding, monitoreo, runbooks, rotaciones |
| [PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md) | Épicas E-01..E-06, milestones, estado, estrategia de testing |
| [docs/decisions/](docs/decisions/README.md) | Log de decisiones de arquitectura (ADRs) |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Registro único de preguntas abiertas (negocio + plataforma) |
| [docs/reference/crm-data-model.md](docs/reference/crm-data-model.md) | Mapa de api_names del CRM (Contacts/Deals/Accounts/Products) para el adapter `ZohoCrmClient` |
| [docs/](docs/README.md) | Índice de **playbooks** (Catalyst, build/bundling, deploy, secretos, DataStore) y **runbooks** |

## Estructura

Monorepo **pnpm workspaces** + TypeScript, ports & adapters (hexagonal).

| Ruta | Contenido |
|------|-----------|
| `packages/domain/` | Dominio puro: tipos, schemas Zod, idempotencia, tokens. Sin SDK de Catalyst. |
| `packages/providers/` | Puertos `CrmClient` + `ReportsSource` y adapters (Mock + Zoho stubs). **Único** lugar con HTTP externo. |
| `packages/persistence/` | Tipos de fila + puertos de repositorio (DataStore) + impl in-memory. |
| `packages/application/` | Use-cases: `createOpportunityContact`, `listInformes`, `streamReportPdf`. |
| `apps/catalyst/functions/api/` | Catalyst Advanced I/O: `catalyst.json` + function `api` (3 endpoints + middlewares). |

## Seguridad y tenancy

- **X-Api-Key token por integración** con scopes; solo se persiste el `sha256` del token.
- **Tenancy**: el `accountId` (Cuenta CRM = automotora) se resuelve SIEMPRE del token,
  nunca del payload/query. Acceso cruzado → **404** (no 403).
- **Secretos solo backend**: credenciales en Catalyst Environment Variables; el repo nunca
  los contiene (`.gitignore` + secret-scanning en CI).
- **Idempotencia** (POST): 2 capas — `X-Idempotency-Key` opcional (Catalyst: replay→`200`, payload
  distinto→`409`) + `EXTERNAL_ID`=NroSolicitud único en el CRM (`DUPLICATE_DATA`). Ver ADR-0002.
- **Cap** configurable hora/día/semana por consumidor+endpoint → `429 CAP_EXCEEDED`.
- **Auditoría**: middleware on-finish escribe 1 registro por request (status + latencia +
  correlationId) en los 3 endpoints. Append-only.

### Sobre de error único (los 3 endpoints)

```jsonc
{ "error": { "code": "CAP_EXCEEDED", "message": "...", "correlationId": "uuid", "details": { } } }
```

Códigos: `VALIDATION_ERROR` (400) · `UNAUTHENTICATED` (401) · `FORBIDDEN_SCOPE` (403) ·
`NOT_FOUND` / `PDF_NOT_AVAILABLE` (404) · `IDEMPOTENCY_CONFLICT` (409) · `UNPROCESSABLE` (422) ·
`CAP_EXCEEDED` (429) · `UPSTREAM_ERROR` (502) · `INTERNAL_ERROR` (500).

## Desarrollo local

Corre la API **sin Catalyst** (no depende del hosting): el `app` Express es host-agnóstico —
Catalyst es solo un host. `pnpm dev` compila y lo levanta standalone:

```bash
pnpm dev     # tsc -b + node --env-file-if-exists=.env scripts/dev-server.mjs  → :3030
curl http://127.0.0.1:3030/v1/health
# PORT=3031 pnpm dev   para cambiar el puerto (3000 suele tenerlo la API del ERP / NestJS)
```

Por defecto: persistencia in-memory + Mock CRM/Reports/ML, token de dev `X-Api-Key: test-token`
(todos los scopes, Cuenta `acc_dev`). Para apuntar a servicios reales flipeá los flags y
cargá los secretos en `.env` ([.env.example](.env.example); se carga con `--env-file-if-exists`).
Lo único atado a Catalyst es el adapter DataStore (solo con `CARDOC_PERSISTENCE=datastore`);
el resto corre 100% local.

## Deploy

```bash
# 1) build + materialización del SDK real en el function dir
pnpm --filter @cardoc/fn-api predeploy    # build (tsc -b + esbuild → index.js) + deploy:prep

# 2) deploy de la function (desde apps/catalyst, con la CA corporativa)
cd apps/catalyst
NODE_OPTIONS=--use-system-ca catalyst deploy --only functions:api --ignore-scripts
```

El bundle esbuild inlina `express`, `zod` y los `@cardoc/*`; `zcatalyst-sdk-node` es la
**excepción**: se externaliza (lista única en `scripts/function-externals.mjs`) y `deploy:prep`
(`scripts/deploy-prep-sdk.mjs`) lo shippea como `node_modules` **real** en el function dir.
Catalyst no instala las deps del `package.json`.

> **Gotcha**: tras cualquier `pnpm install`, pnpm restaura el symlink del SDK → re-corré
> `predeploy` (o `deploy:prep`) antes de deployar, o el runtime falla con
> `Cannot find module`. Procedimiento completo: [playbooks/deploy-y-rollback.md](docs/playbooks/deploy-y-rollback.md).

## Open questions (E-03)

Registro único: **[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)** — negocio (generación
del PDF, relación `Informes`↔`Analisis`, API names de los módulos CRM estándar) y
plataforma (streaming, Cache, Connection, residencia PII, SLA, logs, backup).
