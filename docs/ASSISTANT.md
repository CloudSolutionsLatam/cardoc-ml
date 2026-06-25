---
title: Assistant onboarding — cardoc-ml
status: active
document_type: assistant-onboarding
last_reviewed: 2026-06-25
last_synced_with: working-tree (E-01, sin commit aún)
---

# Assistant onboarding — cardoc-ml

> **Fijá este archivo al empezar una sesión.** Pasá `@docs/ASSISTANT.md` en el
> prompt y el asistente sabrá qué hay construido, qué lo restringe y qué artefacto
> abrir según el tipo de tarea que describas.

Este archivo es la **puerta de entrada** a cualquier sesión de IA en este proyecto.
No reemplaza a las instrucciones organizacionales de Unicorp (que aplican siempre y
viven a nivel cuenta, no en el repo) ni a la documentación de método. Las indexa y le
dice al asistente qué abrir para cada tipo de tarea.

## Qué es cardoc-ml en una frase

Una **API en Zoho Catalyst** (Advanced I/O) que actúa de **gateway** delante de Zoho
para las automotoras: crea Contacto+Oportunidad en **CRM**, lista Informes de Revisión
de **Creator** y entrega su **PDF** (Creator/WorkDrive). El nombre dice "ml" pero **no es
machine learning**: **ML = la plataforma MLCenter / "Mi Auto"·"TuAuto"** (`mlcenter.com.uy`,
producto **AutoCheck** = inspecciones de vehículos), con quien la integración es
**bidireccional** (ML carga solicitudes → Oportunidades; cardoc le notifica los cambios de
estado). Detalle: [`../ARQUITECTURA.md`](../ARQUITECTURA.md) · integración:
[`playbooks/integracion-mlcenter.md`](playbooks/integracion-mlcenter.md).

> **Estado (2026-06-25): E-01 completo y deployable.** Verde verificado: `tsc -b`,
> 7 tests, `eslint`, smoke e2e 16/16, bundle esbuild. La lógica de E-02/E-03 (use-cases
> + puertos) está construida; los **adapters reales** (`ZohoCrmClient`,
> `ZohoCreatorReportsSource`) y el **DataStore** son stubs. Sprint 22/06→03/07/2026,
> owner Nestor Toñanez, 1 dev.

## El modelo mental

Arquitectura **hexagonal (ports & adapters)**. Saber qué capa toca una tarea te dice
qué abrir. La regla es la dirección de las dependencias: el dominio no conoce ni Express,
ni Catalyst, ni Zoho. La verifica el lint (`eslint.config.mjs`).

| Capa | Qué contiene | Dónde |
|---|---|---|
| **Dominio** | Tipos, schemas Zod, idempotencia, tokens. Node puro, sin SDK. | `packages/domain/` |
| **Puertos + adapters** | Interfaces `CrmClient` / `ReportsSource` + adapters (Mock + Zoho). **Único** lugar con HTTP externo. | `packages/providers/` |
| **Persistencia** | Tipos de fila + puertos de repositorio + impl DataStore + fakes in-memory. | `packages/persistence/` |
| **Aplicación** | Use-cases que orquestan dominio + puertos. Sin transporte. | `packages/application/` |
| **Función (transporte)** | Express + composición (`container.ts`) + middlewares + rutas. Único punto con el SDK de Catalyst. | `apps/catalyst/functions/api/` |

Todo lo demás es config de plataforma (`apps/catalyst/catalyst.json`, `catalyst-config.json`,
`.catalystrc.example`), tooling (`scripts/`, `.github/`) o documentación (`/*.md`, `docs/`).

## Vocabulario que tenés que conocer

- **consumidor / automotora / Cuenta / `accountId`**: cada automotora es un consumidor
  con un token, mapeado a una **Cuenta de Zoho CRM** (módulo Accounts). El `accountId`
  se resuelve **siempre del token**, nunca del payload/query. Es el ancla de la tenancy.
- **scope**: `opportunities:create` / `reports:read` / `reports:pdf`. Uno por endpoint.
- **clave de idempotencia vs `payloadFingerprint`**: la clave es el header
  `X-Idempotency-Key` del consumidor (UNIQUE por Cuenta); el `payloadFingerprint` (hash
  del payload) detecta "misma clave, payload distinto" → `409`. Ver
  [`../ARQUITECTURA.md`](../ARQUITECTURA.md) §idempotencia.
- **puerto vs adapter**: el puerto es la interface (en `providers`/`persistence`); el
  adapter es la implementación (Mock para dev, Zoho/DataStore para prod).
- **upstream**: Zoho CRM / Creator / WorkDrive. Sus fallas → `502 UPSTREAM_ERROR` con
  etiqueta **opaca** (`crm`/`creator`/`workdrive`), nunca la URL interna.
