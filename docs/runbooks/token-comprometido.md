# Runbook — Token de automotora comprometido (rotación de emergencia)

> Diagnóstico y auditoría desde `audit_log` (por `consumer_id` / `account_id`).
> Ver [OPERACIONES.md §6](../../OPERACIONES.md).

## Cuándo se dispara

Sospecha o confirmación de fuga de un token de API de una automotora: aparición en un log/
repo/canal externo, uso desde origen inesperado, o aviso del integrador. Señal indirecta:
ráfaga anómala de requests (o de `401`/`403`) para un `consumer_id` en `audit_log`.

## Impacto

Mientras el token siga vigente, el portador puede operar como esa automotora dentro de sus
scopes (`opportunities:create` / `reports:read` / `reports:pdf`), **siempre acotado a su
propia Cuenta** (la tenancy es server-side: el `accountId` sale del token, acceso cruzado →
`404`). El token plano **nunca** estuvo en disco — solo su `sha256` (`token_hash`) — así que
la exposición se limita al **portador del token**, no al sistema ni a otras automotoras.

## Diagnóstico

1. Identificar el token: el `consumer_id` / `account_id` afectado (nunca se busca por el token
   plano — no existe almacenado; se opera por su `consumer_id`).
2. Auditar el uso del token comprometido en `audit_log` filtrando por `consumer_id`/`account_id`:
   qué endpoints, qué volumen, desde cuándo, `outcome`/`http_status`.
3. Evaluar si hubo altas/consultas ilegítimas (revisar `crm_opportunities` recientes de esa
   Cuenta, si aplica).

## Resolución (rotación SIN downtime)

1. **`revoke()` inmediato** del token sospechoso → setea `revoked_at` en `api_tokens`. El
   `authMiddleware` rechaza tokens con `revoked_at` (o `expires_at` vencido) → `401 UNAUTHENTICATED`.
2. **Emitir un token nuevo**: `generateToken()` (base64url, ≥256 bits) → persistir solo
   `hashToken()` (sha256) en `api_tokens(token_hash, consumer_id, account_id, scopes, expires_at)`
   con los mismos scopes. Entregar el token plano al integrador **una sola vez** (nunca por un
   canal que lo persista).
3. **Confirmar el corte**: el token viejo → `401`; el nuevo → `2xx`.
4. **Registrar el incidente** (qué pasó, cuándo, alcance del uso auditado, acción). Escalamiento
   N2 si hubo altas ilegítimas.

> Orden importa: en una rotación **programada** (no comprometida) se crea el nuevo y se
> confirma tráfico **antes** de revocar el viejo (sin downtime). En una **emergencia** se
> **revoca primero** (cortar la exposición) y luego se emite el nuevo.

## Verificación

- `GET /v1/health` → `200` (servicio intacto).
- Request con el token **viejo** → `401 UNAUTHENTICATED`.
- Request con el token **nuevo** (dato sintético) → `2xx`.
- `audit_log`: el `consumer_id` deja de registrar uso del token comprometido.

## Dry-run

⚙️ En **dev** (DataStore real): sembrar un `api_tokens` de prueba → `revoke()` → confirmar que
el mismo token da `401` y que un token nuevo del mismo `consumer_id` da `2xx`. En **local**
(memory) el token `test-token` está sembrado en el contenedor y no hay endpoint admin de
revocación → la rotación se ensaya en dev, no en local. Registrar el resultado.

## Prevención / follow-up

- Rotación programada de tokens ≤ 90 días ([OPERACIONES.md §6](../../OPERACIONES.md)).
- Nunca loguear ni persistir el token plano (solo el hash) — invariante ya en código
  (`hashToken`, `middleware/auth.ts`).
- Entregar tokens por canal efímero; documentarlo en onboarding.
