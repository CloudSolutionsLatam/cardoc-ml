---
title: Contratos de API — cardoc-ml
status: borrador-para-validacion (entregable E-06 — referencia para el equipo de integración)
last_reviewed: 2026-07-02
---

# Contratos de API — cardoc-ml

Referencia de integración de la API pública `/v1/*`. Anclada al código en disco:
`apps/catalyst/functions/api/src/routes/*.ts`, `middleware/{auth,cap,errors,audit}.ts`,
`apps/catalyst/functions/api/src/app.ts` y `packages/domain/src/schemas.ts`.

Documentos relacionados: [README](README.md) · [ARQUITECTURA](ARQUITECTURA.md) ·
[ATRIBUTOS-DE-CALIDAD](ATRIBUTOS-DE-CALIDAD.md) · [OPERACIONES](OPERACIONES.md) ·
[PLAN-DE-DESARROLLO](PLAN-DE-DESARROLLO.md) · [Índice docs](docs/README.md) ·
[Esquema DataStore](docs/playbooks/datastore-esquema.md) ·
[Secretos y Connections](docs/playbooks/secretos-y-connections.md).

> **Regla rectora (tenancy).** El `accountId` se resuelve **siempre del token**, nunca del
> payload ni del query. Ver `middleware/auth.ts` (`authMiddleware` setea `req.accountId` desde
> la fila `api_tokens`). El consumidor **no puede** elegir Cuenta.

---

## 1. Convenciones transversales

### 1.1 Base y versionado

- Prefijo único: `/v1`. No hay otro prefijo montado (`app.ts`).
- `Content-Type: application/json` en requests con body. El parser es `express.json()` (primer middleware).
- En local/dev el servicio se levanta como función Catalyst Advanced I/O; los ejemplos `curl` de
  esta guía asumen `http://localhost:3000` — **ajustá host/puerto al de tu serve local**
  (⚠️ verificar el puerto exacto que expone `catalyst serve` en docs oficiales/consola).

### 1.2 Headers

| Header | Dirección | Obligatorio | Semántica |
|---|---|---|---|
| `X-Api-Key: <token>` | request | Sí (excepto `/v1/health`) | Token opaco. Se compara solo por **hash** (`hashToken`, `auth.ts`); el token plano nunca se persiste ni se loguea. |
| `X-Idempotency-Key` | request (opcional) | No | **Solo** en `POST /v1/opportunity-contact`. Si viene, activa la idempotencia de **Capa 1** (DataStore de Catalyst): replay → `200 duplicate`, misma clave + payload distinto → `409`. Sin él, deduplica el CRM (Capa 2). Ver §8. |
| `X-Correlation-Id` | request (opcional) / response (siempre) | No | Si llega y es UUID válido se propaga; si no, se regenera (`correlationMiddleware`). Siempre vuelve en la respuesta y aparece en el sobre de error y en `audit_log`. |
| `X-Cap-Window` / `X-Cap-Limit` / `X-Cap-Remaining` | response | — | Estado del cap más ajustado de las 3 ventanas (`cap.ts`). Ver §7. |
| `Retry-After` | response (solo 429) | — | Segundos hasta el reset de la ventana excedida (`cap.ts`). |

> `X-Correlation-Id` se valida contra el patrón UUID v-agnóstico
> `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (`auth.ts`). Cualquier valor
> que no matchee se descarta y se regenera silenciosamente — no es un error.

### 1.3 Pipeline de middlewares (orden fijo)

Definido en `app.ts`. Globales primero; `requireScope` y `cap` se montan **por ruta** (cada
endpoint tiene scope y cap distintos):

```
express.json
  → correlationMiddleware      (valida/regenera X-Correlation-Id; setea startMs + header)
  → auditOnFinish              (global; 1 registro on-finish, ver §8)
  → [por ruta] attachContainer (compone repos + adapters)
  → authMiddleware             (X-Api-Key → consumer/account/scopes)
  → requireScope(scope)        (403 si falta el scope)
  → cap(endpoint)              (429 si excede; setea X-Cap-*)
  → handler
  → errorMiddleware            (ÚLTIMO; traduce TODO al sobre único)
