---
title: CRM Deluge — notificación de estado de Oportunidad (E-07, lado CRM)
status: referencia (script CRM-side; vive en la consola de Zoho CRM, se versiona acá)
document_type: integration-reference
last_reviewed: 2026-07-03
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
| `linkResultado` | url | Solo si FINALIZADO | URL del PDF del informe = endpoint D3b `/v1/informes/solicitud/{nroSolicitud}/pdf`. |
| `observaciones` | string (≤500) | No | Texto libre opcional. |

Mapeo que aplica el backend (`STAGE_TO_ESTADO`): `Nueva Solicitud → PENDIENTE`;
`Agendado B2B → COORDINACIÓN`; `Completado`/`Cerrado → FINALIZADO` (requiere `linkResultado`);
`Cancelado`/otros → `skipped` (no notifica).
Respuestas: `200 {status:"sent"|"skipped"}`, `422 UNPROCESSABLE` (FINALIZADO sin link),
`502 UPSTREAM_ERROR` (falla real de ML).

## Función

```js
string button.ml_notificar_estado_oportunidad(String dealId)
{
	// ── Config ───────────────────────────────────────────────────────────
	// Dev. Para prod cambiar por el dominio del entorno de producción.
	baseUrl = "https://ml-909785950.development.catalystserverless.com/server/api";
	// ⚠️ Reemplazar por el INTERNAL_WEBHOOK_SECRET REAL del entorno (el 'dev-internal-secret'
	//    es solo el fallback de desarrollo). Idealmente en una variable de org.
	internalSecret = "dev-internal-secret";

	// ── Mapeo Stage (CRM) → Estado (ML) ───────────────────────────────────
	// ESPEJO de STAGE_TO_ESTADO del backend (packages/application/src/notify-estado-change.ts).
	// Acá se usa SOLO para decidir cuándo adjuntar linkResultado (FINALIZADO). La función SIEMPRE
	// notifica: el backend re-mapea el stage crudo, decide sent/skipped y lo registra en audit_log.
	// ⚠️ Mantener EN SINCRONÍA con el backend si cambian los nombres de stage del pipeline B2B.
	stageToEstado = Map();
	stageToEstado.put("Nueva Solicitud", "PENDIENTE");
	stageToEstado.put("Agendado B2B", "COORDINACIÓN");
	stageToEstado.put("Completado", "FINALIZADO");
	stageToEstado.put("Cerrado", "FINALIZADO");

	// 1. Traer el Deal para leer Stage + NroSolicitud (EXTERNAL_ID)
	deal = zoho.crm.getRecordById("Deals", dealId.toLong());
	stage = ifnull(deal.get("Stage"), "").toString().trim();
	nroSolicitud = ifnull(deal.get("EXTERNAL_ID"), "").toString();

	// Guard: sin NroSolicitud no se puede notificar (el payload lo exige)
	if(nroSolicitud == "" || nroSolicitud == "null")
	{
		return "ERROR: el Deal " + dealId + " no tiene EXTERNAL_ID (NroSolicitud); no se notifica.";
	}

	// 2. Payload — SIEMPRE se notifica; el backend decide sent/skipped (.strict(): solo estos campos).
	//    Se envía el STAGE crudo; el backend re-mapea (fuente de verdad única) y valida el invariante.
	estado = ifnull(stageToEstado.get(stage), "");
	payload = Map();
	payload.put("nroSolicitud", nroSolicitud.toLong());
	payload.put("stage", stage);
	// LinkResultado (URL del PDF por NroSolicitud) es obligatorio para FINALIZADO —
	// en Completado/Cerrado el informe ya existe. En COORDINACIÓN/otros no se adjunta.
	if(estado == "FINALIZADO")
	{
		payload.put("linkResultado", baseUrl + "/v1/informes/solicitud/" + nroSolicitud + "/pdf");
	}

	// 3. Headers — auth por shared-secret (NO Bearer; Catalyst reserva Authorization)
	headers = Map();
	headers.put("x-internal-secret", internalSecret);
	headers.put("Content-Type", "application/json");

	// 4. POST a Catalyst: /v1/internal/deal-estado
	response = invokeurl
	[
		url : baseUrl + "/v1/internal/deal-estado"
		type : POST
		parameters : payload.toString()
		headers : headers
	];

	// El endpoint responde { status: sent|skipped, ... } (200) o el sobre de error.
	return response.toString();
}
```

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
- Para producción real de ML: credenciales `MLCENTER_USER/PASSWORD` + `CARDOC_ML_MODE=http` (OQ-P9).

Ver también: `docs/reference/api-endpoints.md` (§ `POST /v1/internal/deal-estado`),
`packages/application/src/notify-estado-change.ts` (mapeo), `packages/providers/src/mlcenter-client.ts`.
