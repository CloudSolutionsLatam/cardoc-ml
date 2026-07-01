# Runbook — Outage de Zoho CRM (alta de oportunidades)

> Diagnóstico siempre desde el `correlationId` de la respuesta (`X-Correlation-Id`) →
> `audit_log` (`searchByCorrelationId`). Ver [OPERACIONES.md §5](../../OPERACIONES.md).

## Cuándo se dispara

`POST /v1/opportunity-contact` devuelve **`502 UPSTREAM_ERROR`** con
`details.upstream = "crm"` de forma sostenida, y/o filas quedando en `status = "error"` en
`crm_opportunities`. Detección: alerta sobre tasa de `502` en `audit_log`
(`endpoint = "opportunity-contact"`, `error_code = "UPSTREAM_ERROR"`) o ráfaga de filas
`error`. El label opaco (`crm`) va en la **respuesta al consumidor** (`details.upstream`),
**no** en `audit_log`: ahí se infiere por el endpoint (`opportunity-contact` ⇒ CRM).

## Impacto

Ninguna automotora puede dar de alta solicitudes AutoCheck (crear Contacto + Oportunidad en
Zoho CRM). **No afecta** `GET /v1/informes` ni el PDF (upstream distinto: Creator/WorkDrive).
Degradación **total** del alta inbound; el resto del servicio sigue en pie.

## Diagnóstico

1. Tomar el `correlationId` de un `502` → `audit_log`: confirmar `endpoint = "opportunity-contact"`,
   `error_code = "UPSTREAM_ERROR"`, `http_status = 502`.
2. Separar **outage de plataforma** vs **credencial nuestra**:
   - **Auth (self-client OAuth):** el CRM se autentica con el self-client que renueva el access
     token usando `ZOHO_REFRESH_TOKEN` (Environment Variables). Un refresh token
     **revocado/expirado** rompe **todas** las altas (401 del lado Zoho, visible solo en los
     logs de Catalyst — nunca se expone al consumidor). Ver
     [secretos-y-connections.md](../playbooks/secretos-y-connections.md).
   - **Outage de Zoho:** estado de la plataforma en la consola/status page de Zoho.
   - **Rate-limit de Zoho:** ráfagas de 502 correlacionadas con picos de volumen.
3. Revisar los logs de Catalyst del request (solo IDs y códigos, sin PII ni URL interna).

## Resolución

1. **Outage de plataforma Zoho** → no hay fix local. Escalar **N3 (Zoho)**. Las altas fallan
   con `502`; el consumidor **debe reintentar** — es seguro: el mismo `NroSolicitud` no
   duplica (Capa 2 dedup por `EXTERNAL_ID`). Comunicar a las automotoras.
2. **Refresh token revocado/expirado** → rotar `ZOHO_REFRESH_TOKEN` (y client id/secret si
   aplica) en Catalyst Console → Environment Variables → **redeploy**. El access token lo
   renueva el SDK en runtime (no se hardcodea). Ver
   [secretos-y-connections.md](../playbooks/secretos-y-connections.md).
3. **Rate-limit** → backoff del disparo; revisar el volumen por automotora en `audit_log`.
4. **Reproceso de las `error`:** las filas en `status = "error"` de `crm_opportunities` son
   **reintentables** (el efecto es idempotente: dedup de Contacto por cédula + de Oportunidad
   por `EXTERNAL_ID`). Reintentar el `POST` con el **mismo `NroSolicitud`** una vez restaurado
   el CRM → `created` o `duplicate`, **nunca** un Deal doble.

## Verificación

`POST /v1/opportunity-contact` de prueba (dato **sintético**, jamás PII real) → `201`/`200`;
la tasa de `502{crm}` vuelve a 0 en `audit_log`; no aparecen filas `error` nuevas.

## Dry-run

En **dev** (nunca prod): setear `ZOHO_REFRESH_TOKEN` (o el override `ZOHO_CRM_ACCESS_TOKEN`) a
un valor inválido → `POST` → esperar `502 UPSTREAM_ERROR` con `details.upstream = "crm"` y la
fila en `status = "error"`. Restaurar la credencial → redeploy → reintentar el **mismo**
`NroSolicitud` → `duplicate` (no duplica). ⚙️ Ejecutar en dev y registrar el resultado antes
de dar el runbook por probado.

## Prevención / follow-up

- Alerta sobre tasa de `502` en `endpoint = "opportunity-contact"`.
- Monitor de vigencia del refresh token del self-client (rotación anual — ver
  [OPERACIONES.md §6](../../OPERACIONES.md), OQ-P3 en [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) y
  CAT-Q5 en [PLAN-DE-DESARROLLO.md](../../PLAN-DE-DESARROLLO.md)).
- El consumidor debe implementar retry idempotente (mismo `NroSolicitud`) — dato de onboarding.
