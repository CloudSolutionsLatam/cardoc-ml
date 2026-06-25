---
title: Playbook — Deploy y Rollback (cardoc-ml)
status: scaffolding
last_reviewed: 2026-06-25
---

# Deploy y Rollback

Procedimiento operativo para llevar `@cardoc/fn-api` (Catalyst Advanced I/O, stack `node24`) de un PR a producción, y para revertir cuando algo sale mal. Pensado para ejecutarse tal cual: cada comando es copiable y está anclado al repo real.

Pipeline de extremo a extremo:

```
PR → CI (typecheck + test + lint + secret-scan) → deploy dev → smoke → deploy prod → smoke
                                                         └──────────── rollback ───────────┘
```

**Un solo principio rige todo esto:** nada llega a producción sin pasar por dev y un smoke en verde. El que se saltea el smoke ya perdió la batalla antes de pelearla.

Contexto que conviene tener a mano antes de operar:

- Arquitectura y fronteras hexagonales: [`../../ARQUITECTURA.md`](../../ARQUITECTURA.md)
- Build y bundling del monorepo: [`./monorepo-build-y-bundling.md`](./monorepo-build-y-bundling.md)
- Artefactos y configs de Catalyst: [`./catalyst-artefactos.md`](./catalyst-artefactos.md)
- Secretos y Connections: [`./secretos-y-connections.md`](./secretos-y-connections.md)
- Esquema del DataStore: [`./datastore-esquema.md`](./datastore-esquema.md)
- Operaciones (monitoreo, auditoría, incidentes): [`../../OPERACIONES.md`](../../OPERACIONES.md)
- Contratos de los endpoints: [`../../CONTRATOS.md`](../../CONTRATOS.md)

---

## 0. Estado del proyecto al momento de este playbook

E-01 (scaffold) está completo y es **deployable**. La lógica de dominio y los puertos de E-02/E-03 están listos, pero los adapters reales (Zoho CRM / Creator / WorkDrive) son stubs `NotImplemented`. En consecuencia, **un deploy hoy con `CARDOC_CRM_MODE=zoho` / `CARDOC_REPORTS_MODE=creator` fallará en los paths que tocan esos adapters**. Para validar plataforma sin negocio real, se despliega con modos `mock`/`memory` (ver §6, matriz de variables).

Cronograma del sprint: 22/06 → 03/07/2026. Owner: Nestor Toñanez. Equipo: 1 dev.

---

## 1. Prerequisitos (una sola vez por máquina)

| Requisito | Valor confirmado | Cómo se verifica |
|-----------|------------------|------------------|
| Node | `24` (`.nvmrc` = `24`; CI usa `node-version: 24`; validado en `24.13`) | `node -v` |
| pnpm | `10.29.2` (campo `packageManager` en `package.json`) | `pnpm -v` |
| Catalyst CLI | requerido para `init`/`deploy` | `catalyst --version` — «⚠️ verificar (docs oficiales/consola)» el nombre exacto del flag de versión |
| Acceso a la consola Catalyst | proyecto + entorno dev y prod | login en la consola |

> **GOTCHA — red corporativa con CA propia (intercepción TLS).** En la red de Unicorp, el `pnpm install` local rompe en la verificación TLS. Hay que cargar la CA del sistema:
>
> ```bash
> NODE_OPTIONS=--use-system-ca pnpm install
> ```
>
> Esto **solo aplica al entorno local**. En CI (`.github/workflows/ci.yml`) el install corre `pnpm install --frozen-lockfile` sobre runner GitHub sin la intercepción, así que ahí no se usa el flag.

Login al CLI de Catalyst: «⚠️ verificar (docs oficiales/consola)» el comando exacto de autenticación del CLI (`catalyst login` u equivalente) y si abre navegador o usa token.

---

## 2. Gate de CI (lo que corre en cada PR)

Definido en [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). Dispara en `pull_request` y en push a `main` / `feat/**`. **Ningún PR mergea con CI en rojo.** Dos jobs:

### Job `build`

