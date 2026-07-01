---
title: "Bitácora — 2026-06-30 · E-02 CRM real + deploy datastore+zoho en Catalyst"
date: 2026-06-30
status: cerrado
owner: Nestor Toñanez
tipo: registro-de-sesión
---

# Bitácora del 2026-06-30

Registro cronológico de lo implementado, diagnosticado y decidido en la jornada. Complementa la
doc canónica (playbooks / ADRs, que son de *referencia*) con el *relato* de la sesión: qué se hizo,
qué rompió, cómo se resolvió y qué quedó verificado.

> **Una línea:** el adapter CRM real (E-02) quedó implementado, la idempotencia pasó a dos capas,
> y el modo `datastore+zoho` **funciona y está validado end-to-end en Catalyst (alta real 5/5)**.
> 12 commits, toda la doc sincronizada al as-built.

---

## 1. Objetivo de la jornada

Pasar de "plataforma desplegada en `memory+mock`" a **crear Oportunidades reales en Zoho CRM desde
la función Catalyst** (`CARDOC_CRM_MODE=zoho` + `CARDOC_PERSISTENCE=datastore`), y **documentar el
procedimiento correcto** — porque el camino se descubrió a los golpes y no queremos repetir el dolor.

---

## 2. Lo implementado

### 2.1 E-02 — `ZohoCrmClient` real (Zoho REST v2)
- Adapter real contra Zoho CRM REST v2: `findContactByCedula` → `createContact` → `createOpportunity`.
- **Dedup de Contacto por cédula** (campo custom `Cedula` en Contacts) y **de Oportunidad por
  `EXTERNAL_ID` = `NroSolicitud`** (único en Deals). Zoho responde `DUPLICATE_DATA` con el id
  existente → el adapter lo devuelve como `duplicate`, no como error.
- Stage del Deal fijado **server-side**: `Nueva Solicitud` (pipeline B2B).
- Manejo de `DUPLICATE_DATA` / `INVALID_DATA` con error enriquecido (código Zoho + campo ofensor).

### 2.2 Idempotencia en dos capas (ADR-0002)
- **Capa 1 — middleware (Catalyst):** SOLO si llega el header **`X-Idempotency-Key`** (esa es la
  clave, *no* el `NroSolicitud`). Row en `crm_opportunities` con `UNIQUE(idempotency_key)` +
  `payload_fingerprint`, consultado **antes** de tocar Zoho → replay = `200 duplicate`; misma clave +
  payload distinto = `409 IDEMPOTENCY_CONFLICT`.
- **Capa 2 — base (Zoho CRM):** SIEMPRE. `EXTERNAL_ID` único → verdad durable, sobrevive un reset del
  DataStore. Sin header, la Capa 2 es la única autoridad.

### 2.3 DataStore — bootstrap y esquema
- CSVs de bootstrap (`scripts/datastore-bootstrap/`) para crear las 5 tablas en consola con los
  tipos exactos de Catalyst (Var Char / Int; **sin** BigInt / DateTime / Foreign Key — se enlaza por
  clave de negocio string, no por ROWID).
- Seed del token de dev (`api_tokens`) mapeado a la Cuenta ML.

### 2.4 Deploy `datastore+zoho` funcionando en Catalyst
- El **fix central** que destrabó todo: cómo shippear el SDK de Catalyst (§4).
- Auth CRM real por **self-client OAuth** (§4).
- Alta real validada end-to-end (§5).

---

## 3. Cronología del diagnóstico (lo que rompió y cómo se resolvió)

El deploy en modo real falló en cascada. Cada `500`/`401` tenía una causa distinta:

| # | Síntoma | Causa raíz | Fix definitivo |
|---|---------|-----------|----------------|
| 1 | `500` — `Cannot find module 'express'` (histórico, del smoke previo) | Catalyst **no instala** las `dependencies` del `package.json` | Inlinar `express`/`zod`/`@cardoc/*` en el bundle |
| 2 | `500` — `Cannot find module 'zcatalyst-sdk-node'` | El SDK externalizado **no lo provee el runtime** | Shippearlo como `node_modules` real |
| 3 | `500` — `Cannot find module './zcql/zcql'` | Al inlinar el SDK, esbuild no resuelve sus **`require()` dinámicos** de submódulos | Externalizarlo + materializarlo real (no inlinar) |
| 4 | `500` — `error interno` (opaco) | El `errorMiddleware` no expone el detalle (por diseño) | Debug temporal en dev → surfacear `err.message`, revertir |
| 5 | `401` — `"token inválido"` en **todo** | La tabla `api_tokens` estaba **vacía** (DDL crea tablas sin filas) | Sembrar `api_tokens` por **"Add Row"** (no CSV: el `scopes` JSON rompe el importador) |
| 6 | `502` — `INVALID_DATA {api_name:"Cedula", expected:"text"}` | El campo `Cedula` en Zoho es **texto**, se enviaba número | Enviar `String(nroCedula)` |

