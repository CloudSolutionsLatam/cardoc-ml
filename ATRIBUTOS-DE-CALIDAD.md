---
title: cardoc-ml — Atributos de Calidad del Backend (Catalyst)
status: borrador-para-validacion
last_reviewed: 2026-06-25
---

# Atributos de Calidad — Backend cardoc en Catalyst

Define los **atributos de calidad** (architecture characteristics / requerimientos
transversales) que el backend cardoc debe cumplir. Complementa a la
[ARQUITECTURA.md](ARQUITECTURA.md) (el *qué* y el *cómo* estructural) y a los
[CONTRATOS.md](CONTRATOS.md) (el contrato HTTP) con el *cuánto* y el *qué tan bien* —
sin esto, "API en Catalyst" es una decisión de plataforma sin contrato de calidad.

> **Terminología**: usamos "atributos de calidad" (Richards/Ford, ISO 25010);
> la literatura legacy los llama "requerimientos no funcionales (NFR)".

> **Estado de los targets**: los valores numéricos son **propuestos** y requieren
> validación con el negocio y con la plataforma. El backend está en **E-01 (scaffold
> deployable)**: dominio, puertos y use-cases en verde; adapters reales de Zoho como
> stubs `NotImplemented`. Lo que hoy se puede verificar en CI está marcado como tal;
> lo que depende de la plataforma va a la sección de validaciones pendientes (§9).

> **Convención de honestidad** (Unicorp Systems): cualquier afirmación sobre la
> plataforma Catalyst que no esté confirmada en el repo se marca **⚠️ verificar
> (docs/consola)**. No se afirma como hecho lo que no se probó. El CLI `catalyst`
> (init/deploy) y la estructura de configs SÍ están confirmados en el repo; los detalles
> finos de Cache/Connections/quotas NO.

---

## 1. Atributos rectores (driving characteristics)

No se puede optimizar todo a la vez. Cuando un trade-off de diseño enfrente dos
atributos, **estos cuatro mandan, en este orden**:

| # | Atributo rector | Rationale |
|---|-----------------|-----------|
| 1 | **Segregación por tenancy** | Mandato no negociable. 1 automotora = 1 Cuenta CRM = 1 token. El `accountId` se resuelve SIEMPRE del token (`api_tokens`), nunca del payload/query. Ninguna mejora de performance o simplicidad justifica que una automotora vea datos de otra. Acceso cruzado → **404** (no se confirma ni siquiera la existencia del recurso ajeno). |
| 2 | **Confidencialidad del PDF** | El PDF del informe y su ubicación (URL WorkDrive, fileId, `Analisis.pdf_url`) son confidenciales. El consumidor recibe **bytes por stream autenticado**, nunca una URL pública, un redirect 302, ni la ruta interna. Un leak de ubicación es tan grave como un leak de contenido. |
| 3 | **Idempotencia / no-duplicación** | Una Oportunidad (Deal) creada dos veces es un incidente operativo con la automotora y ensucia el CRM. Es preferible **no crear** (devolver el resultado previo) que crear un duplicado. Correctness > conveniencia de reintento. |
| 4 | **Auditabilidad** | Cada request debe poder reconstruirse después: quién, qué endpoint, qué resultado, con qué `correlationId` y latencia. Es la defensa ante disputas con la automotora y el requisito para diagnosticar producción. |

Todo lo demás (latencia, costo, elegancia de código) se subordina a estos cuatro.

---

## 2. Integridad: no duplicar la Oportunidad

