---
title: Integración con ML (MLCenter / AutoCheck) — inbound + outbound
status: borrador-para-validacion
last_reviewed: 2026-07-01
---

# Integración con ML (MLCenter / AutoCheck)

**ML** = la plataforma **MLCenter / "Mi Auto"·"TuAuto"** (`mlcenter.com.uy`), producto
**AutoCheck** = solicitudes de inspección de vehículos. cardoc se integra en **dos sentidos**:

| Sentido | Quién llama | Qué pasa |
|---------|-------------|----------|
| **IN** | ML → cardoc | ML carga una **solicitud AutoCheck** vía `POST /v1/opportunity-contact`. Se crea una **Oportunidad (Deal)** en Zoho CRM (`Stage = Nueva Solicitud`) con Contacto + Cuenta. El `NroSolicitud` de AutoCheck es el **External ID** de la Oportunidad. |
| **OUT** | cardoc → ML | Cuando la solicitud cambia de estado (en CRM), cardoc le **notifica a ML** vía `POST /api/autocheck/estado/actualizar`. |

Este playbook cubre el lado **OUTBOUND** (la notificación de estado). Decisión:
[ADR-0013](../decisions/README.md#adr-0013).

## Contrato del endpoint de ML (AutoCheck — Actualizar Estado)

| | |
|---|---|
| **Prod** | `https://www.mlcenter.com.uy/apimiauto/api/autocheck/estado/actualizar` |
| **Testing** | `https://www.mlcenter.com.uy/ApiMiAutoTesting/api/autocheck/estado/actualizar` |
| **Auth** | JWT Bearer. Token vía `POST {base}/api/login/authenticatecardoc` `{ Usuario, Password }` → `{ Status, Token }`. Dura **1 h** → se cachea. |

**Body** (`POST estado/actualizar`, contrato **v1.1**):

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|:-----------:|-------------|
| `NroSolicitud` | long | ✅ | Nº de solicitud AutoCheck = **External ID** de la Oportunidad |
| `Estado` | string (≤50) | ✅ | `COORDINACIÓN` \| `FINALIZADO` |
| `NombreTecnico` | string (≤100) | ✅ **(nuevo v1.1)** | Técnico que hace el chequeo (del `Deals.Inspector`) |
| `Empresa` | string (≤100) | ✅ **(nuevo v1.1)** | Empresa inspectora |
| `LinkResultado` | string (≤500) | ⚠️ si `FINALIZADO` | URL del resultado/informe |
| `Observaciones` | string (≤500) | ❌ | Notas |

**Máquina de estados** (la valida ML): `PENDIENTE → COORDINACIÓN → FINALIZADO` (terminal).
`LinkResultado` obligatorio en `FINALIZADO`; **`NombreTecnico`/`Empresa` obligatorios en TODA
actualización (v1.1)**. **Anti-duplicados:** re-notificar el mismo estado → `400`. Errores:
`{ codigo, mensaje, detalles[] }` (400 validación / transición inválida / mismo estado — **cliente,
no reintentable**; 401 sin token; 5xx upstream). El adapter preserva el httpStatus y el use-case mapea
**400 → 422** (invalid) y **5xx → 502** (error). Doc fuente:
[`../reference/API_ENDPOINT_ACTUALIZAR_ESTADO_AUTOCHECK.md`](../reference/API_ENDPOINT_ACTUALIZAR_ESTADO_AUTOCHECK.md) (v1.1).

## Arquitectura del disparo: CRM workflow → Catalyst → MlCenterClient

El cambio de estado nace en **CRM** (`Deal.Stage`). El disparo (confirmado):

```
CRM (workflow rule on Stage change)
   │  webhook (shared-secret x-internal-secret) con { nroSolicitud, stage, linkResultado?, observaciones? }
   ▼
Catalyst function  ─ POST /v1/internal/deal-estado  (sin Bearer; requireInternalSecret)
   │  notifyEstadoChange: mapea Stage→Estado, valida LinkResultado
   ▼
MlCenterClient  ─ login JWT (cacheado 1h) → POST /api/autocheck/estado/actualizar
```

**Por qué así** (no Deluge en CRM): la lógica (login JWT, mapeo, retry, errores) vive en
**código versionado** y los secretos en **Catalyst**, no embebidos en la plataforma (la
lección de cfe: código editado en CRM = código perdido). El workflow del CRM solo "avisa".

## Dónde vive en el código

| Pieza | Archivo |
|-------|---------|
| Puerto + adapter (Mock + HTTP real con cache de JWT) | `packages/providers/src/mlcenter-client.ts` |
| Use-case (mapeo Stage→Estado, regla LinkResultado) | `packages/application/src/notify-estado-change.ts` |
| Ruta interna (CRM → Catalyst) | `apps/catalyst/functions/api/src/routes/internal.ts` |
| Shared-secret middleware | `requireInternalSecret` en `.../middleware/auth.ts` |
| Schema del body | `dealEstadoSchema` en `packages/domain/src/schemas.ts` |
| Config / flags | `CARDOC_ML_MODE`, `MLCENTER_*`, `INTERNAL_WEBHOOK_SECRET` (ver `.env.example`) |

Estado: **scaffold listo y verificado**, alineado al contrato **v1.1** (2026-07-15: `NombreTecnico`/
`Empresa` obligatorios end-to-end + clasificación 400/5xx). Smoke: 401 sin secret · 200 `skipped` con
stage no mapeado · 422 sin técnico/empresa · 422 FINALIZADO sin link · 400 payload inválido. El adapter
HTTP real está implementado y **✅ validado contra el sandbox de testing (2026-07-15):** login
(`200 {Status:"OK",Token}`), `COORDINACIÓN` aceptada (`200`), y anti-duplicados (re-notificar el mismo
estado → `400 {codigo,mensaje,detalles[]}` → el use-case lo mapea a `422`). Falta el impacto real en
**producción** (cargar `MLCENTER_*` prod en Env Vars + `MLCENTER_BASE_URL=.../apimiauto`).

## Lo que falta para activarlo (open questions)

- **[OQ-N6](../OPEN-QUESTIONS.md)** — mapeo `Deal.Stage` (CRM) → `Estado` (ML). **✅ (b) mapeo
  confirmado e implementado** (Nestor 2026-07-01) en `STAGE_TO_ESTADO` (`notify-estado-change.ts`):
  `Nueva Solicitud`→`PENDIENTE` (inicial, se re-notifica; Nestor 2026-07-03); `Agendado B2B`→`COORDINACIÓN`;
  `Completado`/`Cerrado`→`FINALIZADO` (requiere `LinkResultado`); solo `Cancelado`→sin notificar
  (`skipped`). **✅ (a) Confirmado (Nestor 2026-07-03):** el workflow del CRM dispara sobre
  `Deals.Stage` (no `Informes_Revision.Estado`), así que las claves del mapa son correctas.
- **[OQ-N7](../OPEN-QUESTIONS.md)** — origen del `LinkResultado` (FINALIZADO): ¿el PDF del
  informe (Creator/WorkDrive `pdf_url`) o un link público distinto?
- **[OQ-N10](../OPEN-QUESTIONS.md)** (nuevo, v1.1) — fuente de `NombreTecnico`/`Empresa`. Decidido
  con Nestor (2026-07-15): **los manda el CRM en el webhook**. `nombreTecnico` = `Deals.Inspector`
  (lookup → `Inspectores`); `empresa` = **⚠️ api_name/fuente por confirmar** (placeholder
  `Empresa_Inspectora` en el Deluge). Además, el re-notify de `PENDIENTE` en `Nueva Solicitud`
  choca con el anti-duplicados de v1.1 → **pedir confirmación a ML** o mapear a `skipped`.
- **[OQ-P9](../OPEN-QUESTIONS.md)** — credenciales `authenticatecardoc` (Usuario/Password):
  **provistas (2026-07-15)** → cargar en Catalyst Environment Variables (`MLCENTER_USER/PASSWORD`),
  **nunca en el repo**. Primer impacto real contra **testing** (`.../ApiMiAutoTesting`).
- ✅ Campo **External ID** (API `EXTERNAL_ID`) creado en Deals para persistir el `NroSolicitud`
  ([ADR-0002](../decisions/README.md#adr-0002)).

## Operación

- El token JWT se cachea ~1h; ante `401` el adapter lo descarta y re-loguea.
- Códigos de la ruta interna: `200 sent` (notificado) · `200 skipped` (stage no notificable) ·
  **`422 UNPROCESSABLE`** (validación: FINALIZADO sin `LinkResultado` — ML **no** se llama, no
  reintentable) · **`502 UPSTREAM_ERROR{mlcenter}`** (fallo REAL de ML — reintentable).
- Reintentos: solo el `502` (fallo de ML) es candidato a retry/backoff del disparo (workflow CRM
  o un worker); se define al activar — runbook pendiente (ver [../runbooks/_template.md](../runbooks/_template.md)).
