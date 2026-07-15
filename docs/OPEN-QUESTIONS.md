---
title: Open questions — cardoc-ml (registro único)
status: active
document_type: open-questions
last_reviewed: 2026-07-02
---

# Open questions — registro único

Registro **canónico** de lo que falta confirmar antes de cerrar E-02/E-03 y salir a
producción. Los demás documentos (ARQUITECTURA, PLAN, ASSISTANT, README) **enlazan acá**
en vez de repetir la lista.

- **Negocio (OQ-N\*)** → las cierra **Nestor** con el dueño del proceso.
- **Plataforma (OQ-P\*)** → se de-riskean contra la **consola/docs de Catalyst** o un thin slice.

Al cerrar una pregunta: marcar el estado, anotar la respuesta, y mover la decisión
resultante al [log de ADRs](decisions/README.md) si corresponde.

## Negocio

| ID | Pregunta | Bloquea | Estado |
|----|----------|---------|--------|
| **OQ-N1** | Generación del PDF. **✅ (a) Motor: pdf-lib en Catalyst** (Nestor 2026-07-01; cardoc-ml es el **generador único**). **✅ (b) Contenido/layout: reconstruido del informe REAL** (contrato §4 + reglas §4.5 + layout §5.5 de `reference/pdf-backend/planning.md`): `transformReportData` portado + `InformeReport` + layout fiel (no pixel-1:1). **Residual 🟡 (c):** el **read real desde Creator** (`Analisis`), el **write-back** a `pdf_url` y el **embebido de fotos** (WorkDrive, vía `ImageFetcher`) quedan para cablear E-03; hoy `MockReportsSource` arma un `InformeReport` de muestra. | E-03 (adapter Creator) · [ADR-0012](decisions/README.md#adr-0012) | 🟡 generación lista; read Creator pendiente |
| **OQ-N2** | Relación entre `Informes` y `Analisis` en Creator. La Custom API `GET_INSPECTION_REPORT_DETAIL` la **abstrae**: devuelve el envelope agregado (`{code:3000, result:{...modulos[].sub_modulos[].components[]...}}`) que `transformReportData` ya consume. Residual: confirmar que el acceso server-to-server (OQ-P10) devuelve el **mismo shape** que el SDK del portal. Solo afecta al PDF (listado descartado, [ADR-0015](decisions/README.md#adr-0015)). | E-03 (PDF) | 🟡 acotada (shape consumido; endpoint en OQ-P10) |
| **OQ-N3** | Contrato inbound de ML + módulos CRM. **Resuelto (mail 2026-06-25):** payload **plano** (NroCedula, NroSolicitud, Nombres, Apellidos, CelularCliente, Tenant, Sucursal/Depto/Ciudad/Direccion, Marca/Modelo/Anio/Matricula). Dedup por **NroCedula** ([ADR-0003](decisions/README.md#adr-0003)); idempotencia por **NroSolicitud** ([ADR-0002](decisions/README.md#adr-0002)); **una sola Cuenta "ML"** (el campo `Tenant` es informativo). **Tareas CRM (Nestor):** campo `Cedula` en Contacts ✅ · campo External ID en Deals (API `EXTERNAL_ID`) ✅ · Cuenta "ML" (pendiente). | E-02 | ✅ resuelta |
| **OQ-N4** | Valor del Stage de Deals al crear (lado IN). **Resuelto (Nestor 2026-06-30):** `Nueva Solicitud` + `Pipeline = "B2B"`, **verificados** en `settings/stages`/`settings/pipeline` (`FIXED_OPPORTUNITY_STAGE` + `ZOHO_FIXED_PIPELINE`). | E-02 | ✅ resuelta |
| **OQ-N5** | La relación token ↔ Cuenta, ¿es 1:1 o un token puede operar varias Cuentas? (el diseño asume 1:1). | E-04 (modelo de tenancy) | 🟡 asumido 1:1 |
| **OQ-N6** | Mapeo estado CRM → ML `Estado` (`PENDIENTE` / `COORDINACIÓN` / `FINALIZADO`). **(b) Mapeo ✅ confirmado (Nestor 2026-07-01) e implementado** en `STAGE_TO_ESTADO`: `Nueva Solicitud`→`PENDIENTE` (inicial, se re-notifica; ampliado Nestor 2026-07-03); `Agendado B2B`→`COORDINACIÓN`; `Completado`/`Cerrado`→`FINALIZADO` (requiere `LinkResultado`); solo `Cancelado`→sin notificar. **(a) ✅ Confirmado (Nestor 2026-07-03):** el workflow del CRM dispara sobre **`Deals.Stage`** (no `Informes_Revision.Estado`) → las claves del mapa son correctas. | E-07 · [ADR-0013](decisions/README.md#adr-0013) | ✅ resuelta |
| **OQ-N7** | Origen del `LinkResultado` que se envía a ML en `FINALIZADO`: ¿el PDF del informe (Creator/WorkDrive `pdf_url`) o un link público distinto? | E-07 | 🔴 abierta |
| **OQ-N10** | **Fuente de `NombreTecnico`/`Empresa` (contrato ML v1.1, obligatorios en toda actualización).** **Decidido (Nestor 2026-07-15): los manda el CRM en el webhook** — implementado end-to-end (`dealEstadoSchema` + use-case exige ambos para stages notificables → `422` si faltan). `nombreTecnico` = `Deals.Inspector` (lookup → `Inspectores`). **Residual 🔴:** (a) **api_name/fuente exacta de `empresa`** — placeholder `Empresa_Inspectora` en el Deluge, por confirmar; (b) **re-notify de `PENDIENTE`** (`Nueva Solicitud`) choca con el **anti-duplicados** de v1.1 (mismo estado → `400`) y su param `Estado` solo lista `COORDINACIÓN`/`FINALIZADO` → confirmar con ML si tolera el re-notify (y si exige inspector en PENDIENTE) o mapear a `skipped`. | E-07 · v1.1 · [integracion-mlcenter](playbooks/integracion-mlcenter.md) | 🟡 mecanismo hecho; fuente de `empresa` + PENDIENTE por confirmar |
| **OQ-N9** | La Custom API `GET_INSPECTION_REPORT_DETAIL` (Deluge) no devuelve HOY datos fiables: `inspector.fecha` (fecha de inspección) llega **vacía** y `vehicle.motor`/`vehicle.transmision` **no correctos** (detectado 2026-07-03 en el informe real `4837888000004307360`). **Workaround en cardoc:** el nombre del PDF usa la **fecha de generación** como fallback cuando `inspector.fecha` falta (`buildReportFilename`); motor/transmisión se muestran tal cual llegan. **Fix de fondo (Nestor, lado Deluge):** corregir la función personalizada para devolver `inspector.fecha` + `motor`/`transmisión`. | E-03 (datos del PDF) | 🟡 workaround activo; fix Deluge pendiente |
| **OQ-N8** | **Fotos del informe (evidencia).** Smoke e2e (id `4837888000004307360`): **132 componentes, 302 fotos** (fuentes ~1080×1920, ~365 KB c/u). ✅ **Layout (2026-07-03):** fotos **2 por fila dentro de la tarjeta** (proporción natural, paginación por segmentos), fiel a la referencia aceptada — reemplaza el layout previo de fotos grandes 1/fila con caption. ✅ **Decisión (Nestor 2026-07-02):** las fotos son **evidencia** → se embeben **en su calidad ORIGINAL, sin recomprimir** (probado: q80 solo baja 126→86 MB —31%— y detalle de motores comprime mal; no compensa degradar). jimp **descartado** (no aportaba y sumaba ~88s + dependencia). Generación **~17s**, prefetch en paralelo. **Residual 🟡 (peso inherente):** el PDF pesa **~126 MB** por ser 302 fotos de evidencia — no se resuelve con compresión sino con **caché/write-back** (ADR-0012: generar una vez, streamear el cacheado) y/o el **portal digital** para zoom profundo. Tope actual `MAX_PHOTOS=6`/componente. | E-03 (PDF producción) · [ADR-0012](decisions/README.md#adr-0012) | 🟡 layout+calidad definidos; peso/caché pendiente |

## Plataforma (Catalyst)

| ID | Pregunta | Bloquea | Estado |
|----|----------|---------|--------|
| **OQ-P1** | Streaming en Advanced I/O. **✅ Resuelta (smoke 2026-06-25):** el PDF se streamea OK desde Catalyst (`application/pdf`, `%PDF`, `Cache-Control: no-store`). Tope de payload para PDFs muy grandes: aún por medir. | AC-05 (stream PDF) | ✅ resuelta (tope grande pendiente) |
| **OQ-P2** | Atomicidad del increment en Catalyst Cache (para el cap distribuido). Hoy los contadores son in-memory por contenedor. | Cap global · [ADR-0011](decisions/README.md#adr-0011) | 🔴 abierta |
| **OQ-P3** | Setup de la Connection OAuth a CRM (conector, scopes, DC) y API exacta del SDK para resolver el `accessToken` en runtime. **As-built:** la auth CRM real **ya funciona y está validada** (E-02, alta real en Catalyst contra Zoho vía `smoke-catalyst-crm.mjs`), pero **no** vía Catalyst Connection: la función resuelve el token por **self-client a nivel código** (`CrmConnection.getAccessToken()`) porque hay un bug de la Catalyst Connection con el refresh token. Residual: evaluar si migrar a la Connection gestionada una vez resuelto ese bug. | ~~E-02~~ (auth CRM real ✅) · [ADR-0004](decisions/README.md#adr-0004) | 🟡 acotada (self-client en prod) |
| **OQ-P4** | Región/residencia de datos para la PII (jurisdicciones UY/AR/Wyoming). | Compliance pre-prod | 🔴 abierta |
| **OQ-P5** | SLA/uptime, quotas (invocaciones, concurrencia, payload) y cold-start del plan contratado. | Capacidad / targets de calidad | 🔴 abierta |
| **OQ-P6** | Retención nativa de logs. | Observabilidad | 🔴 abierta |
| **OQ-P7** | Mecanismo de backup/export del DataStore. | Runbook de restore | 🔴 abierta |
| **OQ-P8** | Índices/constraints del DataStore y comando exacto de rollback del CLI. **Aclaración as-built:** Catalyst **no** crea DDL por API/SDK (CONSOLE ONLY) y **no** admite UNIQUE compuesto por UI (solo single-column) — la pregunta original por `UNIQUE(account_id, idempotency_key)` estaba **mal planteada**. La idempotencia Capa 1 se apoya en `UNIQUE(idempotency_key)` (single-column), **ya creado y validado** (smoke Catalyst: 409 `IDEMPOTENCY_CONFLICT`); el filtrado por `(account_id, idempotency_key)` en el código es lectura defensiva de tenancy, **no** el constraint del índice. Residual: comando exacto de rollback del CLI. | rollback ([deploy](playbooks/deploy-y-rollback.md)) | 🟡 acotada (rollback pendiente) |
| **OQ-P9** | Credenciales de `POST /api/login/authenticatecardoc` (Usuario/Password de cardoc) para el adapter ML → Catalyst Environment Variables; y URL prod vs testing. **Provistas y ✅ validadas contra testing (2026-07-15):** login `200 {Status:"OK",Token}` (usuario `cardoc@ml.com.uy`), `COORDINACIÓN` aceptada (`200`), anti-duplicados (mismo estado → `400 {codigo,mensaje,detalles[]}` → mapeado a `422`). Creds en `.env` gitignoreado / Env Vars, **nunca en el repo**. **Residual:** cargar `MLCENTER_*` de **producción** + `MLCENTER_BASE_URL=.../apimiauto` + `CARDOC_ML_MODE=http` en Env Vars de Catalyst e impacto real en prod. | E-07 (outbound a ML) · [ADR-0013](decisions/README.md#adr-0013) · [integracion-mlcenter](playbooks/integracion-mlcenter.md) | 🟢 auth+update validados en testing; falta prod |
| **OQ-P10** | **Acceso server-to-server a Creator** (E-03). ✅ **Validado en vivo (Nestor 2026-07-01):** `GET https://www.zohoapis.com/creator/custom/cardoc/GET_INSPECTION_REPORT_DETAIL?publickey=<clave>&id=..&portalType=ml` — con key la API procesa; **sin key → 401** (auth Public Key enforced); no requiere token de sesión. Fotos de WorkDrive **públicas → sin auth**. Código cableado: `CREATOR_REPORT_DETAIL_URL` (una sola env var con la key embebida; **la key NO va al repo**), `authMode` publickey (default) u oauth (a futuro, mismo self-client del CRM — `CREATOR_AUTH_MODE=oauth`). **✅ RESUELTO — circuito probado end-to-end (2026-07-01, id real `4837888000004307360` → `code:3000`).** El `9430` era por falta del `token` de sesión: cardoc-ml lo **acuña él mismo** replicando la Deluge del portal — mini-JWT `{id, iat, exp(ms, +7d)}` AES-256-CBC (`zoho.encryption.aesEncode`: clave NUL-pad-32, IV prepended, Base64), verificado contra el test vector oficial de Zoho y contra el endpoint real. Implementado en `creator-token.ts` (config-driven `CREATOR_TOKEN_KEY`, `CREATOR_TOKEN_CLIENT_ID`; la key es **secreto fuerte** → solo Env Vars). **Residual (ops):** cargar `CREATOR_REPORT_DETAIL_URL` + `CREATOR_TOKEN_KEY` en Env Vars + flag `CARDOC_REPORTS_MODE=creator`. **Ver OQ-N8** (tamaño del PDF por volumen de fotos) antes de producción. | E-03 (adapter Creator) · [ADR-0012](decisions/README.md#adr-0012) | 🟢 resuelto (probado e2e) |

> ✅ El `UNIQUE(idempotency_key)` (single-column) **ya está creado en consola y verificado** en
> Catalyst (smoke: 409 `IDEMPOTENCY_CONFLICT`), así que la idempotencia (ADR-0002) **rechaza el
> duplicado** en `datastore` mode. Recordar que el DDL es CONSOLE ONLY: si se recrea la tabla y se
> omite el `UNIQUE`, `insertRow` deja de rechazar el duplicado y la idempotencia falla en silencio.

## Follow-ups técnicos (no bloquean, anotados)

- Auditoría on-finish (ADR-0007) no cubre un `500` de `attachContainer` (queda solo en logs). Decidir si se fuerza un registro mínimo.
- Filas de idempotencia `pending` huérfanas (un POST que muere antes de `markCreated`) no tienen TTL/reaper → replays devuelven `202 in_progress` indefinidamente.
- El estado `error` ahora es **reintentable** (efecto idempotente: dedup por cédula + `EXTERNAL_ID`). Residual: dos retries concurrentes de un row en `error` podrían ejecutar el efecto en paralelo (ventana acotada por los dedup, sin CAS sobre el estado del row).
- Smoke e2e ya **versionado** en el repo (`scripts/smoke-catalyst-crm.mjs`, 5/5 en Catalyst; smoke local 21/21). Follow-up: mantenerlo al día con nuevos endpoints.
- Runbooks concretos sin escribir (solo la plantilla) — dry-run pre-producción.

## Cierre §10 CR-003 (mail Cardoc, 2026-07-02)

Cardoc respondió las 7 decisiones pendientes del §10 del CR-003. Estado de cierre e impacto en el código
(detalle por `file:line` en el plan de reconciliación, workflow `walwrb4r5`):

| # | Decisión | Definición Cardoc | Estado en código | Acción |
|---|----------|-------------------|------------------|--------|
| D1 | "Portal solicitante" | Identificar el origen de la operación | ✅ **Sin acción de cardoc** (Nestor 2026-07-02) | La Oportunidad ya nace en el pipeline ML (origen implícito); el campo "portal" se completa **downstream** (`Informes_Revision` al cierre + informe Creator). cardoc consume portal en la lectura (`portalType=ml`) |
| D2 | Dedup Contactos | Sugieren **teléfono** | ⚠️ **Discrepancia** (ver abajo) | **Mantener NroCedula** (ADR-0003); **escalar a PM** |
| D3a | Stage Oportunidad | "Nueva Solicitud" (funnel B2B) | ✅ ya implementado (OQ-N4) | Constancia |
| D3b | Gating de exposición | Exponer solo si Oportunidad=Completado **y** Informe=Finalizado | Gating **descartado** (sin Analisis no hay datos) | ✅ **Implementado**: variante `GET /v1/informes/solicitud/:nroSolicitud/pdf` busca en `Informes_Revision` por `Nro_Solicitud_Externo` → `Creator_Analisis_ID` → PDF (Mock + Zoho real + tests). api_name confirmados por Nestor 2026-07-02 |
| D4 | Nomenclatura PDF | `NombreCliente_IDInterno_Fecha.pdf` (fecha ISO) | ✅ **implementado** (`buildReportFilename`, `reports-source.ts`) | ⚠️ IDInterno hoy = `reportCode` "#R-12345"; el ejemplo "INFREV-4248" **no está en el detalle** → pedir a backend exponer el `number` del CRM |
| D5 | Filtros / ID opaco | ID de Informe opaco, fecha ISO, Estado Open/Completed | Endpoint 2 **desestimado** (ADR-0015); el CR es previo | Sin acción de listado. El "ID opaco" solo aplicaría a la URL del Endpoint 3 si se decide (hoy usa id interno de Creator) |
| D6 | Valores de cap | POST 60/h · GET informes 120/h · GET PDF 100/h | ✅ **sembrado** (`consumer_caps.csv` + `scripts/seed-caps.mjs`) | Cargar filas en consola (Add Row). Día/semana quedan en defaults (guardrail) |
| D7 | Cross-tenant | **404** (no divulgación) | ✅ ya responde 404 `NOT_FOUND` (ADR-0005) | Constancia; sellar ADR-0005 |

### ⚠️ D2 — Discrepancia para PM (dedup Contactos: teléfono vs cédula)

El mail de Cardoc (2026-07-02) sugiere usar **número de teléfono** como clave de dedup de Contactos.
**Sin embargo, el JSON de contrato que el propio cliente compartió indica `Cedula` como identificador**, y por
eso nuestro [ADR-0003](decisions/README.md#adr-0003) implementó la dedup por **NroCedula** (campo `Cedula` en
Contacts, ya creado en el CRM). **Decisión operativa (Nestor 2026-07-02):** por ahora se **mantiene NroCedula**
(no se cambia a teléfono) y se **eleva la discrepancia al PM** para conciliar el contrato definitivo. Argumento
técnico a favor de la cédula: es numérica, estable y única; el teléfono es opcional, mutable y sin normalizar
(`+598…` ≠ `09…` en el `equals` exacto de Zoho) → riesgo de falsos duplicados. Relacionado: OQ-N3.

### Inputs pendientes de Cardoc para completar el cierre

- ~~**D3b:** api_name del módulo `Informes_Revision`~~ ✅ **RESUELTO (Nestor 2026-07-02):** módulo `Informes_Revision`, búsqueda por `Nro_Solicitud_Externo`, id de Análisis en `Creator_Analisis_ID`. Variante implementada.
- **D4:** ¿IDInterno del filename = `reportCode` ("#R-12345") o el `number` del CRM ("INFREV-xxxx")? (hoy el detalle no trae `number`).
- ~~**D1:** api_name del campo "Portal solicitante"~~ ✅ **RESUELTO (Nestor 2026-07-02):** sin acción de cardoc — la Oportunidad ya nace en el pipeline ML; el campo se completa downstream (`Informes_Revision` al cierre + informe Creator).
- **D6:** ¿día/semana explícitos por endpoint, o se dejan en defaults como guardrail?