- **sobre de error único**: `{ error: { code, message, correlationId, details? } }`.
  El consumidor programa contra `code` (enum estable), no contra el HTTP.

## Árbol de decisión — según lo que pide el usuario

### "Agregar o cambiar un endpoint"

Abrí en orden:

1. [`../CONTRATOS.md`](../CONTRATOS.md) — el contrato canónico (headers, sobre de error,
   ejemplos). Actualizalo si cambia el contrato.
2. `apps/catalyst/functions/api/src/app.ts` — el wiring del pipeline. `requireScope` y
   `cap` se montan **por ruta** (no por prefijo): cada endpoint tiene su scope y su
   etiqueta de cap.
3. `apps/catalyst/functions/api/src/routes/*.ts` — los handlers (validan forma + headers,
   traducen el outcome del use-case a HTTP). Lógica de negocio NO va acá.
4. El use-case en `packages/application/src/` y, si hace falta, el puerto en `providers`/`persistence`.
5. Schema Zod del request en `packages/domain/src/schemas.ts` (usá `.strict()` para que
   un parámetro fuera de la allowlist sea `422`).

### "Tocar la notificación de estado a ML (outbound)"

ML (MLCenter/AutoCheck) espera que cardoc le avise los cambios de estado. Disparo: CRM
workflow (on `Deal.Stage` change) → `POST /v1/internal/deal-estado` (shared-secret) →
`MlCenterClient`. Abrí en orden:

1. [`playbooks/integracion-mlcenter.md`](playbooks/integracion-mlcenter.md) — contrato del
   endpoint AutoCheck, flujo y mapeo. [ADR-0013](decisions/README.md#adr-0013).
2. `packages/providers/src/mlcenter-client.ts` — adapter (login JWT cacheado + `updateEstado`).
3. `packages/application/src/notify-estado-change.ts` — `STAGE_TO_ESTADO` (placeholder, ver
   [OQ-N6](OPEN-QUESTIONS.md)) + regla `LinkResultado` para FINALIZADO.
4. `apps/catalyst/functions/api/src/routes/internal.ts` + `requireInternalSecret` en
   `.../middleware/auth.ts`.

Bloqueado para activar: mapeo Stage→Estado (OQ-N6), origen del LinkResultado (OQ-N7),
credenciales (OQ-P9). El `NroSolicitud` de ML = External ID de la Oportunidad.

Regla: el handler traduce HTTP ↔ dominio; la lógica vive en el use-case; el efecto
externo, detrás de un puerto.

### "Cablear un adapter real (CRM / Creator-WorkDrive)"

Hoy `ZohoCrmClient` y `ZohoCreatorReportsSource` lanzan `NotImplementedError`. Para
implementarlos:

1. [`playbooks/secretos-y-connections.md`](playbooks/secretos-y-connections.md) — cómo se
   resuelve el `accessToken` de la Catalyst Connection (CRM) y dónde viven los secretos.
2. `packages/providers/src/crm-client.ts` / `reports-source.ts` — implementá los métodos
   del puerto. **El `fetch`/HTTP externo solo puede vivir acá** (lo exige el lint).
3. `apps/catalyst/functions/api/src/container.ts` — activá el adapter real con el flag
   (`CARDOC_CRM_MODE=zoho` / `CARDOC_REPORTS_MODE=creator`).
4. **Bloqueado por open questions** (ver abajo): API names de Contacts/Deals/Accounts,
   picklist `Agendamiento Ready`, y el flujo de generación del PDF. Confirmá con Nestor
   antes de codear sobre supuestos.

### "Tocar auth, scopes, tenancy o cap"

Abrí en orden:

1. `apps/catalyst/functions/api/src/middleware/auth.ts` — `authMiddleware` (resuelve
   `consumerId`+`accountId`+`scopes` del token), `requireScope`, `correlationMiddleware`.
2. `apps/catalyst/functions/api/src/middleware/cap.ts` — cap hora/día/semana → `429`.
3. [`../ATRIBUTOS-DE-CALIDAD.md`](../ATRIBUTOS-DE-CALIDAD.md) — targets de seguridad y cómo se verifican.

**Reglas duras de tenancy** (innegociables):
- El `accountId` sale del token, **jamás** del payload/query (un `accountId` en la query
  se ignora).
- Todo método de repositorio de runtime recibe `accountId` como **primer argumento**.
- Acceso cruzado (token de A pide recurso de B) → **`404 NOT_FOUND`** (no revelar
  existencia). `403` es **solo** para falta de scope.
- El cap hoy es **in-memory por contenedor** (no distribuido). El cap global vía Catalyst
  Cache es un gate de plataforma pendiente — ver open questions.

### "Tocar idempotencia (POST opportunity-contact)"

1. `packages/application/src/create-opportunity-contact.ts` — el flujo: sembrar row
   `pending` con la clave (UNIQUE) **antes** de tocar CRM; solo el creador ejecuta el
   efecto externo.
2. `packages/domain/src/idempotency.ts` — `payloadFingerprint`.
3. `packages/persistence/src/{entities,repositories}.ts` — `OpportunityRecord` +
   `OpportunitiesRepository.insertIfAbsent`.

Outcomes: `201 created` · `200 duplicate` (misma clave, mismo payload) · `409
IDEMPOTENCY_CONFLICT` (misma clave, payload distinto) · `202 in_progress`. La unicidad
física es `UNIQUE(account_id, idempotency_key)` — **se crea a mano en la consola**, ver
[`playbooks/datastore-esquema.md`](playbooks/datastore-esquema.md).

### "El flujo del PDF (GET /informes/:id/pdf)"

Lógica perezosa con caché (vive en el adapter `ReportsSource.openPdf`): leer
`Analisis.pdf_url` en Creator → si lleno (link WorkDrive) stream; si vacío → **generar el
PDF en Catalyst** → write-back a `Analisis.pdf_url` → stream. Hoy el handler ya pipea un
`Readable` sin exponer URL/ruta interna (`apps/catalyst/functions/api/src/routes/informes.ts`).
**La generación está sin definir** (open question). Ver [`../ARQUITECTURA.md`](../ARQUITECTURA.md) §PDF.

### "Cambiar el esquema del DataStore"

1. [`playbooks/datastore-esquema.md`](playbooks/datastore-esquema.md) — tablas, columnas
   snake_case, índices/UNIQUE a crear en consola.
2. `packages/persistence/src/entities.ts` (tipos de fila) y `catalyst.ts` (mapeo
   snake_case ↔ camelCase + ZCQL). `memory.ts` para los fakes.

Cuidado: el `UNIQUE(account_id, idempotency_key)` no está declarado en el repo — se crea
en la consola. Si falta, la idempotencia falla **en silencio**.

### "Deploy / rollback"

[`playbooks/deploy-y-rollback.md`](playbooks/deploy-y-rollback.md). Resumen:
`pnpm install` (con `--use-system-ca`) → `pnpm -r run typecheck/test` → `pnpm run lint`
→ `pnpm --filter @cardoc/fn-api run build` → `catalyst init` (1ª vez) → `catalyst deploy`.
Secretos se cargan en la consola, nunca en el repo.

### "No compila / build / bundling"

[`playbooks/monorepo-build-y-bundling.md`](playbooks/monorepo-build-y-bundling.md):
pnpm workspaces, `tsc -b` (project references), esbuild bundle (externals
`express` + `zcatalyst-sdk-node`). Gotcha de install en red corporativa:
`NODE_OPTIONS=--use-system-ca pnpm install`.

### "Cómo funciona X de Catalyst"

[`playbooks/catalyst-artefactos.md`](playbooks/catalyst-artefactos.md): Advanced I/O
Functions, DataStore, Cache, Connections, Environment Variables, y los archivos de config.

### "Escribir un runbook / atender un incidente"

Copiá [`runbooks/_template.md`](runbooks/_template.md) a `runbooks/<slug>.md`. Un runbook
se escribe **antes** de necesitarlo y se prueba con un dry-run. Índice de incidentes y
escalamiento en [`../OPERACIONES.md`](../OPERACIONES.md) §5.

### "Tomar o registrar una decisión de arquitectura"

El log canónico es [`decisions/README.md`](decisions/README.md) (ADRs livianos, inline).
Regla: una ADR **antes** de implementar si la decisión es difícil de revertir, introduce un
invariante, o cambia una política transversal (tenancy, idempotencia, sobre de error,
fronteras hexagonales). Una ADR aceptada no se cambia sin una nueva que la supersede.

### "Documentar algo que descubrí"

| Tipo de conocimiento | Va en |
|---|---|
| Decisión de arquitectura (ADR) | [`decisions/README.md`](decisions/README.md) — log canónico; resumen en [`../ARQUITECTURA.md`](../ARQUITECTURA.md) §10 |
| Pregunta sin resolver | [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) — registro único (negocio + plataforma) |
| Contrato de la API | [`../CONTRATOS.md`](../CONTRATOS.md) |
| Target de calidad / cómo se verifica | [`../ATRIBUTOS-DE-CALIDAD.md`](../ATRIBUTOS-DE-CALIDAD.md) |
| Proceso operativo | [`../OPERACIONES.md`](../OPERACIONES.md) |
| Cómo funciona la plataforma | [`playbooks/`](README.md) |
| Procedimiento ante incidente | [`runbooks/_template.md`](runbooks/_template.md) |
| Estado del plan / épicas | [`../PLAN-DE-DESARROLLO.md`](../PLAN-DE-DESARROLLO.md) |

## Reglas duras (aplican sin importar la tarea)

- **Ecosistema Zoho-first.** cardoc integra Zoho (CRM/Creator/WorkDrive) sobre Catalyst.
  No proponer herramientas externas sin agotar el ecosistema Zoho/ManageEngine.
- **Cero secretos en el repo.** Viven en Catalyst Environment Variables / Connections.
  El `.gitignore` cubre `.env`/`.catalystrc`; hay secret-scanning como gate de CI.
- **Tenancy server-side.** `accountId` del token, cross-tenant = `404`, `accountId` como
  primer argumento de todo repo. (ver árbol de decisión arriba).
- **Fronteras hexagonales.** Dominio sin SDK/Express; HTTP externo solo en `providers`;
  SDK de Catalyst solo en la función. Lo verifica `eslint`.
- **Idempotencia y estado fijo.** El POST no duplica (UNIQUE); el estado `Agendamiento
  Ready` se fija **server-side**, nunca del body.
- **Smoke antes de handoff.** Typecheck + build NO es "listo". Corré el smoke e2e (o
  `curl` los endpoints) y leé la respuesta. cardoc corre en local sin Catalyst (ver abajo).
- **No commit sin OK explícito del owner.** Tampoco `push --force`, `reset --hard` ni
  borrados destructivos sin confirmar.
- **No inventar specifics de plataforma.** Lo que no esté confirmado en el repo se marca
  «⚠️ verificar (docs/consola)» — no se afirma como hecho. Aplica a Cache/Connections/CLI/quotas.

## Mapa rápido del proyecto

```
cardoc-ml/
├── packages/
│   ├── domain/        @cardoc/domain      tipos · schemas Zod · idempotency · tokens (Node puro)
│   ├── providers/     @cardoc/providers   puertos CrmClient/ReportsSource + adapters (Mock + Zoho stub)
│   ├── persistence/   @cardoc/persistence entities · repos (puertos) · catalyst (DataStore) · memory (fakes)
│   └── application/   @cardoc/application use-cases: createOpportunityContact · listInformes · streamReportPdf
├── apps/catalyst/
│   ├── catalyst.json                      targets: ['api']
│   └── functions/api/  @cardoc/fn-api      Advanced I/O: index.ts(export=app) · app.ts · container.ts · middleware/* · routes/*
├── scripts/bundle-function.mjs            esbuild → index.js (externals express + zcatalyst-sdk-node)
├── ARQUITECTURA.md · CONTRATOS.md · ATRIBUTOS-DE-CALIDAD.md · OPERACIONES.md · PLAN-DE-DESARROLLO.md
└── docs/
    ├── ASSISTANT.md  (este archivo) · README.md (índice) · OPEN-QUESTIONS.md (registro único)
    ├── decisions/    README.md (log de ADRs)
    ├── playbooks/    catalyst-artefactos · monorepo-build-y-bundling · deploy-y-rollback · secretos-y-connections · datastore-esquema · integracion-mlcenter
    └── runbooks/     _template.md
```

## Dónde vive el runtime

- **Local (sin Catalyst):** por defecto `CARDOC_PERSISTENCE=memory` + `CARDOC_CRM_MODE=mock`
  + `CARDOC_REPORTS_MODE=mock`. Token de dev sembrado: `Bearer test-token` (todos los
  scopes, Cuenta `acc_dev`). En `datastore` mode **no** se siembra ningún token: sin
  sembrar uno, todo responde `401`.
- **Smoke:** levantar el app Express compilado (`require` de `apps/catalyst/functions/api/dist/index.js`)
  y `fetch` a los endpoints. El `index.js` es CommonJS (`export = app`).
- **Build/deploy:** `pnpm --filter @cardoc/fn-api run build` (tsc -b + esbuild) → `catalyst deploy`.
- **Install en red corporativa:** `NODE_OPTIONS=--use-system-ca pnpm install` (CA propia / TLS interceptado).
- Toolchain confirmado: node 24.13, pnpm 10.29.2.

## Open questions que bloquean trabajo

Registro único: **[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)**. Antes de cablear E-02/E-03,
confirmá las de **negocio** (OQ-N\*: generación del PDF, relación `Informes`↔`Analisis`, API
names CRM, picklist `Agendamiento Ready`) con Nestor, y las de **plataforma** (OQ-P\*:
streaming/Cache/Connection/residencia/SLA/logs/backup) contra la consola.

## Cuando tengas dudas

Si el prompt no encaja en ninguna rama:

1. Leé la sección de vocabulario para cualquier término desconocido.
2. Abrí [`../ARQUITECTURA.md`](../ARQUITECTURA.md) (visión general) y
   [`README.md`](README.md) (índice de docs).
3. Antes de inventar contrato, decisión o procedimiento, **preguntá al owner** — sobre
   todo si toca una open question o un specific de plataforma sin confirmar.
