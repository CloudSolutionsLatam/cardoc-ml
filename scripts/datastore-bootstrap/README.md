# Bootstrap del DataStore (entorno ML)

Catalyst **no** crea tablas por API/SDK — solo desde la consola. Estos CSV aceleran el paso:
los **headers definen las columnas** al importar, y dos traen ya la **fila de seed**.

## Pasos (Catalyst Console → proyecto ML → Development → Data Store)

1. **Import (CSV) → crear tabla** con cada archivo, respetando el **nombre EXACTO** de tabla:
   | CSV | Tabla | Trae seed |
   |-----|-------|-----------|
   | `api_tokens.csv` | `api_tokens` | ✅ 1 fila (token de dev) |
   | `consumers.csv` | `consumers` | ✅ 1 fila (Cuenta ML) |
   | `crm_opportunities.csv` | `crm_opportunities` | — (vacía) |
   | `audit_log.csv` | `audit_log` | — (vacía) |
   | `consumer_caps.csv` | `consumer_caps` | — (vacía) |

   > Si tu consola **no** crea la tabla desde el import: creá las 5 tablas a mano con esas
   > columnas (snake_case) e importá los 2 CSV con seed a las tablas ya creadas.

2. **Tipos de columna:** todo **texto/Varchar**, EXCEPTO enteros en:
   `audit_log.http_status`, `audit_log.latency_ms`, `consumer_caps.limit_hour/limit_day/limit_week`.
   (Los ids de Zoho —account_id, etc.— van como **texto**, no número.)

3. **Constraints A MANO** (la parte que no se puede saltear):
   - 🔴 `crm_opportunities`: **UNIQUE(account_id, idempotency_key)** — sin esto la idempotencia falla en silencio.
   - `api_tokens`: UNIQUE(token_hash)
   - `consumers`: UNIQUE(consumer_id), UNIQUE(crm_account_id)
   - `consumer_caps`: UNIQUE(consumer_id, endpoint) (recomendado)

4. **Env vars** (Configuration → Environment Variables): `CARDOC_PERSISTENCE=datastore`,
   `CARDOC_CRM_MODE=zoho`, `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`.

El seed mapea `X-Api-Key: test-token` (hash sha256) → Cuenta ML `6687138000031320073` con los 3 scopes.
Detalle del esquema: `docs/playbooks/datastore-esquema.md`.
