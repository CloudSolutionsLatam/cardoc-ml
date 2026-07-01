# Runbook — Cap mal configurado (automotora legítima bloqueada)

> Diagnóstico desde el `correlationId` (`X-Correlation-Id`) → `audit_log`.
> Ver [OPERACIONES.md §5](../../OPERACIONES.md).

## Cuándo se dispara

Una automotora legítima recibe **`429 CAP_EXCEEDED`** con tráfico normal (cap demasiado bajo
para su volumen real). Detección: pico de `429` en `audit_log` para un `consumer_id`/`account_id`
concreto, o reporte de la automotora. La respuesta trae `Retry-After` (segundos) y
`details = { window, limit, retryAfterSeconds }`; además los headers `X-Cap-Window`,
`X-Cap-Limit`, `X-Cap-Remaining`.

## Impacto

Requests de esa automotora rechazados con `429` hasta que se libere la ventana o se suba el
cap. El cap se evalúa **después** de auth+scope (un `401`/`403` **no** consume cap). Afecta a
un consumidor puntual, no al servicio entero.

## Diagnóstico

1. `correlationId` del `429` → `audit_log`: `consumer_id`, `endpoint`, `http_status = 429`,
   `error_code = "CAP_EXCEEDED"`.
2. Leer de la respuesta `details.window` (`hour`/`day`/`week`) y `details.limit`: qué ventana
   se topó y con qué límite.
3. Origen del límite:
   - Fila en `consumer_caps(consumer_id, endpoint, limit_hour, limit_day, limit_week)` → cap
     **propio** del consumidor.
   - Sin fila → **defaults de env** `CARDOC_CAP_DEFAULT_HOUR/DAY/WEEK` (1000 / 10000 / 50000).
4. Comparar el volumen real (conteo por `account_id` en `audit_log`) contra el límite: ¿es un
   cap mal calibrado o un abuso/loop del cliente?

## Resolución

1. **Cap mal calibrado (automotora legítima):** subir el límite de la ventana afectada.
   - Con fila propia: actualizar `consumer_caps` (la columna de la ventana) en el DataStore.
   - Sin fila: crear la fila `consumer_caps` con límites acordes, **o** ajustar el default de
     env (`CARDOC_CAP_DEFAULT_*`) → redeploy (afecta a **todos** los consumidores sin fila propia).
   - El nuevo límite se lee **por request** (`CapRepository.getConfig`): subirlo por encima del
     conteo actual **desbloquea en el siguiente request** (no hay que esperar la ventana).
2. **Abuso / loop del cliente:** NO subir el cap. Contactar a la automotora; revisar retries
   mal implementados (p.ej. reintentos sin backoff sobre un `502`).
3. **Nota de plataforma:** los contadores son **in-memory por contenedor caliente**
   (`buckets` en `cap.ts`) — **no distribuidos**. Un redeploy o el reciclado del contenedor
   **resetea** los contadores. El cap global atómico sobre Catalyst Cache es un gate pendiente
   (CAT-Q2, [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md)).

## Verificación

Un request de la automotora afectada → `2xx`; header `X-Cap-Remaining` positivo y coherente
con el nuevo límite; el pico de `429` cede en `audit_log`.

## Dry-run

Local, forzando un cap de 1/hora y agotándolo (probado — ver output real abajo):

Levantar el app con `CARDOC_CAP_DEFAULT_HOUR=1` (setear la env **antes** de cargar el app:
`cap.ts` la lee al evaluar el módulo) y hacer dos `GET /v1/informes` con `X-Api-Key: test-token`.

Resultado **observado** (dry-run local, 2026-07-01):

```
req#1: status=200  X-Cap-Window=hour  X-Cap-Limit=1  X-Cap-Remaining=0  Retry-After=null
req#2: status=429  X-Cap-Window=hour  X-Cap-Limit=1  X-Cap-Remaining=0  Retry-After=3600
       error.code=CAP_EXCEEDED  details={"window":"hour","limit":1,"retryAfterSeconds":3600}
```

Subir el límite (o reciclar el contenedor, que resetea los buckets in-memory) restablece el `2xx`.

## Prevención / follow-up

- Calibrar los caps de onboarding al volumen real esperado de cada automotora
  ([OPERACIONES.md §3](../../OPERACIONES.md), paso 6).
- Alerta sobre pico de `429` por `consumer_id`.
- Cap distribuido atómico sobre Catalyst Cache (CAT-Q2) — quita el reset por redeploy.
