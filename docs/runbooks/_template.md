# Runbook — <título del incidente>

> Plantilla. Copiá este archivo a `docs/runbooks/<slug>.md` y completá. Un runbook se
> escribe **antes** de necesitarlo y se prueba con un dry-run — un runbook sin dry-run
> es una expresión de deseo.

## Cuándo se dispara

Síntoma observable + cómo se detecta (alerta, health check, reporte del consumidor).
Umbral concreto si aplica.

## Impacto

Qué se rompe y para quién (¿qué automotora? ¿qué endpoint? ¿bloqueado o degradado?).

## Diagnóstico

Pasos para confirmar la causa. Qué mirar primero:
- `correlationId` del request afectado → reconstruir la traza en `audit_log`.
- Logs de Catalyst (sin PII ni URLs internas — solo IDs y códigos).
- Estado del upstream (CRM / Creator / WorkDrive) según el `UPSTREAM_ERROR`.

## Resolución

Pasos numerados y accionables. Comandos exactos. Quién puede ejecutarlos (rol).

## Verificación

Cómo confirmar que se resolvió (smoke al endpoint, métrica vuelta a verde).

## Prevención / follow-up

Causa raíz. Qué cambiar para que no se repita. Tickets abiertos.

---

**Runbooks escritos** (ver [../README.md](../README.md) §Runbooks y
[../../OPERACIONES.md](../../OPERACIONES.md) §5): `outage-crm` · `outage-creator-workdrive` ·
`cap-mal-configurado` · `idempotencia-conflicto` · `token-comprometido` · `pdf-no-disponible`.
**Pendiente:** `restore-datastore` (bloqueado por el mecanismo de backup/export, OQ-P7).
