---
title: Open questions — cardoc-ml (registro único)
status: active
document_type: open-questions
last_reviewed: 2026-06-30
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
| **OQ-N6** | Mapeo estado CRM → ML `Estado` (`COORDINACIÓN` / `FINALIZADO`). **(b) Mapeo ✅ confirmado (Nestor 2026-07-01) e implementado** en `STAGE_TO_ESTADO`: `Agendado B2B`→`COORDINACIÓN`; `Completado`/`Cerrado`→`FINALIZADO` (requiere `LinkResultado`); `Nueva Solicitud`/`Cancelado`→sin notificar. **(a) Residual 🔴:** el field-tracker `Historial_de_Estado` trackea `Informes_Revision.Estado`, **no** `Deals.Stage` → falta confirmar la **fuente del disparo** (el diseño asume `Deals.Stage`, consistente con el endpoint `deal-estado`). Ver [`reference/crm-data-model.md`](reference/crm-data-model.md). | E-07 · [ADR-0013](decisions/README.md#adr-0013) | 🟡 mapeo resuelto; fuente pendiente |
| **OQ-N7** | Origen del `LinkResultado` que se envía a ML en `FINALIZADO`: ¿el PDF del informe (Creator/WorkDrive `pdf_url`) o un link público distinto? | E-07 | 🔴 abierta |
| **OQ-N8** | **Tamaño del PDF por volumen de fotos.** El smoke e2e con un informe real (id `4837888000004307360`) dio **132 componentes, 302 fotos → PDF de 126 MB** (pdf-lib embebe los bytes crudos; achicar el `drawImage` no reduce el peso). Inviable para streamear por Catalyst y para el cliente. **Decidir estrategia:** (a) downscale/re-encode de cada foto antes de embeber (lib JS pura tipo jimp — sin binario); (b) thumbnails de WorkDrive si existen; (c) cap de fotos por componente/informe; o combinación. También revisar el **cap actual** (6/componente) y la resolución objetivo. | E-03 (PDF producción) · [ADR-0012](decisions/README.md#adr-0012) | 🔴 abierta (bloquea producción del PDF) |

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
| **OQ-P9** | Credenciales de `POST /api/login/authenticatecardoc` (Usuario/Password de cardoc) para el adapter ML → Catalyst Environment Variables; y URL prod vs testing. | E-07 (outbound a ML) · [ADR-0013](decisions/README.md#adr-0013) · [integracion-mlcenter](playbooks/integracion-mlcenter.md) | 🔴 abierta |
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