La red anti-duplicación es **física** (`UNIQUE(account_id, idempotency_key)` en el
DataStore), no una verificación de buena fe en código. El use-case siembra un row
`pending` ANTES de tocar CRM; solo el creador del row ejecuta el efecto externo.

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Doble creación de Oportunidad | **Cero**. Clave = `X-Idempotency-Key` del consumidor (header **obligatorio** en el POST); unicidad física `UNIQUE(account_id, idempotency_key)`. Replays con la misma clave devuelven el resultado previo (`duplicate`), no crean un segundo Deal | Test de idempotencia en CI: mismo `(accountId, key, payload)` 2×/concurrente ⇒ una sola creación. Ya cubierto en `packages/application/test/create-opportunity-contact.test.ts` (path in-memory) |
| Misma clave + payload distinto | **409 IDEMPOTENCY_CONFLICT** (semántica Stripe). `payloadFingerprint` (SHA-256 canónico, claves ordenadas) se persiste con la clave; si difiere del fingerprint guardado → conflicto | Test unitario de `payloadFingerprint` (`packages/domain/test/idempotency.test.ts`) + test del use-case que cubre el branch `status: "conflict"` |
| Dedup de Contacto | **Por Documento (CI/RUT)**: `findContactByDocument` antes de crear; si existe, se reutiliza (`reusedContact: true`) | Test del use-case (rama "contacto existente reutilizado"); contra Mock CRM hoy, contra Zoho CRM en E-02 |
| Atomicidad del seed | El row `pending` se inserta con `insertIfAbsent`; si no se creó (otro flujo ganó la carrera), no se ejecuta el efecto externo | Cubierto por el test concurrente. **Depende de** que el DataStore garantice la unicidad real bajo concurrencia → validación de plataforma (§9, ítem 2) |
| Estado de la Oportunidad | Fijo `Agendamiento Ready`, fijado **server-side** (`FIXED_OPPORTUNITY_STAGE`), nunca elegido por el consumidor | Inspección de código; el valor de picklist exacto del CRM es open question (§9 negocio) |

---

## 3. Seguridad operativa (tenancy, scopes, secretos)

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Segregación por tenancy | `accountId` SIEMPRE del token (`api_tokens.account_id`), NUNCA del payload/query. Toda query de runtime filtra por ese `accountId` | Test de autorización cruzada: token de Cuenta A pidiendo un informe de Cuenta B ⇒ **404 NOT_FOUND** (no 403). Verificable en CI con dos tokens sembrados |
| Distinción 403 vs 404 | **403 FORBIDDEN_SCOPE** solo para falta de scope; **404** para recurso ajeno/inexistente (no se filtra la existencia de datos de otra Cuenta) | Tests por endpoint: scope insuficiente → 403; recurso de otra Cuenta → 404. Anclado en `requireScope` (403) y `openPdf`/`findById` (404 vía `ReportNotFoundError`) |
| Scopes por endpoint | `opportunities:create` (POST) · `reports:read` (GET lista) · `reports:pdf` (GET PDF). El middleware `requireScope` corre **por ruta** | Inspección de `app.ts` (montaje por ruta) + test 403 con token sin el scope requerido |
| Secretos | **Cero credenciales en código o repo**. Todo en Catalyst Environment Variables; `.catalystrc` gitignored (solo se versiona `.catalystrc.example`) | Secret-scanning como gate de CI (falla el build si detecta un secreto). El token de dev (`Bearer test-token`) es solo in-memory para local, nunca un secreto real |
| Token en reposo | Solo se persiste el **`sha256`** del token (`api_tokens.token_hash`); el token plano nunca toca el DataStore ni los logs | Inspección de `authMiddleware` (compara `hashToken(token)`) y de `tokens.ts` (`hashToken`/`generateToken`) |
| Vigencia del token | Se rechaza (**401 UNAUTHENTICATED**) si revocado (`revoked_at`) o expirado (`expires_at`) | Tests de auth: token revocado/expirado → 401 |
| No filtración de upstream | El sobre de error nunca expone URL/ruta/fileId interno; `UpstreamError` lleva solo una etiqueta **opaca** (`"crm"`/`"creator"`/`"workdrive"`) | Inspección de `errors.ts` (función + providers) + test que verifica que el body de un 502 no contiene URLs internas |
| Auth a Zoho CRM | Vía **Catalyst Connection** (OAuth gestionado por la plataforma), no tokens hardcodeados en código | Setup de la Connection → validación de plataforma (§9, ítem 5). Hoy `ZOHO_CRM_ACCESS_TOKEN` es placeholder dev |
| Rotación de credenciales | Tokens de consumidor revocables (`revoked_at`) y rotables; rotación ≤ 90 días o inmediata ante sospecha | Procedimiento documentado y **probado** (no solo escrito): ver playbook [secretos-y-connections](docs/playbooks/secretos-y-connections.md) |

---

## 4. Disponibilidad y degradación controlada

