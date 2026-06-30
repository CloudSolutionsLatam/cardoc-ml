---
title: Open questions — cardoc-ml (registro único)
status: active
document_type: open-questions
last_reviewed: 2026-06-25
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
| **OQ-N1** | Cuando `Analisis.pdf_url` está vacío, ¿cómo se genera el PDF? (plantilla nativa de Creator vs HTML→PDF en Catalyst vs servicio existente) y ¿de qué datos sale? | E-03 (generación PDF) · [ADR-0012](decisions/README.md#adr-0012) | 🔴 abierta |
| **OQ-N2** | Relación entre el form `Informes` y el form `Analisis` en Zoho Creator (¿mismo registro, related, o el listado es sobre `Analisis`?). Define la forma final de `InformeRevision` (hoy PLACEHOLDER). | E-02c (GET informes) / E-03 | 🔴 abierta |
| **OQ-N3** | Contrato inbound de ML + módulos CRM. **Resuelto (mail 2026-06-25):** payload **plano** (NroCedula, NroSolicitud, Nombres, Apellidos, CelularCliente, Tenant, Sucursal/Depto/Ciudad/Direccion, Marca/Modelo/Anio/Matricula). Dedup por **NroCedula** ([ADR-0003](decisions/README.md#adr-0003)); idempotencia por **NroSolicitud** ([ADR-0002](decisions/README.md#adr-0002)); **una sola Cuenta "ML"** (el campo `Tenant` es informativo). **Tareas CRM (Nestor):** campo `Cedula` en Contacts ✅ · campo External ID en Deals (API `EXTERNAL_ID`) ✅ · Cuenta "ML" (pendiente). | E-02 | ✅ resuelta |
| **OQ-N4** | Valor del Stage de Deals al crear (lado IN). **Resuelto (Nestor 2026-06-30):** `Nueva Solicitud` (provisional, "por ahora"); es `FIXED_OPPORTUNITY_STAGE` en `types.ts`. | E-02 | ✅ resuelta |
| **OQ-N5** | La relación token ↔ Cuenta, ¿es 1:1 o un token puede operar varias Cuentas? (el diseño asume 1:1). | E-04 (modelo de tenancy) | 🟡 asumido 1:1 |
| **OQ-N6** | Mapeo estado CRM → ML `Estado` (`COORDINACIÓN` / `FINALIZADO`). **Hallazgo (discovery 2026-06-30):** el field-tracker `Historial_de_Estado` trackea `Informes_Revision.Estado`, **no** `Deals.Stage` → primero decidir cuál es la fuente del estado (Stage del Deal vs Estado del Informe), luego qué valores mapean. `STAGE_TO_ESTADO` es placeholder vacío. Ver [`reference/crm-data-model.md`](reference/crm-data-model.md). | E-07 (outbound a ML) · [ADR-0013](decisions/README.md#adr-0013) | 🔴 abierta |
| **OQ-N7** | Origen del `LinkResultado` que se envía a ML en `FINALIZADO`: ¿el PDF del informe (Creator/WorkDrive `pdf_url`) o un link público distinto? | E-07 | 🔴 abierta |

## Plataforma (Catalyst)

| ID | Pregunta | Bloquea | Estado |
|----|----------|---------|--------|
| **OQ-P1** | Streaming en Advanced I/O. **✅ Resuelta (smoke 2026-06-25):** el PDF se streamea OK desde Catalyst (`application/pdf`, `%PDF`, `Cache-Control: no-store`). Tope de payload para PDFs muy grandes: aún por medir. | AC-05 (stream PDF) | ✅ resuelta (tope grande pendiente) |
| **OQ-P2** | Atomicidad del increment en Catalyst Cache (para el cap distribuido). Hoy los contadores son in-memory por contenedor. | Cap global · [ADR-0011](decisions/README.md#adr-0011) | 🔴 abierta |
| **OQ-P3** | Setup de la Connection OAuth a CRM (conector, scopes, DC) y API exacta del SDK para resolver el `accessToken` gestionado en runtime. | E-02 (auth CRM real) · [ADR-0004](decisions/README.md#adr-0004) | 🔴 abierta |
| **OQ-P4** | Región/residencia de datos para la PII (jurisdicciones UY/AR/Wyoming). | Compliance pre-prod | 🔴 abierta |
| **OQ-P5** | SLA/uptime, quotas (invocaciones, concurrencia, payload) y cold-start del plan contratado. | Capacidad / targets de calidad | 🔴 abierta |
| **OQ-P6** | Retención nativa de logs. | Observabilidad | 🔴 abierta |
| **OQ-P7** | Mecanismo de backup/export del DataStore. | Runbook de restore | 🔴 abierta |
| **OQ-P8** | Sintaxis/UI exacta para crear el `UNIQUE(account_id, idempotency_key)` y demás índices en la consola; comando exacto de rollback del CLI. | Idempotencia en prod ([datastore-esquema](playbooks/datastore-esquema.md)) · rollback ([deploy](playbooks/deploy-y-rollback.md)) | 🔴 abierta |
| **OQ-P9** | Credenciales de `POST /api/login/authenticatecardoc` (Usuario/Password de cardoc) para el adapter ML → Catalyst Environment Variables; y URL prod vs testing. | E-07 (outbound a ML) · [ADR-0013](decisions/README.md#adr-0013) · [integracion-mlcenter](playbooks/integracion-mlcenter.md) | 🔴 abierta |

> ⚠️ Mientras OQ-P8 no se cierre y el `UNIQUE` no esté creado en consola, la idempotencia
> (ADR-0002) **falla en silencio** en `datastore` mode: `insertRow` no rechaza el duplicado.

## Follow-ups técnicos (no bloquean, anotados)

- Auditoría on-finish (ADR-0007) no cubre un `500` de `attachContainer` (queda solo en logs). Decidir si se fuerza un registro mínimo.
- Filas de idempotencia `pending` huérfanas (un POST que muere antes de `markCreated`) no tienen TTL/reaper → replays devuelven `202 in_progress` indefinidamente.
- Formalizar el smoke e2e como script versionado en el repo (hoy se corre fuera).
- Runbooks concretos sin escribir (solo la plantilla) — dry-run pre-producción.
