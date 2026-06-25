---
title: cardoc-ml — API Catalyst (opportunity-contact + informes de revisión)
status: scaffolding
last_reviewed: 2026-06-25
---

# cardoc API

API en **Zoho Catalyst** (Advanced I/O) para automotoras. Tres endpoints `/v1`:

| Endpoint | Scope | Qué hace |
|----------|-------|----------|
| `POST /v1/opportunity-contact` | `opportunities:create` | Crea/reutiliza Contacto (dedup por documento) + crea Oportunidad en estado fijo `Agendamiento Ready` en **Zoho CRM** (Deals/Accounts). Idempotente por `X-Idempotency-Key`. |
| `GET /v1/informes` | `reports:read` | Lista los Informes de Revisión de la automotora autenticada (filtros controlados + cursor). Fuente: **Zoho Creator**. |
| `GET /v1/informes/{id}/pdf` | `reports:pdf` | Stream autenticado del PDF, sin URL pública ni ubicación interna. |

> **Estado: E-01 completo y deployable.** Verde verificado: `tsc -b`, 7 tests (vitest),
> `eslint`, smoke e2e 16/16 y bundle esbuild. El thin-slice del POST corre end-to-end
> contra el path in-memory + Mock CRM. Los adapters reales (Zoho CRM / Creator / WorkDrive)
> y el DataStore entran en E-02/E-03.
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

- **Bearer token por integración** con scopes; solo se persiste el `sha256` del token.
- **Tenancy**: el `accountId` (Cuenta CRM = automotora) se resuelve SIEMPRE del token,
  nunca del payload/query. Acceso cruzado → **404** (no 403).
- **Secretos solo backend**: credenciales en Catalyst Environment Variables; el repo nunca
  los contiene (`.gitignore` + secret-scanning en CI).
- **Idempotencia** (POST): `UNIQUE(account_id, X-Idempotency-Key)`; misma clave + payload
  distinto → `409 IDEMPOTENCY_CONFLICT`.
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

Por defecto: persistencia in-memory + Mock CRM/Reports/ML, token de dev `Bearer test-token`
(todos los scopes, Cuenta `acc_dev`). Para apuntar a servicios reales flipeá los flags y
cargá los secretos en `.env` ([.env.example](.env.example); se carga con `--env-file-if-exists`).
Lo único atado a Catalyst es el adapter DataStore (solo con `CARDOC_PERSISTENCE=datastore`);
el resto corre 100% local.

## Deploy

```bash
catalyst init          # primera vez: vincula proyecto/env (genera .catalystrc)
pnpm --filter @cardoc/fn-api run build   # tsc -b + esbuild → index.js bundleado
catalyst deploy
```

## Open questions (E-02/E-03)

Registro único: **[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)** — negocio (generación
del PDF, relación `Informes`↔`Analisis`, módulos CRM, picklist `Agendamiento Ready`) y
plataforma (streaming, Cache, Connection, residencia PII, SLA, logs, backup).