cardoc no puede prometer más disponibilidad que su upstream (Catalyst + Zoho CRM/Creator/
WorkDrive). El diseño separa la **falla del upstream** (502, no es culpa nuestra) de la
**falla propia** (500).

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Disponibilidad del servicio propio | **99.5% mensual** (medido sobre el servicio propio; excluye outages upstream etiquetados como tales) | Health check externo contra `GET /v1/health` (abierto, sin auth) + tasa de éxito por causa en `audit_log` |
| Degradación ante falla de upstream | Una falla de CRM/Creator/WorkDrive se traduce a **502 UPSTREAM_ERROR** con etiqueta opaca, no a 500 ni a un cuelgue. El consumidor distingue "problema del proveedor" de "problema de cardoc" | Inspección de `toApiError` (mapea `UpstreamError`→502); test del adapter que simula falla de upstream ⇒ 502 |
| Falla a mitad de stream del PDF | Si aún no se enviaron bytes → 502; si el stream ya empezó → se corta la conexión (no se envía un PDF corrupto con 200) | Inspección de `streamPdfHandler` (handler de `stream.on("error")`); test con stream que falla antes/después del primer byte |
| Aislamiento de blast radius por tenancy | Un problema de una Cuenta (caps, datos) no degrada a otra: caps y queries son por `accountId`/`consumerId` | Cubierto por los tests de tenancy (§3) + cap por consumidor (§7) |
| Dependencia upstream (techo de SLA) | cardoc no promete más uptime que Catalyst + Zoho — el SLA upstream es el techo | Validación de plataforma (§9, ítem 1) |

---

## 5. Performance y capacidad

El diseño separa el **overhead propio** (auth + validación + idempotencia + cap) de la
latencia del upstream, que cardoc no controla.

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Overhead propio (auth + scope + cap + validación) | p95 ≤ **200 ms** (excluye el round-trip a CRM/Creator/WorkDrive) | Métrica por request: `latency_ms` del `audit_log` menos el tiempo de upstream. Hoy el smoke e2e (16/16) corre contra path in-memory ⇒ mide solo overhead propio |
| POST opportunity-contact end-to-end | p95 ≤ **3 s** (dominado por las 2-3 llamadas a Zoho CRM) | Métrica end-to-end con `correlationId`, medida contra Zoho CRM en E-02 |
| Streaming del PDF | El PDF se **pipea** (`pdf.stream.pipe(res)`), no se buffea entero en memoria; headers antes del primer byte; `Cache-Control: no-store` | Inspección de `streamPdfHandler`. El **chunked/streaming real en Advanced I/O** y el **tope de payload** → validación de plataforma (§9, ítem 3) |
| Tamaño del bundle de deploy | `index.js` ~195 kb (esbuild, cjs, target node24, externals = `express`, `zcatalyst-sdk-node`) — arranque liviano | Salida de `scripts/bundle-function.mjs` en CI |
| Capacidad baseline de diseño | Defaults de cap: **1.000/h, 10.000/día, 50.000/sem** por consumidor+endpoint (`CARDOC_CAP_DEFAULT_*`) — **placeholder** hasta cerrar volúmenes reales con el negocio | Recalibrar con datos reales de la(s) automotora(s) piloto |
| Cold start de la function | Por medir | Validación de plataforma (§9, ítem 4) |

---

## 6. Observabilidad y auditabilidad

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Trazabilidad end-to-end | **100%** de los requests con `correlationId`. Se acepta `X-Correlation-Id` entrante si es UUID válido, si no se regenera; se devuelve en el header `X-Correlation-Id` Y en el sobre de error | Inspección de `correlationMiddleware`; muestreo: tomar un `correlationId` y reconstruir el request en `audit_log`. Test: request sin header ⇒ se genera UUID; con UUID válido ⇒ se propaga |
| Audit trail append-only | **1 registro por request** en los 3 endpoints, escrito on-finish: `timestamp, correlationId, consumerId, accountId, endpoint, outcome, httpStatus, latencyMs, errorCode`. Sin UPDATE/DELETE desde la aplicación | Inspección de `auditOnFinish` + `AuditLogEntry`; test: cada endpoint deja exactamente 1 registro con el `httpStatus` correcto (incluso en error) |
| Auditoría sin PII ni payload | El `audit_log` guarda **solo identificadores y estado** — nunca el payload, la PII (documento/datos de contacto) ni los bytes del PDF | Inspección de `auditOnFinish` (no toca body) + revisión en code review de cada campo del entry |
| Logs operativos sin secretos | Los `console.error` de error/audit logean solo `correlationId`, método, path y código — nunca token, payload, PII ni URL interna | Inspección de `errorMiddleware` y del catch de `auditOnFinish` |
| Health check observable | `GET /v1/health` abierto (sin auth, no se audita) para el monitoreo externo | Inspección de `app.ts`; el monitoreo externo lo consume |
| Retención de logs/auditoría | Por definir (baseline operativo ≥ 90 días) | Retención nativa de Catalyst → validación de plataforma (§9, ítem 6) + política explícita en el diseño del DataStore ([datastore-esquema](docs/playbooks/datastore-esquema.md)) |
| Detección de incidentes | Error rate alto o N fallas seguidas de un mismo consumidor → alerta. Mecanismo y umbral por definir con el negocio | Prueba de alerta inducida antes de producción (E-03+) |

