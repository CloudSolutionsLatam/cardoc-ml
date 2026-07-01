---
title: cardoc-ml — Manual Operativo
status: borrador-para-validacion
last_reviewed: 2026-06-25
---

# Manual Operativo — API cardoc sobre Zoho Catalyst

Modelo de operación del servicio: cómo se opera, se despliega, se incorpora una
automotora nueva, se monitorea y se responde ante incidentes. Documento vivo: el
sistema está **deployado y validado end-to-end en Catalyst** (E-01 completo; E-02
completo — `ZohoCrmClient` implementado y validado con alta real en CRM+DataStore).
Solo `ZohoCreatorReportsSource` (E-03) sigue como stub `NotImplemented`. Todo
procedimiento marcado **⚙️** se completa con valores concretos durante E-03 y se
valida con dry-run antes de producción — un runbook no probado no es un runbook.

Toda afirmación de plataforma marcada **⚠️ verificar** debe confirmarse contra la
consola/docs oficiales de Catalyst antes de operar en producción (ver [§8](#8-open-questions-de-plataforma-gates-pre-producción)).

> Contexto: arquitectura en [ARQUITECTURA.md](ARQUITECTURA.md) ·
> contratos de API en [CONTRATOS.md](CONTRATOS.md) ·
> targets de calidad en [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md) ·
> cronograma en [PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md) ·
> índice de docs en [docs/README.md](docs/README.md).

---

## 1. Entornos

| Entorno | Proyecto Catalyst | Persistencia | CRM / Reports | Uso |
|---------|-------------------|--------------|---------------|-----|
| `local` | — (sin Catalyst) | `memory` | `mock` / `mock` | Desarrollo en máquina. Token sembrado `X-Api-Key: test-token` (todos los scopes, Cuenta `acc_dev`). |
| `dev` | cardoc-dev ⚙️ | `datastore` | `mock`/`mock` o adapters reales en sandbox | Integración + smoke e2e en plataforma real. |
| `prod` | cardoc-prod ⚙️ | `datastore` | `zoho` / `creator` | Automotoras reales — **solo** se llega por pipeline. |

El entorno lo gobiernan las **variables de entorno** (no flags de código): `CARDOC_PERSISTENCE`
(`datastore` | otro→in-memory), `CARDOC_CRM_MODE` (`zoho` | otro→`MockCrmClient`),
`CARDOC_REPORTS_MODE` (`creator` | otro→`MockReportsSource`). Plantilla completa en
[.env.example](.env.example).

**Reglas duras:**

- **Nadie edita funciones en la consola de Catalyst.** Todo cambio entra por **git + CI**.
  Código editado en plataforma = código perdido en el próximo `catalyst deploy`.
- **Secretos jamás en el repo.** Viven en Catalyst Console → Environment Variables (incluidas las
  creds del self-client OAuth a CRM). El `.gitignore` bloquea `.env*` (salvo `.env.example`) y `.catalystrc`;
  el binding real del proyecto vive en `.catalystrc` (gitignored), nunca en `.catalystrc.example`.
- **PII de automotoras reales jamás en `local`/`dev`.** Los tests usan datos sintéticos y
  Mock CRM/Reports.
- El `accountId` (Cuenta CRM = automotora) **siempre** se resuelve del token, nunca del
  payload/query — esto es invariante de runtime, no de entorno (ver [§3](#3-onboarding-de-una-automotora-nueva-checklist)).

## 2. Deploy y rollback

El procedimiento operativo completo (comandos exactos, tags, smoke post-deploy) vive en
el playbook **[docs/playbooks/deploy-y-rollback.md](docs/playbooks/deploy-y-rollback.md)**.
Aquí, el modelo y los gates.

```
PR → CI (typecheck + tests + lint + gitleaks) → merge a main → deploy a dev
   → smoke e2e en dev → aprobación → deploy a prod → smoke post-deploy
```

**Gates de CI** (`.github/workflows/ci.yml`, runner node24):

| Gate | Comando | Qué protege |
|------|---------|-------------|
| Typecheck | `pnpm -r run typecheck` | Tipos en los 4 packages + la función. |
| Test | `pnpm -r run test` | 25 tests (vitest) + smoke local 21/21: idempotencia + use-case del POST. |
| Lint | `pnpm run lint` (`eslint .`) | Fronteras hexagonales (puertos/adapters). |
| Secret-scan | gitleaks (Docker, historia completa) | Que ningún secreto entre al repo. |

**Build de la función** (lo invoca el deploy, ver playbook):

```bash
# En la red corporativa (intercepción TLS / CA propia):
NODE_OPTIONS=--use-system-ca pnpm install --frozen-lockfile
pnpm --filter @cardoc/fn-api run build   # tsc -b (project references) + esbuild
```

El build corre `tsc -b` y luego `scripts/bundle-function.mjs` (esbuild, `format: cjs`,
`target: node24`) → genera un único `apps/catalyst/functions/api/index.js` bundleado.
`express`, `zod` y los workspace `@cardoc/*` se **inlinan** en el bundle (Catalyst NO
instala las deps del `package.json`). La **única excepción** es `zcatalyst-sdk-node`: se
**externaliza** (hace `require()` dinámicos de submódulos —p.ej. `./zcql/zcql`— que esbuild
no puede resolver estáticamente; inlinarlo rompe en runtime con `Cannot find module './zcql/zcql'`).
La lista de externals vive en `scripts/function-externals.mjs` (fuente **única**, la consumen
`bundle-function.mjs` y `deploy-prep-sdk.mjs`). Como Catalyst tampoco provee el SDK en el
runtime, se **shippea como `node_modules` real** en el function dir vía
`scripts/deploy-prep-sdk.mjs` (instala el external + sus transitivas como archivos reales;
los symlinks de pnpm se rompen al zipear en `catalyst deploy`). Ese `index.js` está
**gitignored**: se regenera en cada deploy, nunca se versiona. El root `package.json`
fija `pnpm.onlyBuiltDependencies: ['esbuild']`.

**Deploy** (secuencia verificada):

```bash
catalyst init     # 1ª vez por entorno: vincula proyecto/env (genera .catalystrc local)

# Paso 1 — build (tsc + esbuild bundle) + deploy:prep (materializa el SDK real):
pnpm --filter @cardoc/fn-api predeploy

# Paso 2 — deploy de la función api (stack node24, type advancedio):
cd apps/catalyst
NODE_OPTIONS=--use-system-ca catalyst deploy --only functions:api --ignore-scripts
```

- **GOTCHA:** tras cualquier `pnpm install`, pnpm restaura el symlink del SDK → RE-correr
  `predeploy` (o `deploy:prep`) antes de deployar, o el runtime falla con `Cannot find module`.

Configs versionadas: `apps/catalyst/catalyst.json` (`functions.source: 'functions'`,
`targets: ['api']`) y `apps/catalyst/functions/api/catalyst-config.json`
(`deployment: { name:'api', stack:'node24', type:'advancedio' }`, `execution.main: 'index.js'`).
Timezone del proyecto: `America/Montevideo`.

- **Comando exacto de rollback y de pin de versión por deploy ⚠️ verificar** (docs/consola
  Catalyst). El modelo objetivo: rollback = redeploy del tag de git anterior (1 paso).
- **Todo deploy a prod referencia un tag de git** — trazabilidad release ↔ código.
- **Smoke post-deploy obligatorio**: `GET /v1/health` (abierto) + 1 `POST /v1/opportunity-contact`
  por el pipeline completo contra datos de prueba. Si falla → rollback inmediato y se
  diagnostica desde la versión estable.

## 3. Onboarding de una automotora nueva (checklist)

Modelo de tenancy (invariante): **1 automotora = 1 Cuenta CRM** (`crm_account_id`, módulo
Accounts) **= 1 consumidor = 1 token**. El `accountId` se inyecta en cada query desde el
token resuelto; acceso cruzado → **404** (no 403). Target: alta sin tocar código.

| # | Paso | Dónde / cómo | Verificación |
|---|------|--------------|--------------|
| 1 | Alta de la Cuenta CRM de la automotora | Zoho CRM, módulo Accounts → obtener `crm_account_id` | La Cuenta existe y es la correcta. |
| 2 | Alta del `consumer` | `consumers(consumer_id, crm_account_id, name, status='active')` en el DataStore | Fila visible; `crm_account_id` apunta al paso 1. |
| 3 | Generar token + cargar su hash | `generateToken()` (base64url, ≥256 bits) → entregar **una sola vez** al integrador; persistir solo `hashToken()` (sha256) | El token plano **nunca** se guarda ni se loguea. |
| 4 | Definir scopes del token | `api_tokens(token_hash, consumer_id, account_id, scopes[JSON], expires_at)` | Scopes según lo que la automotora usará (ver tabla scopes abajo). |
| 5 | Cargar credenciales CRM/Creator | Self-client OAuth: `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN` (+ `ZOHO_CRM_API_DOMAIN`, `ZOHO_CRM_CONNECTOR_NAME`) en Environment Variables; el SDK renueva el token en runtime | El secreto vive en plataforma, no en repo. Procedimiento detallado: [secretos-y-connections.md](docs/playbooks/secretos-y-connections.md). |
| 6 | Cap por consumidor (opcional) | `consumer_caps(consumer_id, endpoint, limit_hour, limit_day, limit_week)`; sin fila → defaults de env (`CARDOC_CAP_DEFAULT_*`: 1000/h, 10000/d, 50000/sem) | Cap razonable para el volumen esperado. |
| 7 | Pruebas funcionales con el token real | `POST /v1/opportunity-contact` (payload AutoCheck), `GET /v1/informes`, `GET /v1/informes/:id/pdf` | 2xx donde corresponde; cross-tenant probado → 404; sin scope → 403; idempotencia (repetir mismo `NroSolicitud`) → mismo resultado. |
| 8 | Verificar trazabilidad | Reconstruir un request de prueba por `correlationId` en `audit_log` | El registro on-finish existe (status + latencia + correlationId). |
| 9 | Registrar en monitoreo | Umbral de alertas + contacto de escalamiento de la automotora | La automotora aparece en el tablero (ver [§4](#4-monitoreo)). |

**Scopes disponibles** (uno por endpoint):

| Scope | Habilita |
|-------|----------|
| `opportunities:create` | `POST /v1/opportunity-contact` |
| `reports:read` | `GET /v1/informes` |
| `reports:pdf` | `GET /v1/informes/:id/pdf` |

> El esquema exacto de tablas y columnas del DataStore está en
> [docs/playbooks/datastore-esquema.md](docs/playbooks/datastore-esquema.md). El DDL
> (tablas/columnas/índices) es **CONSOLE ONLY** — el SDK solo hace CRUD de filas sobre
> tablas ya existentes. La idempotencia Capa 1 se apoya en un `UNIQUE(idempotency_key)`
> single-column (Catalyst no ofrece UNIQUE compuesto por UI); el filtrado por
> `(account_id, idempotency_key)` en el código es lectura defensiva de tenancy, no el
> constraint del índice. La columna de auditoría se llama `_timestamp` (`timestamp` es
> nombre reservado en Catalyst). **Seed obligatorio:** las tablas se crean vacías; el alta
> necesita al menos la fila de `api_tokens` (sin ella el auth devuelve 401), sembrada vía
> "Add Row" en la consola —no por CSV import, que rompe el JSON de `scopes`.

## 4. Monitoreo

Qué se mira y cada cuánto. La fuente primaria de verdad operativa es `audit_log`
(append-only, 1 registro por request en los 3 endpoints: `correlation_id`, `consumer_id`,
`account_id`, `endpoint`, `outcome`, `http_status`, `latency_ms`, `error_code`).

| Cadencia | Qué se mira | Fuente |
|----------|-------------|--------|
| Continuo (alertas) | `GET /v1/health` caído; tasa de `5xx` / `UPSTREAM_ERROR` (502) elevada; pico de `429 CAP_EXCEEDED`; ráfaga de `401`/`403` (token o scope mal configurado) | Health check + alertas ⚙️ sobre `audit_log` |
| Diario | Requests del día por automotora (`account_id`), conteo por `outcome` y `error_code`, latencia p95, oportunidades en estado `error` en `crm_opportunities` | `audit_log` + DataStore |
| Semanal | Tendencia de volumen vs caps, consumo de plataforma vs presupuesto, `last_used_at` de tokens (detectar tokens muertos o por expirar) | DataStore + consola Catalyst |
| Mensual | Disponibilidad del mes vs objetivo ⚙️, revisión de `crm_opportunities` atascadas en `pending`, revisión de jobs/errores recurrentes | Reporte ⚙️ |
| Trimestral | Revisión de accesos (tokens vigentes, scopes, mínimo privilegio) + vigencia de targets de calidad | Checklist con responsable |

- **El monitoreo no loguea PII ni bytes de PDF** — solo IDs, códigos y estado (igual que
  la auditoría y los logs de Catalyst).
- **Herramienta de alerting/tablero ⚙️**: dentro del ecosistema Zoho (Catalyst observabilidad
  nativa / ManageEngine), a definir en E-02. **Quotas, retención de logs y cold-start del
  plan ⚠️ verificar** (consola Catalyst) — alimentan los umbrales de este apartado.

## 5. Runbooks de incidentes

Cada incidente conocido tiene (o tendrá) un runbook propio en `docs/runbooks/`. La
plantilla es **[docs/runbooks/_template.md](docs/runbooks/_template.md)**: se copia a
`docs/runbooks/<slug>.md` y se completa **antes** de necesitarlo; un runbook sin dry-run
es una expresión de deseo. Estructura de cada runbook: *Cuándo se dispara · Impacto ·
Diagnóstico · Resolución · Verificación · Prevención/follow-up*.

Punto de partida de todo diagnóstico: tomar el `correlationId` del request afectado
(va en el header `X-Correlation-Id` de la respuesta) y reconstruir la traza en `audit_log`
(`searchByCorrelationId`).

**Índice de runbooks** (pendientes de escribir + dry-run pre-producción):

| Slug | Síntoma / disparador | Códigos relacionados |
|------|----------------------|----------------------|
| `outage-crm` | Zoho CRM no responde / rechaza altas (Contacts/Deals/Accounts) | `UPSTREAM_ERROR` 502; oportunidades en `error` |
| `outage-creator-workdrive` | Zoho Creator / WorkDrive caído → no se listan informes ni se streamea PDF | `UPSTREAM_ERROR` 502; `PDF_NOT_AVAILABLE` 404 |
| `pdf-no-disponible` | `Analisis.pdf_url` vacío y la generación de PDF falla | `PDF_NOT_AVAILABLE` 404 (ver open question §8) |
| `cap-mal-configurado` | Cap demasiado bajo → automotora legítima bloqueada | `CAP_EXCEEDED` 429 |
| `token-comprometido` | Sospecha de fuga de un token de automotora | rotación de emergencia (ver [§6](#6-calendario-de-rotaciones)) |
| `idempotencia-conflicto` | Mismo `NroSolicitud` con payload distinto | `IDEMPOTENCY_CONFLICT` 409 |
| `restore-datastore` | Pérdida/corrupción de datos del DataStore | **mecanismo de backup/export ⚠️ verificar** |

**Sobre de error único** (los 3 endpoints) — todo runbook lo usa para clasificar:

```jsonc
{ "error": { "code": "...", "message": "...", "correlationId": "uuid", "details": {} } }
```

Catálogo: `VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `FORBIDDEN_SCOPE` 403 ·
`NOT_FOUND` 404 · `PDF_NOT_AVAILABLE` 404 · `IDEMPOTENCY_CONFLICT` 409 · `UNPROCESSABLE` 422 ·
`CAP_EXCEEDED` 429 · `UPSTREAM_ERROR` 502 · `INTERNAL_ERROR` 500. Referencia completa en
[CONTRATOS.md](CONTRATOS.md).

> Nota anti-cross-tenant: el acceso a recursos de otra automotora devuelve **404**, no 403.
> Un 403 (`FORBIDDEN_SCOPE`) siempre significa *scope insuficiente del propio token*, nunca
> tenancy. Si un runbook ve 404 inesperados, primero verificar que el `accountId` del token
> sea el correcto, no que el recurso "no exista".

## 6. Calendario de rotaciones

| Qué | Cadencia | Cómo | Responsable ⚙️ |
|-----|----------|------|----------------|
| Token de API de automotora | ≤ 90 días o ante sospecha | **Rotación sin downtime**: `create()` un token nuevo (entregar al integrador) → confirmar tráfico con el nuevo → `revoke()` el viejo (setea `revoked_at`). El middleware de auth rechaza tokens con `revoked_at` o `expires_at` vencido. | Operador |
| Credenciales Zoho (self-client OAuth) | Mínimo anual o ante sospecha | Rotar el `ZOHO_REFRESH_TOKEN` (y client id/secret si aplica) en Environment Variables → redeploy. El access token lo renueva el SDK en runtime, no se hardcodea. Ver [secretos-y-connections.md](docs/playbooks/secretos-y-connections.md). | Admin |
| Environment Variables sensibles | Ante sospecha / cambio de credencial upstream | Actualizar en Catalyst Console → redeploy. Nunca en repo. | Admin |
| Revisión de accesos (tokens vigentes, scopes) | Trimestral | `listByConsumer()` por consumidor; revocar tokens muertos (`last_used_at` viejo) | Admin |
| Dry-run de restore del DataStore | Semestral | Según el mecanismo de backup/export validado | Equipo |

**Rotación de emergencia (token comprometido):** `revoke()` inmediato del token
sospechoso → emitir uno nuevo → entregar al integrador → auditar el uso del comprometido
buscando por `consumer_id`/`account_id` en `audit_log` → registrar el incidente. El token
plano nunca estuvo en disco (solo el hash), así que la exposición se limita al portador
del token, no al sistema.

## 7. Soporte y escalamiento

| Nivel | Atiende | Ejemplos |
|-------|---------|----------|
| **N1 — Operador** | Estado de requests, onboarding de automotoras, ajuste de caps, rotación programada de tokens | "¿Por qué mi POST da 429?" → cap; "no veo mis informes" → scope/token |
| **N2 — Desarrollo** | Bugs de validación/idempotencia, errores de adapter, incidentes de tenancy, integraciones | `IDEMPOTENCY_CONFLICT` recurrente; `UPSTREAM_ERROR` sistemático; PDF que no se genera |
| **N3 — Externos** | Plataforma y upstreams fuera de nuestro control | **Zoho Catalyst** (función/DataStore/Connection); **Zoho CRM** (Contacts/Deals/Accounts); **Zoho Creator / WorkDrive** (informes/PDF) |

Todo incidente **N2+** queda registrado con `correlationId`, causa raíz y acción
correctiva (mínimo: qué pasó, por qué, qué cambia). Owner del servicio durante el sprint
(22/06 → 03/07/2026): **Nestor Toñanez** (1 dev). Diagnóstico inicial siempre por
`correlationId` → `audit_log`.

## 8. Open questions de plataforma (gates pre-producción)

Estos puntos **no están resueltos** y bloquean el paso a producción. No se operan por
suposición; se de-riskean en E-03 con validación en consola/docs oficiales.

**Negocio (E-03) — no inventar, definir con el cliente:**

- **Generación de PDF**: cuando `Analisis.pdf_url` está vacío hay que generar el PDF en
  Catalyst y hacer write-back a `Analisis.pdf_url` → luego stream. Falta definir el
  generador (plantilla nativa de Creator vs HTML→PDF en Catalyst vs servicio existente) y
  de qué datos sale. Relación entre los forms `Informes` y `Analisis` en Creator.
- **CRM**: ✅ **resuelto y validado end-to-end** (E-02) — alta real en Catalyst
  (DataStore+Zoho) con `ZohoCrmClient` implementado. Stage de la Deal = `Nueva Solicitud`;
  campos custom `Cedula` y `EXTERNAL_ID` creados; idempotencia Capa 1 (`X-Idempotency-Key`)
  y Capa 2 (dedup por `EXTERNAL_ID`) verificadas.

**Plataforma Catalyst — ⚠️ verificar (docs/consola oficiales):**

- **Streaming/chunked real** en Advanced I/O para `GET /v1/informes/:id/pdf` y **tope de
  payload** de la función.
- **Atomicidad del increment** para el cap distribuido. Hoy los contadores del middleware
  `cap` son **in-memory por contenedor caliente** (`buckets` en `cap.ts`); el modelo
  objetivo usa Catalyst Cache con TTL nativo e increment atómico — pendiente de validar.
- **Setup de la Connection OAuth** a Zoho CRM (`zoho_crm_conn`): scopes, refresh, rotación.
- **Región / residencia de datos (PII)** considerando las tres jurisdicciones de Unicorp
  Systems: Uruguay (matriz), Argentina y Wyoming (USA).
- **SLA / quotas / cold-start** del plan; **retención de logs**; **mecanismo de
  backup/export del DataStore** (insumo del runbook `restore-datastore`).

---

_Arquitectura: [ARQUITECTURA.md](ARQUITECTURA.md) ·
Contratos: [CONTRATOS.md](CONTRATOS.md) ·
Calidad: [ATRIBUTOS-DE-CALIDAD.md](ATRIBUTOS-DE-CALIDAD.md) ·
Plan: [PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md) ·
Playbooks: [docs/playbooks/](docs/playbooks/) · Runbooks: [docs/runbooks/](docs/runbooks/)_