| Paso | Comando real | Qué valida |
|------|--------------|------------|
| Install | `pnpm install --frozen-lockfile` | lockfile consistente |
| Typecheck | `pnpm -r run typecheck` | `tsc -b` en cada workspace (project references) |
| Test | `pnpm -r run test` | vitest. Tests reales en disco: `packages/domain/test/idempotency.test.ts` y `packages/application/test/create-opportunity-contact.test.ts` |
| Lint | `pnpm run lint` → `eslint .` | fronteras hexagonales (config en `eslint.config.mjs`) |

### Job `secret-scan`

Corre `gitleaks` (binario directo vía Docker, con `fetch-depth: 0` para historia completa) como **gate**. Un secreto detectado bloquea el merge. Esto es la red de seguridad de la regla de oro del proyecto: **los secretos viven en Catalyst Console → Environment Variables, nunca en el repo** (ver [`./secretos-y-connections.md`](./secretos-y-connections.md)).

### Reproducir el gate localmente antes de abrir el PR

```bash
NODE_OPTIONS=--use-system-ca pnpm install   # local; en CI: --frozen-lockfile
pnpm -r run typecheck
pnpm -r run test
pnpm run lint
```

Estado verificado en verde: `tsc -b`, 7 tests (vitest), eslint, bundle esbuild. El secret-scan se valida en CI (requiere Docker + historia completa).

---

## 3. Build del bundle desplegable

Catalyst despliega un único `index.js` CommonJS por función. El bundling resuelve la fricción monorepo↔Catalyst: `express`, `zod` y los `@cardoc/*` (`workspace:*`) se **inlinan** en el bundle; el único external es `zcatalyst-sdk-node`, que **provee el runtime de Catalyst**. Catalyst **no** instala las deps del `package.json` (el smoke 2026-06-25 lo confirmó: externalizar `express` daba `Cannot find module 'express'`).

```bash
pnpm --filter @cardoc/fn-api run build
```

Ese script (en `apps/catalyst/functions/api/package.json`) ejecuta:

```
tsc -b && node ../../../../scripts/bundle-function.mjs api
```

Parámetros del bundle (en [`scripts/bundle-function.mjs`](../../scripts/bundle-function.mjs)), no negociables porque el runtime de Catalyst los exige:

| Parámetro | Valor | Razón |
|-----------|-------|-------|
| `entryPoints` | `src/index.ts` | `src/index.ts` hace `export = app` (CommonJS) |
| `format` | `cjs` | Catalyst Advanced I/O carga CommonJS |
| `platform` / `target` | `node` / `node24` | stack de la función |
| `external` | `['zcatalyst-sdk-node']` | lo provee el runtime de Catalyst; express y el resto se inlinean |
| `sourcemap` | `true` | genera `index.js.map` |

Salida: `apps/catalyst/functions/api/index.js` (~1.3 MB). **`index.js` e `index.js.map` están gitignored** (`.gitignore`: `apps/catalyst/functions/*/index.js`). Son artefacto de build, no se versionan — se regeneran en cada deploy.

> Nota: `package.json` raíz declara `pnpm.onlyBuiltDependencies:['esbuild']` para que esbuild pueda compilar su binario nativo en install. Si el install se hizo con esa allowlist ausente, esbuild no estará listo y el bundle fallará.

Detalle completo del bundling en [`./monorepo-build-y-bundling.md`](./monorepo-build-y-bundling.md).

---

## 4. Vinculación del proyecto Catalyst (primera vez)

```bash
catalyst init
```

`catalyst init` vincula la carpeta al proyecto/entorno de Catalyst y genera el `.catalystrc` (binding local con IDs de proyecto/env). Reglas de versionado:

- **`.catalystrc` está gitignored** (`.gitignore`: `.catalystrc`). Contiene IDs del binding local — no se versiona.
- Se versiona en cambio `.catalystrc.example` (presente en `apps/catalyst/.catalystrc.example`): plantilla del binding con placeholders y `timezone: America/Montevideo`.

