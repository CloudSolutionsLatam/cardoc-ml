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

2. **Columnas y tipos EXACTOS** (tipo Catalyst + longitud sugerida para `Var Char`):

   | Tabla | Columna | Tipo | Long. | UNIQUE/índice |
   |---|---|---|---|---|
   | `api_tokens` | `token_hash` | Var Char | 64 | **UNIQUE** |
   | | `consumer_id` | Var Char | 100 | índice |
   | | `account_id` | Var Char | 50 | |
   | | `scopes` | Var Char | 255 | |
   | | `expires_at` | Var Char | 40 | |
   | | `last_used_at` | Var Char | 40 | |
   | | `revoked_at` | Var Char | 40 | |
   | `consumers` | `consumer_id` | Var Char | 100 | **UNIQUE** |
   | | `crm_account_id` | Var Char | 50 | **UNIQUE** |
   | | `name` | Var Char | 255 | |
   | | `status` | Var Char | 20 | |
   | `crm_opportunities` | `account_id` | Var Char | 50 | 🔴 **UNIQUE(account_id, idempotency_key)** |
   | | `idempotency_key` | Var Char | 255 | (parte del UNIQUE) |
   | | `payload_fingerprint` | Var Char | 64 | |
   | | `contact_id` | Var Char | 50 | |
   | | `opportunity_id` | Var Char | 50 | |
   | | `status` | Var Char | 20 | |
   | | `correlation_id` | Var Char | 64 | |
   | | `created_at` | Var Char | 40 | |
   | | `updated_at` | Var Char | 40 | |
   | `audit_log` | `timestamp` | Var Char | 40 | |
   | | `correlation_id` | Var Char | 64 | índice |
   | | `consumer_id` | Var Char | 100 | |
   | | `account_id` | Var Char | 50 | |
   | | `endpoint` | Var Char | 50 | |
   | | `outcome` | Var Char | 20 | |
   | | `http_status` | **Int** | — | |
   | | `latency_ms` | **Int** | — | |
   | | `error_code` | Var Char | 50 | |
   | `consumer_caps` | `consumer_id` | Var Char | 100 | UNIQUE(consumer_id, endpoint) |
   | | `endpoint` | Var Char | 50 | (parte del UNIQUE) |
   | | `limit_hour` | **Int** | — | |
   | | `limit_day` | **Int** | — | |
   | | `limit_week` | **Int** | — | |

   > **NO usar `BigInt`** para los ids de Zoho (`account_id`, `crm_account_id`, `contact_id`,
   > `opportunity_id`): son de 19 dígitos y JS perdería precisión → van como **`Var Char`** (el
   > código los trata como string). **NO usar `DateTime`** en las fechas: el código guarda/lee
   > strings ISO 8601 → **`Var Char`**.

3. **Constraints A MANO** (la parte que no se puede saltear):
   - 🔴 `crm_opportunities`: **UNIQUE(account_id, idempotency_key)** — sin esto la idempotencia falla en silencio.
   - `api_tokens`: UNIQUE(token_hash)
   - `consumers`: UNIQUE(consumer_id), UNIQUE(crm_account_id)
   - `consumer_caps`: UNIQUE(consumer_id, endpoint) (recomendado)

4. **Env vars** (Configuration → Environment Variables): `CARDOC_PERSISTENCE=datastore`,
   `CARDOC_CRM_MODE=zoho`, `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`.

El seed mapea `X-Api-Key: test-token` (hash sha256) → Cuenta ML `6687138000031320073` con los 3 scopes.
Detalle del esquema: `docs/playbooks/datastore-esquema.md`.
