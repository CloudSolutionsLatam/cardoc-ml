---
title: CRM Deluge — notificación de estado de Oportunidad (E-07, lado CRM)
status: referencia (script CRM-side; vive en la consola de Zoho CRM, se versiona acá)
document_type: integration-reference
last_reviewed: 2026-07-15
---

# Deluge · `ml_notificar_estado_oportunidad` (botón en Deals)

Pieza **CRM-side** de E-07. Es la función Deluge (botón/workflow sobre el módulo **Deals**)
que dispara nuestro endpoint interno cuando cambia el `Stage` de una Oportunidad, para que
cardoc-ml notifique el estado a ML (AutoCheck).

> El disparo del workflow del CRM es sobre **`Deals.Stage`** (confirmado, OQ-N6.a 2026-07-03).

## Qué endpoint impacta

`POST {baseUrl}/v1/internal/deal-estado` — ruta INTERNA (CRM → Catalyst), protegida por
**shared-secret** en el header `x-internal-secret` (NO Bearer; Catalyst reserva `Authorization`).

Contrato (payload, `dealEstadoSchema` `.strict()` — solo estos campos):

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `nroSolicitud` | int | Sí | External ID de la Oportunidad (`Deals.EXTERNAL_ID`). |
| `stage` | string | Sí | Valor de `Deals.Stage`. El backend lo mapea a `Estado` de ML. |
| `nombreTecnico` | string (≤100) | Sí* | **Nuevo (ML v1.1).** Técnico que hace el chequeo. Se lee del `Deals.Inspector` (lookup → `Inspectores`). |
| `empresa` | string (≤100) | Sí* | **Nuevo (ML v1.1).** Empresa inspectora — constante **`"Certia"`** (hardcodeada en el Deluge). |
| `linkResultado` | url | Solo si FINALIZADO | URL del PDF del informe = endpoint D3b `/v1/informes/solicitud/{nroSolicitud}/pdf`. |
| `observaciones` | string (≤500) | No | Texto libre opcional. |

> \* `nombreTecnico`/`empresa` son **opcionales en el schema** pero el backend los **exige**
> cuando el stage sí notifica (todo estado que va a ML): si faltan → `422 UNPROCESSABLE`, ML no
> se llama (mismo patrón que `linkResultado` en FINALIZADO). Son **obligatorios en ML v1.1** para
> TODA actualización, así que el Deluge debe mandarlos siempre que el Deal tenga inspector asignado.

Mapeo que aplica el backend (`STAGE_TO_ESTADO`): `Nueva Solicitud → PENDIENTE`;
`Agendado B2B → COORDINACIÓN`; `Completado`/`Cerrado → FINALIZADO` (requiere `linkResultado`);
`Cancelado`/otros → `skipped` (no notifica).
Respuestas: `200 {status:"sent"|"skipped"}`, `422 UNPROCESSABLE` (FINALIZADO sin link),
`502 UPSTREAM_ERROR` (falla real de ML).

## Función

El código Deluge vive en [`ml_notificar_estado_oportunidad.dg`](ml_notificar_estado_oportunidad.dg)
— **fuente única**, espejo de lo que está en la consola de Zoho CRM. Qué hace:

1. Lee del Deal: `Stage`, `EXTERNAL_ID` (= `nroSolicitud`) e `Inspector` (→ `nombreTecnico`).
2. Fija `empresa = "Certia"` (constante).
3. **Siempre** postea `POST /v1/internal/deal-estado` con el `stage` crudo + `x-internal-secret`;
   el backend re-mapea, decide `sent`/`skipped` y valida el invariante (fuente de verdad única).
4. Adjunta `linkResultado` (PDF por `nroSolicitud`) solo cuando el stage mapea a `FINALIZADO`.
5. `nombreTecnico` se omite si el Deal no tiene `Inspector` → el backend responde `422` (falta técnico).

⚠️ Antes de prod, revisar en el `.dg`: `baseUrl` (dominio del entorno), `internalSecret`
(el `INTERNAL_WEBHOOK_SECRET` real, no el fallback dev) y que `Inspector.name` sea efectivamente
el nombre del técnico (= campo primario del módulo `Inspectores`).

## Notas de implementación

- **Mapeo local `stageToEstado`** — es un **espejo** del `STAGE_TO_ESTADO` del backend
  (`packages/application/src/notify-estado-change.ts`), usado **solo** para decidir cuándo adjuntar
  `linkResultado` (solo `FINALIZADO`). La función **SIEMPRE notifica**: envía el `stage` crudo y el
  backend re-mapea, decide `sent`/`skipped` y lo registra en `audit_log` — es la **fuente de verdad
  única**. Así queda rastro de cada cambio de estado (incluidos los `skipped`) en los Logs de Catalyst.
  ⚠️ Si cambian los nombres de stage del pipeline B2B, actualizar **ambos** (Deluge + backend).
- **`parameters : payload.toString()`** — `payload` es un `Map`; `.toString()` produce JSON y,
  junto al header `Content-Type: application/json`, se envía como body JSON crudo (si se pasara
  el `Map` directo, Deluge lo form-encodearía).
- **Secreto:** hoy hardcodeado el fallback dev. En prod usar el `INTERNAL_WEBHOOK_SECRET` real
  (setearlo también en las Environment Variables de Catalyst) y, preferentemente, guardarlo en
  una **variable de organización** de Zoho en lugar de literal en el script.
- **Base URL:** dev apunta a `…development.catalystserverless.com`. Para producción, cambiar por
  el dominio del entorno prod.
- **Inspección:** con `CARDOC_ML_MODE=log` en Catalyst, cada disparo deja en los Logs de la
  función las líneas `[ml-notify]` (inbound + payload que iría a ML) sin llamar a ML real.
- **Técnico/empresa (ML v1.1):** `nombreTecnico` = `Deals.Inspector` (lookup → `Inspectores`, campo
  primario); `empresa` = constante **`"Certia"`**. El backend los exige para todo stage notificable →
  sin ellos responde `422`, ML no se llama (en `Nueva Solicitud` no suele haber Inspector → `422`).
- **⚠️ `Nueva Solicitud → PENDIENTE` bajo v1.1:** ML aplica **anti-duplicados** (re-notificar el mismo
  estado → `400`) y su param `Estado` solo lista `COORDINACIÓN`/`FINALIZADO`. Como ML ya crea la
  solicitud en PENDIENTE, re-notificarla puede devolver `400`; el backend lo trata como `422`
  (no reintentable), no como falso `502`. Pedir a ML confirmación de que tolera el re-notify de
  PENDIENTE (y que en ese estado no exige inspector aún), o mapear `Nueva Solicitud → skipped`.
- Para producción real de ML: credenciales `MLCENTER_USER/PASSWORD` + `CARDOC_ML_MODE=http` (OQ-P9).

Ver también: `docs/reference/api-endpoints.md` (§ `POST /v1/internal/deal-estado`),
`packages/application/src/notify-estado-change.ts` (mapeo), `packages/providers/src/mlcenter-client.ts`.