```

Orden de fallos importante: **auth (401) y scope (403) corren antes que cap**, por diseño —
un 401/403 **no consume cap** (`cap.ts`, comentario AC-07).

### 1.4 Autenticación

`authMiddleware` (`auth.ts`):

1. Exige header `X-Api-Key: <token>`. Sin él → `401 UNAUTHENTICATED`.
2. Resuelve `hashToken(token)` contra `api_tokens` (`tokens.resolveByHash`).
3. Rechaza si la fila no existe, está revocada (`revoked_at`) o vencida (`expires_at < now`) → `401 UNAUTHENTICATED`.
4. En éxito, cuelga del request: `consumerId`, `accountId`, `scopes[]`; y actualiza `last_used_at`.

Scopes existentes (`packages/domain/src/types.ts`): `opportunities:create`, `reports:read`,
`reports:pdf`. Un token puede tener varios (el token de dev tiene todos, ver §5).

---

## 2. `POST /v1/opportunity-contact`

Crea o reutiliza un Contacto (dedup por **cédula**, `NroCedula`) y crea una Oportunidad con
estado fijo `Nueva Solicitud`. **Idempotente en 2 capas** (header `X-Idempotency-Key` opcional →
Catalyst; siempre → CRM por `EXTERNAL_ID`; ver §8). Es el payload que manda **ML/AutoCheck**.

| | |
|---|---|
| **Método / path** | `POST /v1/opportunity-contact` |
| **Scope requerido** | `opportunities:create` |
| **Headers** | `X-Api-Key: …` (oblig.) · `Content-Type: application/json` · `X-Idempotency-Key` (opc., activa Capa 1) · `X-Correlation-Id` (opc.) |
| **Cap (endpoint lógico)** | `opportunity-contact` |
| **Handler** | `routes/opportunity-contact.ts` · use-case `createOpportunityContact` |

### 2.1 Request body

Validado por `opportunityContactSchema` (`schemas.ts`), **`.strict()`** — una clave extra de
nivel raíz hace fallar la validación → `400 VALIDATION_ERROR`.

```jsonc
{
  "NroCedula":            45321890,                // long, requerido — LLAVE de dedup del Contacto
  "NroSolicitud":         908812,                  // long, requerido, único — External ID + idempotencia
  "Nombres":              "Juan Carlos",           // string ≤100, requerido
  "Apellidos":            "Pérez Rodríguez",       // string ≤100, requerido
  "CelularCliente":       "099123456",             // string ≤30, opcional
  "Tenant":               "Empresa_Alfa",          // string ≤100, opcional — informativo (la Cuenta es "ML")
  "Sucursal":             "Centro Montevideo",     // string ≤100, opcional
  "DepartamentoSucursal": "Montevideo",            // string ≤100, opcional
  "CiudadSucursal":       "Montevideo",            // string ≤100, opcional
  "DireccionSucursal":    "Av. 18 de Julio 1234",  // string ≤200, opcional
  "MarcaVehiculo":        "Chevrolet",             // string ≤100, opcional
  "ModeloVehiculo":       "Onix",                  // string ≤100, opcional
  "AnioVehiculo":         2022,                    // int, opcional
  "MatriculaVehiculo":    "SBA1234"                // string ≤30, opcional
}
```

Reglas de validación derivadas del schema/dominio:

- `NroCedula`, `NroSolicitud`, `Nombres` y `Apellidos` son **requeridos**; el resto opcional.
- `NroCedula` es la **llave de deduplicación** del Contacto (ML no manda email).
- `NroSolicitud` (único) es la **clave de idempotencia** y el **External ID** de la Oportunidad.
- El estado **no se acepta** en el body: se fija server-side a `FIXED_OPPORTUNITY_STAGE = "Nueva Solicitud"`.
- `.strict()`: una clave de nivel raíz fuera de la lista hace fallar la validación → `400`.

### 2.2 Responses de éxito

El handler traduce el `outcome` del use-case a HTTP. La semántica de idempotencia produce
**tres** estados de éxito distintos (no solo 201/200) — ver §6.

**`201 Created`** — primera ejecución de la clave (`status: "created"`):

```json
{
  "status": "created",
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "nroSolicitud": 908812,
  "contact":     { "id": "ct_001", "reused": false },
  "opportunity": { "id": "op_001", "stage": "Nueva Solicitud" }
}
```

`contact.reused = true` cuando el Contacto ya existía y se reutilizó por cédula (`NroCedula`).

**`200 OK`** — replay exacto (mismo `NroSolicitud` + mismo payload, ya creado; `status: "duplicate"`):

```json
{
  "status": "duplicate",
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "nroSolicitud": 908812,
  "contact":     { "id": "ct_001" },
  "opportunity": { "id": "op_001", "stage": "Nueva Solicitud" }
}
```

**`202 Accepted`** — la clave está en proceso por otro flujo concurrente (`status: "in_progress"`):

```json
{
  "status": "in_progress",
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "nroSolicitud": 908812
}
```

### 2.3 Errores posibles

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body inválido / falta un campo requerido / clave extra (`details.fields`). |
| 401 | `UNAUTHENTICATED` | Sin X-Api-Key o token inválido/revocado/vencido. |
| 403 | `FORBIDDEN_SCOPE` | El token no tiene `opportunities:create` (`details.required`). |
| 409 | `IDEMPOTENCY_CONFLICT` | Mismo `X-Idempotency-Key` con payload distinto (Capa 1; sin header no aplica). Ver §8. |
| 429 | `CAP_EXCEEDED` | Cap del endpoint excedido. `Retry-After` + `details.{window,limit,retryAfterSeconds}`. |
| 502 | `UPSTREAM_ERROR` | Falla creando en CRM (`details.upstream = "crm"`). El row queda en `status=error`. |
| 500 | `INTERNAL_ERROR` | Container/cuenta no resueltos u otro fallo no clasificado. |

### 2.4 curl (token de dev)

```bash
curl -i -X POST http://localhost:3030/v1/opportunity-contact \
  -H "X-Api-Key: test-token" \
  -H "X-Idempotency-Key: order-2026-06-25-0001" \
  -H "X-Correlation-Id: f47ac10b-58cc-4372-a567-0e02b2c3d479" \
  -H "Content-Type: application/json" \
  -d '{
    "NroCedula": 45321890, "NroSolicitud": 908812,
    "Nombres": "Juan Carlos", "Apellidos": "Pérez Rodríguez", "CelularCliente": "099123456",
    "MarcaVehiculo": "Chevrolet", "ModeloVehiculo": "Onix", "AnioVehiculo": 2022, "MatriculaVehiculo": "SBA1234"
  }'