---

## 7. Cap (límite de uso) y abuso

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Cap por consumidor+endpoint | 3 ventanas (hora/día/semana) por `consumer_id`+`endpoint`; config en `consumer_caps` con fallback a `CARDOC_CAP_DEFAULT_*`. Exceso → **429 CAP_EXCEEDED** con `Retry-After` | Test del middleware `cap`: superar el límite ⇒ 429 + header `Retry-After`; headers `X-Cap-{Window,Limit,Remaining}` presentes |
| Orden de evaluación | Cap se evalúa **después** de auth+scope: un 401/403 **no** consume cap | Inspección del pipeline en `app.ts` (cap va tras `authMiddleware`+`requireScope`); test que confirma que un 401 no incrementa el contador |
| Cap distribuido real | **⚠️ Gap conocido**: hoy los contadores son **in-memory por contenedor caliente** (`Map` en `cap.ts`). Un cap correcto multi-contenedor necesita **Catalyst Cache** (TTL nativo + increment atómico) | La atomicidad del increment en Catalyst Cache → validación de plataforma (§9, ítem 7). **Hasta validarla, el cap es best-effort por contenedor, no un límite duro global** — marcado explícitamente en el código |

---

## 8. Costo (FinOps) y operabilidad

| Atributo | Target propuesto | Cómo se verifica |
|----------|------------------|------------------|
| Generación perezosa del PDF | El PDF se genera **una sola vez**: si `Analisis.pdf_url` está lleno → stream desde WorkDrive; si vacío → generar + write-back a `Analisis.pdf_url` y luego stream. Evita regenerar en cada request (costo de cómputo) | Inspección del contrato de `ReportsSource.openPdf`. **El generador concreto (plantilla Creator vs HTML→PDF) y los datos de origen son open question** (§9 negocio) |
| Adapter de SDK/streaming en la capa function | El adapter que toca el SDK de Catalyst vive en `apps/catalyst/functions/api`, NO en `packages/*` — el dominio queda portable y testeable sin Catalyst | Estructura del repo: `packages/*` no importa `zcatalyst-sdk-node` (es external solo en el bundle de la function) |
| Deploy reproducible | `tsc -b` (project references) + `scripts/bundle-function.mjs` (esbuild) → `index.js` único. `catalyst deploy` instala solo los externals | Pipeline: build en verde (`tsc -b`, 7 tests, eslint, smoke 16/16, bundle). Ver [deploy-y-rollback](docs/playbooks/deploy-y-rollback.md) |
| Instalación en red corporativa | `NODE_OPTIONS=--use-system-ca pnpm install` (CA propia / intercepción TLS). `pnpm.onlyBuiltDependencies: ["esbuild"]` evita postinstalls inesperados | Documentado en [README.md](README.md) y [monorepo-build-y-bundling](docs/playbooks/monorepo-build-y-bundling.md) |
| Presupuesto mensual y costo por request | **Por definir** según plan de Catalyst y volumen relevado; alerta de consumo al 80% | Revisión mensual de consumo. Requiere las quotas/plan de la plataforma (§9) |

---

## 9. Validaciones de plataforma pendientes (de-risk antes de producción)

Lo que **no** hay que asumir de Catalyst sin verificar. Cada ítem se valida contra
documentación oficial, consola, o un thin slice. El CLI `catalyst` (init/deploy) y la
estructura de configs (`catalyst.json`, `catalyst-config.json` con `stack: node24`,
`type: advancedio`) están confirmados en el repo; lo de abajo **no**.

