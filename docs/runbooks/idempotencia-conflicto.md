# Runbook — Conflicto de idempotencia (mismo NroSolicitud / clave, payload distinto)

> Diagnóstico desde el `correlationId` (`X-Correlation-Id`) → `audit_log`.
> Ver [OPERACIONES.md §5](../../OPERACIONES.md).

## Cuándo se dispara

`POST /v1/opportunity-contact` devuelve **`409 IDEMPOTENCY_CONFLICT`**: llegó una `X-Idempotency-Key`
ya vista **con un payload distinto** al original. Normalmente es un **bug del cliente**
(reusar la clave para otro contenido), no una falla del servicio. Detección: `409` en
`audit_log` (`endpoint = "opportunity-contact"`, `error_code = "IDEMPOTENCY_CONFLICT"`) o
reporte del integrador.

## Impacto

El alta puntual se rechaza (por diseño — protege contra sobrescrituras silenciosas). No hay
duplicación ni corrupción: es una **negativa segura**. Afecta a un request, no al servicio.

## Diagnóstico

Recordar el modelo de **dos capas** (ADR-0002):
- **Capa 1 (Catalyst)** — SOLO si llega el header **`X-Idempotency-Key`**. Row en
  `crm_opportunities` con `UNIQUE(idempotency_key)` + `payload_fingerprint`. Misma clave +
  **mismo** payload → `200 duplicate`; misma clave + payload **distinto** → **`409`**.
- **Capa 2 (CRM)** — SIEMPRE. Dedup por `EXTERNAL_ID = NroSolicitud`. Sin header, es la única
  autoridad y **no** detecta "mismo número, payload distinto" (eso es exclusivo de Capa 1).

Pasos:
1. `correlationId` del `409` → `audit_log`: confirmar `error_code = "IDEMPOTENCY_CONFLICT"`.
2. Es Capa 1 (hubo `X-Idempotency-Key`). La fila original vive en `crm_opportunities`
   (`account_id`, `idempotency_key`, `payload_fingerprint`, `status`). El `payload_fingerprint`
   del request nuevo **no coincide** con el guardado.
3. Determinar con el integrador cuál es el payload correcto: ¿reusó la clave por error, o
   cambió datos legítimamente (p.ej. corrigió una cédula)?

## Resolución

1. **Reuso accidental de la clave (cliente):** el integrador debe usar una **clave nueva** por
   payload distinto, o reenviar el payload **idéntico** (→ `200 duplicate`). No se toca el
   servidor.
2. **Corrección legítima de datos con la misma clave:** el diseño **no** hace update in-place
   (la clave ya se consumió). Opciones:
   - Reenviar con una **`X-Idempotency-Key` nueva** (crea/dedupea por Capa 2: si el
     `NroSolicitud` ya existe en CRM, responde `duplicate` sin duplicar el Deal).
   - Corregir el registro directamente en Zoho CRM si ya se creó (fuera de la API).
3. **Nunca** editar `payload_fingerprint` a mano para "forzar" el paso — enmascara el conflicto.

## Verificación

Reenvío con clave nueva (o payload idéntico) → `201 created` / `200 duplicate`; sin filas
duplicadas en CRM para ese `NroSolicitud` (dedup por `EXTERNAL_ID`).

## Dry-run

Cubierto por `pnpm smoke` (in-process, mock CRM):
- `POST` con `X-Idempotency-Key` + payload → `201 created`.
- Repetir misma clave + mismo payload → `200 duplicate`.
- Misma clave + payload distinto → **`409 IDEMPOTENCY_CONFLICT`**.

Verificado en verde en el smoke local (21+ checks) y en el smoke remoto contra Catalyst
(`scripts/smoke-catalyst-crm.mjs`, Capa 1 con header → `409` por payload distinto).

## Prevención / follow-up

- Documentar en onboarding: `X-Idempotency-Key` **única por intención de alta**; no reutilizar
  para payloads distintos (ver [CONTRATOS.md](../../CONTRATOS.md)).
- Filas `pending` huérfanas (un POST que muere antes de `markCreated`) no tienen TTL/reaper →
  replays devuelven `202 in_progress` indefinidamente (follow-up conocido,
  [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md)).