El binding define a qué proyecto/entorno apunta cada `catalyst deploy`. Para dev y prod separados se usan entornos distintos del mismo proyecto. «⚠️ verificar (docs oficiales/consola)» el mecanismo exacto del CLI para seleccionar/cambiar de entorno (dev↔prod) entre deploys (flag, `catalyst use-env`, o re-`init`).

Estructura de configs que el deploy lee (ver [`./catalyst-artefactos.md`](./catalyst-artefactos.md)):

| Archivo | Contenido | Estado en disco |
|---------|-----------|-----------------|
| `apps/catalyst/catalyst.json` | `{ functions: { source: 'functions', targets: ['api'] } }` | ✔ presente y correcto |
| `apps/catalyst/functions/api/catalyst-config.json` | `{ deployment: { name:'api', stack:'node24', type:'advancedio' }, execution: { main:'index.js' } }` | ✔ presente y correcto |

Timezone del proyecto: `America/Montevideo`.

---

## 5. Deploy a dev

Orden estricto: **build → deploy**. Nunca `catalyst deploy` sin un `index.js` recién regenerado, o se publica un bundle viejo.

```bash
# 1. Asegurar binding apuntando al entorno dev (ver §4)
# 2. Regenerar el bundle desde cero
pnpm --filter @cardoc/fn-api run build
# 3. Desplegar
catalyst deploy
```

`catalyst deploy` confirmado como comando. «⚠️ verificar (docs oficiales/consola)»:

- Si `catalyst deploy` admite seleccionar función/target (p.ej. `--function api`) o despliega todo lo de `catalyst.json`.
- Si existe un flag de despliegue selectivo por target.
- El formato exacto del identificador de versión/bundle que devuelve el deploy (load-bearing para el rollback — ver §8).

Las variables de entorno **no van en el repo ni en el bundle**: se cargan en la consola del entorno (§6).

---

## 6. Variables de entorno (se cargan en la consola, NO en el repo)

Plantilla en [`.env.example`](../../.env.example). El `.env` local está gitignored. **En Catalyst, estas variables se setean en Console → Environment Variables del entorno correspondiente**, separadas entre dev y prod. El access token real de Zoho lo resuelve la **Catalyst Connection** en runtime (OAuth gestionado), no una variable de entorno con el secreto.

| Variable | Valores | Default `.env.example` | Notas |
|----------|---------|------------------------|-------|
| `CARDOC_PERSISTENCE` | `datastore` \| `memory` | `memory` | `datastore` = Catalyst DataStore; otro = repos in-memory sembrados |
| `CARDOC_CRM_MODE` | `zoho` \| `mock` | `mock` | `zoho` requiere Connection configurada; hoy es stub `NotImplemented` |
| `CARDOC_REPORTS_MODE` | `creator` \| `mock` | `mock` | `creator` = Zoho Creator/WorkDrive real; hoy stub |
| `CARDOC_CAP_DEFAULT_HOUR` | entero | `1000` | cap por defecto si el consumidor no tiene config |
| `CARDOC_CAP_DEFAULT_DAY` | entero | `10000` | |
| `CARDOC_CAP_DEFAULT_WEEK` | entero | `50000` | |
| `ZOHO_CRM_API_DOMAIN` | URL | `https://www.zohoapis.com` | dominio de API |
| `ZOHO_CRM_CONNECTOR_NAME` | string | `zoho_crm_conn` | nombre de la Connection |
| `ZOHO_CRM_ACCESS_TOKEN` | placeholder dev | — | placeholder de dev; en prod lo resuelve la Connection |

### Matriz de modos por entorno

| Entorno | Persistencia | CRM | Reports | Para qué |
|---------|--------------|-----|---------|----------|
| **dev / validación de plataforma (hoy, E-01)** | `memory` o `datastore` | `mock` | `mock` | validar deploy, health y plataforma sin adapters reales (que son stubs) |
| **dev (E-02/E-03)** | `datastore` | `zoho` | `creator` | a medida que los adapters dejen de ser stubs |
| **prod** | `datastore` | `zoho` | `creator` | producción real |