| # | Qué validar | Atributo que sustenta |
|---|-------------|----------------------|
| 1 | **PDF (negocio)**: cómo se genera cuando `Analisis.pdf_url` está vacío (plantilla nativa de Creator vs HTML→PDF en Catalyst vs servicio existente) y de qué datos sale. Relación entre los forms `Informes` y `Analisis` | Confidencialidad/Costo del PDF (§2, §8) |
| 2 | **CRM (negocio)**: API names exactos de Contacts/Deals/Accounts; si `Agendamiento Ready` es un valor de picklist existente y su API name | Integridad / no-duplicación (§2) |
| 3 | **Streaming y payload** ⚠️: streaming/chunked real y tope de payload en Advanced I/O | Performance / confidencialidad del PDF (§5, §2) |
| 4 | **Cache (atomicidad)** ⚠️: atomicidad del increment en Catalyst Cache para el cap distribuido (hoy los contadores son in-memory por contenedor) | Cap (§7) |
| 5 | **Connection OAuth** ⚠️: setup de la Catalyst Connection a Zoho CRM (auth gestionada) | Seguridad / auth a CRM (§3) |
| 6 | **Residencia de datos** ⚠️: región/data center y residencia de la PII (jurisdicciones UY / AR / Wyoming) | Seguridad / compliance (§3) |
| 7 | **SLA / quotas / cold-start / logs / backup** ⚠️: SLA y uptime del plan, quotas (invocaciones, concurrencia, tamaño de payload), cold-start p95, retención de logs, y mecanismo de backup/export del DataStore | Disponibilidad, capacidad, observabilidad, recuperación (§4, §5, §6) |

> ⚠️ Los ítems 3-7 son specifics de plataforma **no confirmados en el repo**. Se
> resuelven con docs oficiales/consola, no asumiendo. Los ítems 1-2 son del negocio y
> dependen del relevamiento con la automotora; ver Open Questions en [README.md](README.md)
> y [ARQUITECTURA.md](ARQUITECTURA.md).

---

## 10. Mapeo a etapas del plan

Estos atributos **no son extras post-deploy** — se construyen donde corresponde.
Cronograma sprint 22/06→03/07/2026 (owner Nestor Toñanez, 1 dev). Ver
[PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md).

| Etapa | Atributos que entrega |
|-------|----------------------|
| **E-01 — Scaffold (completo, deployable)** | Pipeline de middlewares con orden fijo, sobre de error único, tenancy del token, scopes por ruta, idempotencia + `payloadFingerprint`, cap (best-effort in-memory), auditoría on-finish, build/bundle/deploy en verde. Path in-memory + Mock CRM/Reports |
| **E-02 — Adapters CRM** | `ZohoCrmClient` real (Connection OAuth), dedup por documento contra Zoho, creación de Deal `Agendamiento Ready`; medición de latencia end-to-end real |
| **E-03 — Adapters Creator/WorkDrive + PDF** | `ZohoCreatorReportsSource` real, streaming del PDF, generación perezosa + write-back; cierre de las open questions de PDF |
| **Pre-producción** | Las validaciones de plataforma (§9): Cache atómico para cap duro, streaming/payload, residencia, SLA/quotas, retención, backup/export del DataStore |

---

## 11. Gobernanza

- **Lo que no se verifica, no es un target — es una expresión de deseo.** Donde existe
  verificación automatizable, va a CI (tsc, vitest, eslint, smoke e2e, secret-scanning).
  Lo que no, se marca como pendiente, no se afirma.
- Los specifics de plataforma se marcan **⚠️ verificar** hasta confirmarlos contra docs
  oficiales o consola. No se documentan como hechos los detalles de Cache/Connections/
  quotas que el repo no prueba.
- Cambiar un target = actualizar **este documento**, no una decisión implícita en código.
- Los targets numéricos (overhead, disponibilidad, caps, retención) se cierran con el
  negocio y la plataforma antes de producción; los placeholder están marcados como tales.
- Revisión del documento junto con cada hito del plan (E-02, E-03, pre-producción).

---

_Documentos relacionados: [README.md](README.md) · [ARQUITECTURA.md](ARQUITECTURA.md) ·
[CONTRATOS.md](CONTRATOS.md) · [OPERACIONES.md](OPERACIONES.md) ·
[PLAN-DE-DESARROLLO.md](PLAN-DE-DESARROLLO.md) · [docs/README.md](docs/README.md)_