> El detalle síntoma→causa→fix quedó versionado en
> [`docs/playbooks/deploy-y-rollback.md` §9.5](../playbooks/deploy-y-rollback.md) (troubleshooting).

---

## 4. El fix central: SDK como `node_modules` real + self-client

**SDK bundling (ADR-0010).** `zcatalyst-sdk-node`:
- **no se puede inlinar** (hace `require()` dinámicos de sus submódulos → esbuild no los resuelve),
- **ni lo provee el runtime** de Catalyst,
- y el **symlink de pnpm se rompe** al zipear en `catalyst deploy`.

Solución as-built:
1. Se **externaliza** (lista única en `scripts/function-externals.mjs`, consumida por el bundle).
2. Se **materializa como `node_modules` real** en el function dir vía `scripts/deploy-prep-sdk.mjs`.
3. Nuevo paso **`pnpm --filter @cardoc/fn-api predeploy`** (= `build` + `deploy:prep`) antes de
   `catalyst deploy`. **Gotcha:** tras un `pnpm install`, pnpm restaura el symlink → re-correr `predeploy`.

**Auth CRM = self-client OAuth (ADR-0004).** La *Catalyst Connection* de consola tenía un **bug que
no generaba refresh token**, así que la auth se resuelve por **self-client a nivel código**: el SDK
renueva el access token con `ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN` (en Environment
Variables), resolución lazy + memoizada por request. Override directo `ZOHO_CRM_ACCESS_TOKEN` para test.

**Columna reservada.** `timestamp` es reservado en Catalyst → `audit_log` usa **`_timestamp`**.

**UNIQUE single-column.** La UI de Catalyst no permite UNIQUE compuesto → la idempotencia Capa 1 se
apoya en `UNIQUE(idempotency_key)`; `account_id` se filtra en la query como defensa de tenancy, no en
el índice.

---

## 5. Verificación (todo corrido, no "debería")

| Check | Comando | Resultado |
|-------|---------|-----------|
| Alta real en Catalyst (`datastore+zoho`) | `scripts/smoke-catalyst-crm.mjs` | **5/5** ✅ |
| Alta real local (CRM real) | `pnpm zoho:check --write` | Contact `6687138000035846001` + Opp `6687138000035847001` creados; 2ª corrida = `duplicate` (sin registros nuevos) ✅ |
| Suite unitaria | `pnpm test` | **25 tests** (domain 3 · providers 10 · application 12) ✅ |
| Smoke local (in-process) | `pnpm smoke` | **21/21** ✅ |
| Smoke remoto (mock/seed) | `pnpm smoke:catalyst` | **12/12** ✅ |
| Typecheck | `pnpm typecheck` | Done (5 packages) ✅ |

**Cobertura del smoke CRM real (Catalyst):** Capa 2 sin header (created + `duplicate` por
`EXTERNAL_ID`), Capa 1 con `X-Idempotency-Key` (created + `409` por payload distinto),
stage `Nueva Solicitud`.

---

## 6. Decisiones (ADRs tocadas/creadas hoy)