> Token de dev sembrado en memoria (solo con persistencia `memory`): `X-Api-Key: test-token` — todos los scopes, Cuenta `acc_dev`. **No existe en prod.** No usarlo para validar prod.

Setup de la Connection OAuth a CRM y residencia de la PII (UY/AR/Wyoming): ver [`./secretos-y-connections.md`](./secretos-y-connections.md) y open questions de plataforma (§9).

---

## 7. Smoke post-deploy (1 request por endpoint)

Smoke = una verificación de humo, no una suite. Un request por endpoint contra el entorno recién desplegado. **Se corre en dev tras el deploy a dev, y se repite en prod tras el deploy a prod.** Si cualquiera falla → no se promueve a prod / se dispara rollback.

> No existe (todavía) un script de smoke automatizado en el repo. Esto es un procedimiento manual. El "smoke e2e 16/16" verificado del proyecto se corrió fuera del repo; formalizar como script es follow-up (§10).

Base URL del entorno: «⚠️ verificar (consola)» la URL pública de la función Advanced I/O por entorno (dev y prod).

### 7.1 Health (abierto, sin auth) — primero siempre

Anclado a `src/app.ts`: `GET /v1/health` responde `200` con `{ "status": "ok", "service": "api" }`.

```bash
curl -sS -i "$BASE_URL/v1/health"
# Esperado: HTTP 200 y body {"status":"ok","service":"api"}
```

Si health no responde 200, el deploy no levantó — no seguir con el resto.

### 7.2 Los tres endpoints `/v1` (requieren X-Api-Key + scope)

`accountId` se resuelve SIEMPRE del token, nunca del payload/query. Usar un token válido del entorno (en dev con `memory`: `X-Api-Key: test-token`; en prod: un token real sembrado en `api_tokens`).

| Endpoint | Método | Scope | Headers obligatorios | Smoke esperado (modos mock/seed) |
|----------|--------|-------|----------------------|----------------------------------|
| `/v1/opportunity-contact` | POST | `opportunities:create` | `X-Api-Key: …`, `X-Idempotency-Key` (**obligatorio**), `Content-Type: application/json` | `200/201` en éxito; mismo key + payload distinto → `409 IDEMPOTENCY_CONFLICT` |
| `/v1/informes` | GET | `reports:read` | `X-Api-Key: …` | `200` con lista |
| `/v1/informes/:id/pdf` | GET | `reports:pdf` | `X-Api-Key: …` | `200` stream PDF; sin PDF → `404 PDF_NOT_AVAILABLE` |

```bash
# POST opportunity-contact (X-Idempotency-Key OBLIGATORIO)
curl -sS -i -X POST "$BASE_URL/v1/opportunity-contact" \
  -H "X-Api-Key: $TOKEN" \
  -H "X-Idempotency-Key: smoke-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{ "...": "payload mínimo válido — ver CONTRATOS.md" }'

# GET informes
curl -sS -i "$BASE_URL/v1/informes" -H "X-Api-Key: $TOKEN"

# GET informe PDF (reemplazar :id por uno conocido)
curl -sS -i "$BASE_URL/v1/informes/<id>/pdf" -H "X-Api-Key: $TOKEN"
```

El payload exacto de POST y los parámetros de listado están en [`../../CONTRATOS.md`](../../CONTRATOS.md).

### 7.3 Criterios de aceptación del smoke

El smoke pasa si:

1. `/v1/health` → `200`.
2. Cada endpoint protegido responde con un código del catálogo (no `500` inesperado, no timeout, no cuelgue de conexión).
3. Los errores vienen en el **sobre único**: `{ "error": { "code", "message", "correlationId", "details?" } }`.
4. Existe registro en `audit_log` por cada request a los 3 endpoints (auditoría on-finish — ver [`../../OPERACIONES.md`](../../OPERACIONES.md)).

Catálogo de códigos esperables en smoke:

| Código | HTTP | Cuándo aparece |
|--------|------|----------------|
| `VALIDATION_ERROR` | 400 | payload inválido |
| `UNAUTHENTICATED` | 401 | sin/ mal token |
| `FORBIDDEN_SCOPE` | 403 | token sin el scope (403 **solo** para scope) |
| `NOT_FOUND` | 404 | recurso inexistente o cross-tenant (cross-tenant = 404, no 403) |
| `PDF_NOT_AVAILABLE` | 404 | informe sin PDF disponible |
| `IDEMPOTENCY_CONFLICT` | 409 | misma `X-Idempotency-Key` + payload distinto |
| `UNPROCESSABLE` | 422 | semánticamente inválido |
| `CAP_EXCEEDED` | 429 | superado el cap hora/día/semana |
| `UPSTREAM_ERROR` | 502 | falla del upstream (CRM/Creator/WorkDrive) |
| `INTERNAL_ERROR` | 500 | error no controlado — **investigar antes de promover** |

---

## 8. Promoción a producción

Solo se promueve con **CI en verde + smoke de dev en verde**. Secuencia:

```bash
# 1. Confirmar smoke de dev OK (§7)
# 2. Apuntar el binding al entorno prod (ver §4 — «⚠️ verificar» el mecanismo de cambio de entorno)
# 3. Confirmar Environment Variables de prod cargadas en consola (§6) — NO heredan de dev
# 4. Regenerar bundle limpio
pnpm --filter @cardoc/fn-api run build
# 5. Desplegar a prod
catalyst deploy
# 6. Smoke en prod (§7) — repetir health + 3 endpoints contra BASE_URL de prod
```

**Antes de tocar prod, anotar la versión actualmente desplegada** (el identificador de bundle/versión de prod) — es lo que se restaura en un rollback. «⚠️ verificar (consola)» dónde se lee ese identificador (consola del entorno o salida del `catalyst deploy`).

### Ventana de congelamiento

Si aplica freeze (cierre de sprint, evento de negocio, ventana de bajo riesgo): no desplegar a prod fuera de la ventana acordada. Definir la ventana con el owner (Nestor) y registrarla. Coordinar con la regla horaria interna: deploys a prod fuera del bloque de reuniones externas, priorizando ventanas de bajo tráfico de las automotoras. *(El detalle de la ventana es decisión operativa, no técnica — confirmar con el owner antes de cada release.)*

---

## 9. Rollback

**Rollback = re-desplegar el tag/bundle anterior conocido-bueno.** No se "deshace" un deploy: se vuelve a publicar la versión previa.

### Cuándo se dispara

- Smoke de prod en rojo tras un deploy.
- `500 INTERNAL_ERROR` sistemático o `UPSTREAM_ERROR` masivo atribuible al release.
- Regresión funcional reportada por una automotora.

### Procedimiento

1. **Detener la sangría:** decidir rollback rápido. Una buena decisión ahora vale más que la perfecta dentro de una hora.
2. **Restaurar el bundle anterior.** Dos caminos, según lo que confirme el CLI/consola:
   - **Vía consola:** «⚠️ verificar (docs oficiales/consola)» si Catalyst expone historial de versiones de la función y un botón/acción de "rollback" / "restaurar versión" en el entorno.
   - **Vía CLI (re-deploy del tag previo):** recuperar el commit/tag conocido-bueno y re-desplegar:
     ```bash
     git checkout <tag-o-commit-bueno>
     NODE_OPTIONS=--use-system-ca pnpm install   # local
     pnpm --filter @cardoc/fn-api run build
     catalyst deploy
     ```
     Esto reconstruye el bundle desde el código previo y lo publica. Reproducible siempre que el commit esté tageado/identificado.
3. **Smoke post-rollback** (§7) contra prod: health + 3 endpoints. Confirmar que el código vuelve a verde.
4. **Variables de entorno:** si el release incluyó cambios en Environment Variables o en la Connection, revertirlos también en consola — el código viejo puede esperar el shape viejo.

