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
| **OQ-N3** | API names de los módulos CRM. **Resuelta:** estándar — Oportunidad=`Deals`, Cuenta=`Accounts`, Contacto=`Contacts` (ver `discovery/modules/`). Hallazgos: Contacts **sin** campo Documento → dedup por Email ([ADR-0003](decisions/README.md#adr-0003)); Deals **sin** lookup a Accounts (Cuenta vía `Contact.Account_Name`) y **sin** campo External ID → **crearlo** ([ADR-0002](decisions/README.md#adr-0002)). | E-02 | ✅ resuelta |
| **OQ-N4** | ¿`Agendamiento Ready` es un valor de picklist (Stage) existente? ¿Cuál es su API name? (lado IN, al crear el Deal). | E-02 | 🔴 abierta |
| **OQ-N5** | La relación token ↔ Cuenta, ¿es 1:1 o un token puede operar varias Cuentas? (el diseño asume 1:1). | E-04 (modelo de tenancy) | 🟡 asumido 1:1 |
| **OQ-N6** | Mapeo CRM `Deal.Stage` → ML `Estado` (`COORDINACIÓN` / `FINALIZADO`): qué valores del picklist Stage corresponden a cada uno. Hoy `STAGE_TO_ESTADO` es placeholder vacío. | E-07 (outbound a ML) · [ADR-0013](decisions/README.md#adr-0013) | 🔴 abierta |
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