| ADR | Qué | Estado |
|-----|-----|--------|
| [0002](../decisions/README.md#adr-0002) | Idempotencia en 2 capas (`X-Idempotency-Key` opcional + `EXTERNAL_ID` único) | Implementada |
| [0004](../decisions/README.md#adr-0004) | Auth CRM = **self-client OAuth** (SDK); la Catalyst Connection quedó descartada (bug) | Revisada |
| [0010](../decisions/README.md#adr-0010) | Bundle: inlina todo salvo el SDK, que se **externaliza + shippea real** | Revisada (con historia de los 3 intentos) |
| [0015](../decisions/README.md#adr-0015) | `GET /v1/informes` (listado pull) descartado — ML es push (E-07) | Aceptada |

---

## 7. Artefactos nuevos

| Archivo | Rol |
|---------|-----|
| `scripts/function-externals.mjs` | Fuente única de externals del bundle (SDK) |
| `scripts/deploy-prep-sdk.mjs` | Materializa el SDK real en `node_modules` (idempotente) |
| `scripts/smoke-catalyst-crm.mjs` | Probe del alta real sobre la función desplegada (`datastore+zoho`) |
| `scripts/zoho-crm-check.mjs` | Prueba local del `ZohoCrmClient` contra el CRM real (READ / `--write`) |
| `scripts/datastore-bootstrap/*` | CSVs + README para crear/seed las tablas del DataStore en consola |
| `docs/playbooks/deploy-y-rollback.md` §9.5 | Tabla de troubleshooting (síntoma→causa→fix) |

---

## 8. Commits del día (12)

```
6c673ab docs: sincronizar documentacion al as-built del deploy en Catalyst
a8d1f55 fix(deploy): SDK como node_modules real -> datastore+zoho funcionando en Catalyst
644ea96 docs(datastore): aclarar por que no se usa Foreign Key (enlace por clave de negocio, no ROWID)
28fbad2 docs(datastore): tipos de columna exactos (Catalyst) en el bootstrap
c9247f9 chore(datastore): CSVs de bootstrap para crear/seed las tablas del DataStore en consola
1a9ed64 fix(crm): Cedula es campo TEXT en Zoho + diagnostico de errores + script al dia
09dae1d fix(idempotency): review adversarial — Capa 1 honra dealDuplicate + trim del header
0560ae0 feat(idempotency): dos capas — X-Idempotency-Key opcional (Catalyst) + EXTERNAL_ID unico (CRM)
92abc79 docs(scope): GET /v1/informes (listado) descartado — ADR-0015 (ML es push, no pull)
5ddfe51 test(crm): script local de prueba del ZohoCrmClient contra el CRM real
d804585 docs(deploy): re-deploy de E-02 a Catalyst ML — smoke remoto 12/12 verde (2026-06-30)
2dbd178 feat(crm): E-02 — ZohoCrmClient real (Zoho REST v2) + self-client OAuth + idempotencia robusta
```

---

## 9. Estado final del entorno

- Función `api` viva en el proyecto **ML** (env Development):
  `https://ml-909785950.development.catalystserverless.com/server/api/`.
- Modo activo verificado: `CARDOC_PERSISTENCE=datastore` + `CARDOC_CRM_MODE=zoho`.
- Env vars del self-client (`ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`) cargadas en consola.
- `api_tokens` sembrado (Cuenta ML `6687138000031320073`, token de dev `test-token`).
- Debug temporal de errores **revertido**; deploy final limpio.

---

## 10. Pendientes / próximos pasos

- **E-03 (solo PDF):** `GET /v1/informes/:id/pdf`; `ZohoCreatorReportsSource` sigue stub
  (`NotImplementedError`). El listado pull quedó descartado (ADR-0015).
- **E-07 (outbound a ML):** notificación de cambio de estado del Deal → `MlCenterClient`
  (credenciales de ML pendientes — [OQ-P9](../OPEN-QUESTIONS.md)).
- **Token de producción** (reemplazar `test-token`) + seed del `api_tokens` de prod.
- **De-risk de plataforma:** rollback nativo, cap distribuido (Cache), residencia de PII,
  rotación del refresh token del self-client. Ver [OPEN-QUESTIONS](../OPEN-QUESTIONS.md).
- `git push` de los commits del día (pendiente del owner).

---

## Referencias

- Deploy y troubleshooting: [`playbooks/deploy-y-rollback.md`](../playbooks/deploy-y-rollback.md)
- Bundling: [`playbooks/monorepo-build-y-bundling.md`](../playbooks/monorepo-build-y-bundling.md)
- Secretos / self-client: [`playbooks/secretos-y-connections.md`](../playbooks/secretos-y-connections.md)
- DataStore: [`playbooks/datastore-esquema.md`](../playbooks/datastore-esquema.md) · `scripts/datastore-bootstrap/`
- Decisiones: [`decisions/README.md`](../decisions/README.md)