```

`X-Idempotency-Key` es **opcional** (activa la Capa 1). Con él: reintento exacto → `200 duplicate`;
misma clave + body distinto → `409 IDEMPOTENCY_CONFLICT`. **Sin** el header deduplica el CRM
(Capa 2 por `EXTERNAL_ID`): el repetido → `200 duplicate` (sin detección de body-distinto). Ver §8.

---

## 3. `GET /v1/informes`

Lista los Informes de Revisión de la **Cuenta autenticada**, con filtros controlados y cursor.

> ⛔ **Descartado / no se implementa contra Creator ([ADR-0015](decisions/README.md#adr-0015)).**
> ML es *push*: escucha los cambios vía la notificación OUTBOUND (E-07), no hace *pull* de un
> listado. La ruta sigue en modo **mock** (valida el pipeline), pero NO hay adapter Creator de
> listado. El PDF (§4) **sí** queda en alcance.

| | |
|---|---|
| **Método / path** | `GET /v1/informes` |
| **Scope requerido** | `reports:read` |
| **Headers** | `X-Api-Key: …` (oblig.) · `X-Correlation-Id` (opc.) |
| **Cap (endpoint lógico)** | `informes-list` |
| **Handler** | `routes/informes.ts` (`listInformesHandler`) · use-case `listInformes` |

### 3.1 Query params (allowlist)

Validado por `listInformesQuerySchema` (`schemas.ts`), **`.strict()`** — cualquier parámetro
fuera de la lista hace fallar la validación → **`422 UNPROCESSABLE`**. Esto refuerza la tenancy:
el consumidor **no puede** colar un filtro de Cuenta.

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `estado` | enum `en_progreso` \| `completado` \| `cerrado` | — | `estadoInformeSchema`. |
| `desde` | string | — | Fecha límite inferior (formato no validado en el schema actual). |
| `hasta` | string | — | Fecha límite superior. |
| `matricula` | string | — | Filtro por matrícula. |
| `cursor` | string | — | Cursor **opaco** de paginación (no expone offset ni IDs internos). |
| `limit` | int positivo, máx **100** | **20** | `z.coerce.number()...max(100).default(20)`. |

### 3.2 Response de éxito — `200 OK`

```json
{
  "data": [
    {
      "id": "acc_dev-INF-001",
      "estado": "completado",
      "matricula": "ABC1234",
      "vehiculo": "VW Amarok 2018",
      "cliente": "Cliente Demo",
      "fecha": "2026-06-20",
      "pdfDisponible": true
    }
  ],
  "page": { "limit": 20, "nextCursor": null, "hasMore": false },
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

El handler hace `{ ...page, correlationId }`: la página (`data` + `page`) viene del use-case y se
le agrega `correlationId`. La forma de `InformeRevision` (`types.ts`) está marcada **PLACEHOLDER**
hasta confirmar el mapeo contra los forms `Informes`/`Analisis` de Zoho Creator (ver §9). El
ejemplo anterior refleja la salida del `MockReportsSource` (modo dev).

### 3.3 Errores posibles

| HTTP | code | Cuándo |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Sin X-Api-Key o token inválido. |
| 403 | `FORBIDDEN_SCOPE` | Token sin `reports:read`. |
| 422 | `UNPROCESSABLE` | Query param fuera de la allowlist o tipo inválido (`details.fields`). |
| 429 | `CAP_EXCEEDED` | Cap `informes-list` excedido. |
| 502 | `UPSTREAM_ERROR` | Falla del adapter de Creator (`details.upstream = "creator"`). |
| 500 | `INTERNAL_ERROR` | Container/cuenta no resueltos. |

### 3.4 curl (token de dev)

```bash
curl -i "http://localhost:3000/v1/informes?estado=completado&limit=10" \
  -H "X-Api-Key: test-token"
```

Forzar 422 (param fuera de la allowlist, p.ej. intentar filtrar por Cuenta):

```bash
curl -i "http://localhost:3000/v1/informes?accountId=otra-cuenta" \
  -H "X-Api-Key: test-token"
# → 422 UNPROCESSABLE
```

---

## 4. `GET /v1/informes/:id/pdf`

Stream autenticado del PDF del informe. Sin URL pública, sin redirect, sin exponer fileId/ruta
interna de WorkDrive.

| | |
|---|---|
| **Método / path** | `GET /v1/informes/:id/pdf` |
| **Scope requerido** | `reports:pdf` |
| **Headers** | `X-Api-Key: …` (oblig.) · `X-Correlation-Id` (opc.) |
| **Cap (endpoint lógico)** | `informes-pdf` |
| **Handler** | `routes/informes.ts` (`streamPdfHandler`) · use-case `streamReportPdf` |

### 4.1 Request

- Path param `:id` — id del informe.
- `openPdf(accountId, id)` valida **existencia + tenancy ANTES** de devolver el stream: si el
  informe no existe o **es de otra Cuenta**, lanza `ReportNotFoundError` → **`404 NOT_FOUND`**
  (cross-tenant es 404, no 403; ver §6/§9 decisiones).

### 4.2 Response de éxito — `200 OK` (binario)

El handler setea, **antes del primer byte**:

```
Content-Type: application/pdf            (de pdf.contentType)
Content-Disposition: attachment; filename="NombreCliente_IDInterno_Fecha.pdf"
Cache-Control: no-store
```

…y luego `pdf.stream.pipe(res)`. El body es el PDF binario.

> **Nomenclatura del archivo** (decisión §10 D4, mail Cardoc 2026-07-02): `NombreCliente_IDInterno_Fecha.pdf`
> con fecha ISO 8601 (`AAAA-MM-DD`); `buildReportFilename` sanea acentos/espacios/caracteres inseguros.
> `IDInterno` = `reportCode` del detalle ("#R-12345" → `R-12345`); si el negocio requiere el `INFREV-xxxx`
> del CRM, el detalle debe exponer ese `number` (deuda abierta).

Manejo de error a mitad de stream (`streamPdfHandler`): si el `Readable` falla **antes** de enviar
bytes → se traduce a `502 UPSTREAM_ERROR` (`details.upstream = "workdrive"`); si **ya** se enviaron
bytes → se destruye la conexión (no se puede reescribir el status).

### 4.3 Errores posibles

| HTTP | code | Cuándo |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Sin X-Api-Key o token inválido. |
| 403 | `FORBIDDEN_SCOPE` | Token sin `reports:pdf`. |
| 404 | `NOT_FOUND` | Informe inexistente **o de otra Cuenta** (`ReportNotFoundError`). |
| 404 | `PDF_NOT_AVAILABLE` | El informe existe pero su PDF no está disponible ni se pudo generar (`PdfNotAvailableError`, `details.informeId`). |
| 429 | `CAP_EXCEEDED` | Cap `informes-pdf` excedido. |
| 502 | `UPSTREAM_ERROR` | Falla al transmitir / upstream Creator/WorkDrive. |
| 500 | `INTERNAL_ERROR` | Container/cuenta no resueltos. |

### 4.4 curl (token de dev)

```bash
curl -i -L "http://localhost:3000/v1/informes/acc_dev-INF-001/pdf" \
  -H "X-Api-Key: test-token" \
  -o informe.pdf
```

> **As-built (E-03):** `ZohoCreatorReportsSource.openPdf` **está implementado** — trae el detalle de
> Creator (Custom API REST server-to-server), lo transforma y **genera el PDF con pdf-lib on-the-fly**
> (probado end-to-end). Lo que sigue **pendiente** es la caché/write-back a `Analisis.pdf_url` (hoy se
> genera en cada request; ver OQ-N8) y el listado (`listByAccount`/`findById` siguen `NotImplementedError`,
> ADR-0015). `PDF_NOT_AVAILABLE` es alcanzable recién al cablear la resolución perezosa.

---

## 4bis. `GET /v1/informes/solicitud/:nroSolicitud/pdf`

Variante que recibe el **N.º de Solicitud externo** en lugar del id interno de Creator (decisión §10 D3b,
mail Cardoc 2026-07-02). Resuelve el informe vía CRM y reusa el mismo stream que §4.

| | |
|---|---|
| **Método / path** | `GET /v1/informes/solicitud/:nroSolicitud/pdf` |
| **Scope requerido** | `reports:pdf` |
| **Cap (endpoint lógico)** | `informes-pdf` (mismo que §4) |
| **Handler** | `routes/informes.ts` (`streamPdfBySolicitudHandler`) · use-case `streamReportPdfByNroSolicitud` |

**Resolución:** busca en el módulo CRM `Informes_Revision` por `Nro_Solicitud_Externo:equals:<nroSolicitud>`,
lee el campo `Creator_Analisis_ID` (id del Análisis en Creator) y delega en `openPdf(accountId, analisisId)`
(mismos headers/errores que §4). Si el N.º de Solicitud no resuelve → **`404 NOT_FOUND`** (no divulgación).
El consumidor **nunca ve el id interno de Creator**. 4 segmentos de path → no colisiona con `:id/pdf` (3).

```bash
curl -i "http://localhost:3000/v1/informes/solicitud/1001/pdf" \
  -H "X-Api-Key: test-token" -o informe.pdf
```

---

## 5. `GET /v1/health`

Health check **abierto** (sin auth, sin scope, sin cap). Lo consume el monitoreo de disponibilidad.

| | |
|---|---|
| **Método / path** | `GET /v1/health` |
| **Scope** | — (montado directo en `app.ts`, fuera de la cadena `authed`) |
| **Headers** | ninguno requerido |

### 5.1 Response — `200 OK`

```json
{ "status": "ok", "service": "api" }
```

No tiene errores propios. **No se audita** (sin container → `auditOnFinish` no registra; ver §8).
`X-Correlation-Id` sí se setea en la respuesta (el `correlationMiddleware` es global).

### 5.2 curl

```bash
curl -i http://localhost:3000/v1/health
```

> **Token de dev (modo in-memory).** `CARDOC_PERSISTENCE` ≠ `datastore` siembra un consumidor/token
> de dev (`container.ts`): `X-Api-Key: test-token`, **todos los scopes**, consumidor `consumer_dev`,
> Cuenta `acc_dev`. Solo para local/dev — no existe en `datastore` mode.

---

## 6. Sobre de error único + catálogo de códigos

### 6.1 Sobre único

**Todo** error sale por `errorMiddleware` (`errors.ts`, último del app) con esta forma — sin
filtrar detalle interno, PII ni URLs/fileId del upstream:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "payload inválido",
    "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "details": { "fields": { "NroSolicitud": ["Required"], "Nombres": ["Required"] } }
  }
}
```

- `code` es **estable e independiente del HTTP status** (`ApiError.code`, tipo `ErrorCode`).
- `message` es legible pero **no** contiene PII ni rutas internas.
- `correlationId` puede ser `null` si el error ocurrió antes del `correlationMiddleware`
  (no esperable con el orden actual).
- `details` es **opcional**: solo aparece cuando el error lo aporta.

`errorMiddleware` también: si `res.headersSent` ya es true (p.ej. error a mitad de stream PDF),
delega a `next(err)` sin reescribir; marca `req.errorCode` para que la auditoría on-finish lo
registre; y loguea **solo** `correlationId + método + path + code` (nunca payload/PII/URL).

### 6.2 Catálogo completo (HTTP → code → cuándo)

`ErrorCode` está cerrado en `errors.ts`. Origen de cada código anclado al código:

| HTTP | code | Cuándo / origen |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body inválido / campo requerido faltante / clave extra en POST (`opportunity-contact.ts`). `details.fields`. |
| 401 | `UNAUTHENTICATED` | Sin X-Api-Key / token inválido/revocado/vencido (`auth.ts`). |
| 403 | `FORBIDDEN_SCOPE` | Token sin el scope requerido (`requireScope`, `auth.ts`). `details.required`. **Único** caso de 403. |
| 404 | `NOT_FOUND` | Recurso inexistente o **de otra Cuenta** (`ReportNotFoundError` → `errors.ts`). Cross-tenant = 404 por decisión (§9). |
| 404 | `PDF_NOT_AVAILABLE` | Informe existe pero sin PDF disponible/generable (`PdfNotAvailableError`). `details.informeId`. |
| 409 | `IDEMPOTENCY_CONFLICT` | Mismo `X-Idempotency-Key`, payload distinto (POST, Capa 1). |
| 422 | `UNPROCESSABLE` | Query de `GET /v1/informes` fuera de la allowlist o tipo inválido (`.strict()`). `details.fields`. |
| 429 | `CAP_EXCEEDED` | Cap de endpoint excedido (`cap.ts`). `details.{window,limit,retryAfterSeconds}` + headers `Retry-After`/`X-Cap-*`. |
| 502 | `UPSTREAM_ERROR` | Falla de CRM/Creator/WorkDrive (`UpstreamError` o POST fallido). `details.upstream` = etiqueta **opaca** (`crm`\|`creator`\|`workdrive`). |
| 500 | `INTERNAL_ERROR` | Container/cuenta no resueltos o error no clasificado (fallback de `toApiError`). |

> **Mapeo de errores de los puertos (`toApiError`, `errors.ts`).** `ApiError` pasa tal cual.
> `ReportNotFoundError` → 404 `NOT_FOUND`. `PdfNotAvailableError` → 404 `PDF_NOT_AVAILABLE`.
> `UpstreamError` → 502 `UPSTREAM_ERROR` (solo la etiqueta opaca, nunca la URL). Cualquier otra
> excepción → 500 `INTERNAL_ERROR`.

### 6.3 Ejemplos de sobre por código

```json
// 403
{ "error": { "code": "FORBIDDEN_SCOPE", "message": "scope insuficiente",
  "correlationId": "…", "details": { "required": "reports:pdf" } } }