> «⚠️ verificar (docs oficiales/consola)» — **mecanismo exacto de rollback de Catalyst**: si la plataforma guarda versiones previas del bundle y permite restaurarlas sin re-build (rollback nativo), o si el único camino soportado es el re-deploy del bundle anterior. Hasta confirmarlo, el camino canónico y siempre-disponible es el **re-deploy del tag previo** (paso 2, vía CLI), porque no depende de features de plataforma no verificadas.

### Datos y migraciones — advertencia

El rollback de **código** no revierte datos. El DataStore (tablas `crm_opportunities`, `audit_log`, etc. — ver [`./datastore-esquema.md`](./datastore-esquema.md)) y los efectos en Zoho CRM (Contacts/Deals creados) **no se deshacen** con un rollback de bundle. `audit_log` es append-only por diseño. Si el release introdujo cambios de esquema o escribió datos incompatibles, el rollback de código no alcanza: escalar y tratar como incidente de datos. Mecanismo de backup/export del DataStore: open question de plataforma (§10).

---

## 10. Open questions de plataforma (de-risk antes de producción)

Estas no se inventan: son validaciones pendientes que impactan deploy/rollback en prod. Marcadas como tales.

| Tema | Pregunta abierta | Impacto en este playbook |
|------|------------------|--------------------------|
| Rollback nativo | ¿Catalyst guarda y permite restaurar versiones previas del bundle? | Define §9 (rollback nativo vs re-deploy de tag) |
| Streaming | Streaming/chunked real y tope de payload en Advanced I/O | Smoke de `/v1/informes/:id/pdf` |
| Cap distribuido | Atomicidad del increment en Catalyst Cache (hoy los contadores son in-memory por contenedor → el cap no es global) | El smoke de `429 CAP_EXCEEDED` puede no reflejar el comportamiento prod hasta resolverlo |
| Connection OAuth | Setup de la Connection a CRM | Bloquea modos `zoho`/`creator` en deploy |
| Residencia de datos | Región/residencia de PII (UY/AR/Wyoming) | Elección del entorno/región en `catalyst init` |
| Plan | SLA / quotas / cold-start del plan | Expectativas de smoke (timeouts) |
| Logs | Retención de logs | Diagnóstico post-deploy |
| Backup | Mecanismo de backup/export del DataStore | Recuperación cuando el rollback de código no alcanza (§9) |
| Smoke automatizado | Formalizar el smoke manual como script versionado | Reemplazaría el procedimiento manual de §7 |

Open questions de **negocio** (no de deploy, no se resuelven acá): generación del PDF cuando `Analisis.pdf_url` está vacío, relación form `Informes`↔`Analisis`, API names exactos de Contacts/Deals/Accounts y si `Agendamiento Ready` es un valor de picklist existente. Ver [`../../PLAN-DE-DESARROLLO.md`](../../PLAN-DE-DESARROLLO.md).

---

## Apéndice — Secuencia mínima de deploy (cheat sheet)

```bash
# Local, una vez:
catalyst init                                   # genera .catalystrc (gitignored)

# Cada release a dev:
NODE_OPTIONS=--use-system-ca pnpm install        # red corporativa (local)
pnpm -r run typecheck && pnpm -r run test && pnpm run lint
pnpm --filter @cardoc/fn-api run build           # tsc -b + esbuild → index.js
catalyst deploy                                  # entorno dev
# → smoke (§7): health + 3 endpoints

# Promoción a prod (smoke de dev en verde):
# (apuntar binding a prod + cargar Env Vars de prod en consola)
pnpm --filter @cardoc/fn-api run build
catalyst deploy                                  # entorno prod
# → smoke (§7) en prod

# Rollback (re-deploy del tag bueno):
git checkout <tag-bueno> && pnpm --filter @cardoc/fn-api run build && catalyst deploy
# → smoke (§7)
```

Runbooks de incidente relacionados (pendientes de dry-run): outage de CRM, outage de Creator/WorkDrive, cap mal configurado, credencial comprometida, PDF que no se genera. Plantilla: [`../runbooks/_template.md`](../runbooks/_template.md).
