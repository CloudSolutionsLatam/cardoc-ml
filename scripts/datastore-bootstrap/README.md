# Bootstrap del DataStore (entorno ML)

Catalyst **no** crea tablas por API/SDK — solo desde la consola. Estos CSV aceleran el paso:
los **headers definen las columnas** al importar. El **seed** de `api_tokens` NO va por CSV —
se carga a mano con **Add Row** (ver paso 4); el campo `scopes` es JSON con comas/comillas que el
importador CSV rompe.

## Pasos (Catalyst Console → proyecto ML → Development → Data Store)

1. **Import (CSV) → crear tabla** con cada archivo, respetando el **nombre EXACTO** de tabla.
   El import se usa SOLO para crear las columnas; **todas las tablas quedan vacías** (el seed va aparte, paso 5):
   | CSV | Tabla |
   |-----|-------|
   | `api_tokens.csv` | `api_tokens` |
   | `consumers.csv` | `consumers` |
   | `crm_opportunities.csv` | `crm_opportunities` |
   | `audit_log.csv` | `audit_log` |
   | `consumer_caps.csv` | `consumer_caps` |

   > Si tu consola **no** crea la tabla desde el import: creá las 5 tablas a mano con esas
   > columnas (snake_case).

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
   | `crm_opportunities` | `account_id` | Var Char | 50 | (lectura de tenancy, no índice) |
   | | `idempotency_key` | Var Char | 255 | 🔴 **UNIQUE** |
   | | `payload_fingerprint` | Var Char | 64 | |
   | | `contact_id` | Var Char | 50 | |
   | | `opportunity_id` | Var Char | 50 | |
   | | `status` | Var Char | 20 | |
   | | `correlation_id` | Var Char | 64 | |
   | | `created_at` | Var Char | 40 | |
   | | `updated_at` | Var Char | 40 | |
   | `audit_log` | `_timestamp` | Var Char | 40 | (`timestamp` es nombre RESERVADO en Catalyst) |
   | | `correlation_id` | Var Char | 64 | índice |
   | | `consumer_id` | Var Char | 100 | |
   | | `account_id` | Var Char | 50 | |
   | | `endpoint` | Var Char | 50 | |
   | | `outcome` | Var Char | 20 | |
   | | `http_status` | **Int** | — | |
   | | `latency_ms` | **Int** | — | |
   | | `error_code` | Var Char | 50 | |
   | `consumer_caps` | `consumer_id` | Var Char | 100 | índice |
   | | `endpoint` | Var Char | 50 | índice |
   | | `limit_hour` | **Int** | — | |
   | | `limit_day` | **Int** | — | |
   | | `limit_week` | **Int** | — | |

   > **NO usar `BigInt`** para los ids de Zoho (`account_id`, `crm_account_id`, `contact_id`,
   > `opportunity_id`): son de 19 dígitos y JS perdería precisión → van como **`Var Char`** (el
   > código los trata como string). **NO usar `DateTime`** en las fechas: el código guarda/lee
   > strings ISO 8601 → **`Var Char`**.
   >
   > **Tampoco `Foreign Key`:** el FK de Catalyst referencia el `ROWID` (id de sistema) de la
   > tabla padre, pero el código enlaza por **clave de negocio string** (`consumer_id='consumer_ml'`,
   > `account_id`=id de Cuenta Zoho) vía ZCQL `WHERE consumer_id = '...'`, no por ROWID. Además
   > `account_id` apunta a una Cuenta de **Zoho** (externa), no a una tabla local. Por eso `Var Char`.

3. **Constraints A MANO** (la parte que no se puede saltear — Catalyst solo permite UNIQUE de **una** columna por UI):
   - 🔴 `crm_opportunities`: **UNIQUE(idempotency_key)** — sin esto la idempotencia (Capa 1) falla en silencio.
     El filtrado por `account_id` + `idempotency_key` en el código es lectura defensiva de tenancy, no el constraint del índice.
   - `api_tokens`: UNIQUE(token_hash)
   - `consumers`: UNIQUE(consumer_id), UNIQUE(crm_account_id)

4. **Seed OBLIGATORIO de `api_tokens` (Add Row, NO CSV)** — sin esta fila el alta devuelve 401
   "token inválido". En la consola: tabla `api_tokens` → **Add Row** con:
   - `token_hash` = `4c5dc9b7...031e` (sha256 de `"test-token"`)
   - `consumer_id` = `consumer_ml`
   - `account_id` = `6687138000031320073`
   - `scopes` = `["opportunities:create","reports:read","reports:pdf"]`
   - resto de columnas vacías.

   > `consumers` y `consumer_caps` **no** hacen falta para el alta (el cap cae a defaults; `consumers`
   > lo usa el webhook interno E-07).

5. **Env vars** (Configuration → Environment Variables): `CARDOC_PERSISTENCE=datastore`,
   `CARDOC_CRM_MODE=zoho`, `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`.

La fila de `api_tokens` (sembrada por Add Row) mapea `X-Api-Key: test-token` (hash sha256) → Cuenta ML `6687138000031320073` con los 3 scopes.
Detalle del esquema: `docs/playbooks/datastore-esquema.md`.