```
```json
// 409
{ "error": { "code": "IDEMPOTENCY_CONFLICT",
  "message": "el mismo NroSolicitud llegó con un payload distinto",
  "correlationId": "…", "details": { "nroSolicitud": 908812 } } }
```
```json
// 429
{ "error": { "code": "CAP_EXCEEDED", "message": "límite de uso excedido",
  "correlationId": "…", "details": { "window": "hour", "limit": 1000, "retryAfterSeconds": 1837 } } }
```

---

## 7. Semántica de cap (rate limit)

`cap(endpoint)` (`cap.ts`) — por **consumidor × endpoint**, en **3 ventanas** simultáneas
(`hour` / `day` / `week`). Se evalúa **después** de auth+scope (un 401/403 no consume cap).

### 7.1 Límites

- Por consumidor vía `CapRepository.getConfig(consumerId, endpoint)` (tabla `consumer_caps`).
- Fallback a defaults de env: `CARDOC_CAP_DEFAULT_HOUR` (1000), `…_DAY` (10000), `…_WEEK` (50000).
- **Valores acordados con Cardoc (§10 D6, 2026-07-02)** para `consumer_ml`, por **hora**: `opportunity-contact`=**60**,
  `informes-list`=**120**, `informes-pdf`=**100** (día/semana quedan en defaults como guardrail). Sembrado con
  `scripts/seed-caps.mjs` → `scripts/datastore-bootstrap/consumer_caps.csv` (cargar filas en consola con Add Row).
- Una ventana con límite `null` se **omite** (sin tope).

### 7.2 Headers de estado

En cada respuesta (haya o no exceso) se reporta la ventana **más ajustada** (menor `remaining`):

| Header | Valor |
|---|---|
| `X-Cap-Window` | `hour` \| `day` \| `week` (la más ajustada). |
| `X-Cap-Limit` | límite de esa ventana. |
| `X-Cap-Remaining` | restante (nunca negativo: `max(0, remaining)`). |

### 7.3 Exceso → `429`

Si alguna ventana supera su límite: se setea `Retry-After` (segundos al reset = `ceil((resetAt - now)/1000)`,
tomando el reset **más cercano** si excede más de una ventana) y se devuelve `429 CAP_EXCEEDED`
con `details.{window, limit, retryAfterSeconds}`.

> **⚠️ Gate de plataforma.** Los contadores hoy son **in-memory por contenedor caliente**
> (`Map` en `cap.ts`). Para un cap distribuido real el blueprint pide **Catalyst Cache** (TTL
> nativo + increment atómico). La **atomicidad del increment** y la API exacta de Cache están
> **⚠️ por verificar (docs oficiales/consola)**. Ver [ATRIBUTOS-DE-CALIDAD](ATRIBUTOS-DE-CALIDAD.md)
> y la open question de Cache (§9).

---

## 8. Semántica de idempotencia (`POST /v1/opportunity-contact`)

Idempotencia en **dos capas** complementarias (ADR-0002). cardoc es un middleware entre ML y la
base real (Zoho CRM); cada capa deduplica con su propia clave.

### 8.1 Capa 1 — middleware (Catalyst), **opcional** (header `X-Idempotency-Key`)

Si el request trae `X-Idempotency-Key`, se persiste un row en `crm_opportunities`
(`UNIQUE(idempotency_key)` single-column + `payload_fingerprint`) y se consulta **antes** de tocar
Zoho — fast-path que evita el roundtrip al CRM en los duplicados (`create-opportunity-contact.ts`):

1. Se siembra un row `pending` con `insertIfAbsent` por `idempotency_key` (el `accountId` se filtra
   en la query como defensa de tenancy, **no** es parte del constraint UNIQUE).
2. **Si se creó** (somos el creador) → efecto externo (Capa 2) → `markCreated` → **`201 created`**.
3. **Si ya existía**, según el row:

| Estado del row | `outcome` | HTTP |
|---|---|---|
| `payload_fingerprint` ≠ del request | `conflict` | **409 `IDEMPOTENCY_CONFLICT`** |
| `status = created` | `duplicate` | **200 OK** (replay, sin tocar el CRM) |
| `status = pending` | `in_progress` | **202 Accepted** |
| `status = error` | reintenta el efecto (idempotente) | según resultado |

### 8.2 Capa 2 — base (Zoho CRM), **siempre**

Sin `X-Idempotency-Key` (y como red de fondo del creador en Capa 1), la dedup la hace el CRM dentro
del propio efecto:
- **Contacto:** `findContactByCedula` antes de crear (reusa si existe).
- **Oportunidad:** `EXTERNAL_ID` = `NroSolicitud` es **único** en Deals; al recrear, Zoho responde
  `DUPLICATE_DATA` con el id existente → el adapter lo devuelve como **`200 duplicate`** (no error).

Sin header **no hay detección de payload-distinto** (no se guarda fingerprint): un repetido con
otro payload devuelve `duplicate`, no `409`. El `409` es una garantía **exclusiva de la Capa 1**.

> Status HTTP: **201** (creado) · **200** (duplicate, por cualquiera de las dos capas) · **202**
> (en curso, Capa 1) · **409** (mismo `X-Idempotency-Key` + payload distinto, Capa 1) · **502**
> (fallo de CRM).

---

## 9. Notas de tenancy y open questions

### 9.1 Tenancy (anclado al código)

- `accountId`/`consumerId`/`scopes` salen **del token** (`auth.ts`), nunca del payload/query.
- Cross-tenant en lecturas = **404** (`ReportNotFoundError`), no 403. 403 es **solo** para scope.
- Auditoría = 1 registro on-finish por request en los 3 endpoints (`audit.ts`): `timestamp`,
  `correlationId`, `consumerId`, `accountId`, `endpoint`, `outcome` (success/error), `httpStatus`,
  `latencyMs`, `errorCode`. No loguea payload/PII/bytes del PDF. `/v1/health` no se audita (sin container).

### 9.2 Open questions que afectan los contratos (no inventar)

Estos puntos están abiertos; los campos PLACEHOLDER del contrato dependen de ellos:

- **Negocio / PDF.** Cómo se genera el PDF cuando `Analisis.pdf_url` está vacío (plantilla nativa
  de Creator vs HTML→PDF en Catalyst vs servicio existente) y con qué datos; relación form
  `Informes` ↔ `Analisis`. La forma de `InformeRevision` (`types.ts`) es **PLACEHOLDER** hasta cerrar esto.
- **CRM.** API names exactos de los módulos estándar `Contacts`/`Deals`/`Accounts`. ✅ Resuelto:
  Stage = `Nueva Solicitud`; campos custom `Cedula` (Contacts) y `EXTERNAL_ID` (Deals) creados.
- **Catalyst (⚠️ verificar — docs oficiales/consola).** Streaming/chunked real y tope de payload en
  Advanced I/O (afecta `GET …/pdf` y el body máximo del POST); atomicidad del increment en Catalyst
  Cache (cap distribuido, §7); setup de la Connection OAuth a CRM; puerto exacto de `catalyst serve`
  para los `curl` de esta guía.

> Estado E-06: la API, el sobre de error, los códigos, la idempotencia y los headers de cap están
> **implementados y verdes** (`tsc -b`, 25 tests vitest, eslint, smoke local 21/21 + smoke Catalyst
> 5/5). El adapter de **CRM
> (`ZohoCrmClient`) está implementado** (E-02); el de Creator sigue **stub** (`NotImplementedError`) — los contratos de `data` se confirman al
> cerrar las open questions. Ver [PLAN-DE-DESARROLLO](PLAN-DE-DESARROLLO.md).
