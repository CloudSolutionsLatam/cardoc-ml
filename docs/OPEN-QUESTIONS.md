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
| **OQ-N1** | Generación del PDF cuando `Analisis.pdf_url` está vacío. **✅ (a) Motor decidido (Nestor 2026-07-01): pdf-lib en Catalyst** (detrás del puerto `PdfGenerator`; descartados Chromium y —para el arranque— Zoho Writer). Slice implementado: genera un PDF real y lo streamea (data de muestra). **Residual 🟡 (b):** el **contenido/diseño real** (campos e ítems de inspección, layout) es provisional hasta tener el sample de AutoCheck; y **(c)** el **read/write-back contra Creator** (`Analisis`) queda para E-03. | E-03 (generación PDF) · [ADR-0012](decisions/README.md#adr-0012) | 🟡 motor resuelto; contenido+read pendientes |
| **OQ-N2** | Relación entre el form `Informes` y el form `Analisis` en Zoho Creator. Ahora **solo afecta al PDF** (`GET /v1/informes/:id/pdf`) — el listado `GET /v1/informes` quedó descartado ([ADR-0015](decisions/README.md#adr-0015)). | E-03 (PDF) | 🟡 acotada |
| **OQ-N3** | Contrato inbound de ML + módulos CRM. **Resuelto (mail 2026-06-25):** payload **plano** (NroCedula, NroSolicitud, Nombres, Apellidos, CelularCliente, Tenant, Sucursal/Depto/Ciudad/Direccion, Marca/Modelo/Anio/Matricula). Dedup por **NroCedula** ([ADR-0003](decisions/README.md#adr-0003)); idempotencia por **NroSolicitud** ([ADR-0002](decisions/README.md#adr-0002)); **una sola Cuenta "ML"** (el campo `Tenant` es informativo). **Tareas CRM (Nestor):** campo `Cedula` en Contacts ✅ · campo External ID en Deals (API `EXTERNAL_ID`) ✅ · Cuenta "ML" (pendiente). | E-02 | ✅ resuelta |
| **OQ-N4** | Valor del Stage de Deals al crear (lado IN). **Resuelto (Nestor 2026-06-30):** `Nueva Solicitud` + `Pipeline = "B2B"`, **verificados** en `settings/stages`/`settings/pipeline` (`FIXED_OPPORTUNITY_STAGE` + `ZOHO_FIXED_PIPELINE`). | E-02 | ✅ resuelta |
| **OQ-N5** | La relación token ↔ Cuenta, ¿es 1:1 o un token puede operar varias Cuentas? (el diseño asume 1:1). | E-04 (modelo de tenancy) | 🟡 asumido 1:1 |
| **OQ-N6** | Mapeo estado CRM → ML `Estado` (`COORDINACIÓN` / `FINALIZADO`). **(b) Mapeo ✅ confirmado (Nestor 2026-07-01) e implementado** en `STAGE_TO_ESTADO`: `Agendado B2B`→`COORDINACIÓN`; `Completado`/`Cerrado`→`FINALIZADO` (requiere `LinkResultado`); `Nueva Solicitud`/`Cancelado`→sin notificar. **(a) Residual 🔴:** el field-tracker `Historial_de_Estado` trackea `Informes_Revision.Estado`, **no** `Deals.Stage` → falta confirmar la **fuente del disparo** (el diseño asume `Deals.Stage`, consistente con el endpoint `deal-estado`). Ver [`reference/crm-data-model.md`](reference/crm-data-model.md). | E-07 · [ADR-0013](decisions/README.md#adr-0013) | 🟡 mapeo resuelto; fuente pendiente |
| **OQ-N7** | Origen del `LinkResultado` que se envía a ML en `FINALIZADO`: ¿el PDF del informe (Creator/WorkDrive `pdf_url`) o un link público distinto? | E-07 | 🔴 abierta |

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
