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
| `nombreTecnico` | string (≤100) | Sí* | **Nuevo (ML v1.1).** Técnico que hace el chequeo. Se lee del `Deals.Inspector` (lookup → `Inspectores`). |
| `empresa` | string (≤100) | Sí* | **Nuevo (ML v1.1).** Empresa inspectora. ⚠️ Confirmar api_name/fuente (ver script). |
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

	// 1. Traer el Deal para leer Stage + NroSolicitud (EXTERNAL_ID) + inspector/empresa
	deal = zoho.crm.getRecordById("Deals", dealId.toLong());
	stage = ifnull(deal.get("Stage"), "").toString().trim();
	nroSolicitud = ifnull(deal.get("EXTERNAL_ID"), "").toString();

	// Técnico + empresa (ML v1.1: obligatorios en toda actualización).
	// `Inspector` es un lookup → módulo Inspectores; en Deluge el lookup devuelve un map con name/id.
	inspectorMap = deal.get("Inspector");
	nombreTecnico = "";
	if(inspectorMap != null)
	{
		nombreTecnico = ifnull(inspectorMap.get("name"), "").toString().trim();
	}
	// ⚠️ CONFIRMAR (Nestor): api_name/fuente exacta de la EMPRESA inspectora. Candidatos:
	//    (a) un campo de la Oportunidad (ej. deal.get("Empresa_Inspectora")); o
	//    (b) un campo del registro Inspectores (traerlo con zoho.crm.getRecordById("Inspectores", id)); o
	//    (c) valor fijo si siempre inspecciona la misma empresa.
	// Placeholder hasta confirmar — reemplazar por la fuente real:
	empresa = ifnull(deal.get("Empresa_Inspectora"), "").toString().trim();

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
	// NombreTecnico/Empresa (obligatorios en ML v1.1). Se envían si están cargados; el backend los
	// EXIGE para los stages notificables → si faltan responde 422 (ML no se llama). Se omiten vacíos
	// para que el error del backend sea claro ("obligatorios") en vez de mandar strings en blanco.
	if(nombreTecnico != "")
	{
		payload.put("nombreTecnico", nombreTecnico);
	}
	if(empresa != "")
	{
		payload.put("empresa", empresa);
	}
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
- **Técnico/empresa (ML v1.1):** `nombreTecnico` sale de `Deals.Inspector` (lookup → `Inspectores`);
  `empresa` tiene la **fuente por confirmar** (⚠️ ver el placeholder `Empresa_Inspectora` en el script).
  El backend los exige para todo stage notificable → sin ellos responde `422`, ML no se llama.
- **⚠️ `Nueva Solicitud → PENDIENTE` bajo v1.1:** ML aplica **anti-duplicados** (re-notificar el mismo
  estado → `400`) y su param `Estado` solo lista `COORDINACIÓN`/`FINALIZADO`. Como ML ya crea la
  solicitud en PENDIENTE, re-notificarla puede devolver `400`; el backend lo trata como `422`
  (no reintentable), no como falso `502`. Pedir a ML confirmación de que tolera el re-notify de
  PENDIENTE (y que en ese estado no exige inspector aún), o mapear `Nueva Solicitud → skipped`.
- Para producción real de ML: credenciales `MLCENTER_USER/PASSWORD` + `CARDOC_ML_MODE=http` (OQ-P9).

Ver también: `docs/reference/api-endpoints.md` (§ `POST /v1/internal/deal-estado`),
`packages/application/src/notify-estado-change.ts` (mapeo), `packages/providers/src/mlcenter-client.ts`.
