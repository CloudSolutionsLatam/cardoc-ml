---
title: Guía de integración y ciclo de vida — API cardoc-ml (Cardoc)
document_type: entregable-cliente
audience: Cardoc — equipo técnico y de negocio (uso interno)
confidencialidad: CONFIDENCIAL · uso interno Cardoc/Unicorp
environment: Development (Catalyst)
status: para-validación
version: 2.0
date: 2026-07-03
owner: Unicorp Systems
---

# API cardoc-ml — Guía de integración y ciclo de vida

> ## 🔒 Documento confidencial — uso interno de Cardoc
>
> Este documento describe **cómo está estructurado internamente el negocio de Cardoc**: el modelo
> de datos del CRM (módulos, campos y el pipeline comercial B2B), el criterio con que se identifican
> los clientes, la lógica de segregación entre integraciones y la mecánica del backend. Es material
> **sensible**: revelarlo a un tercero (una automotora, un integrador, un proveedor) expondría la
> arquitectura de datos y las reglas de seguridad de Cardoc, y facilitaría inferir información
> comercial o sondear el sistema.
>
> **No redistribuir fuera de Cardoc/Unicorp.** Para un integrador externo (p. ej. ML / AutoCheck)
> existe una guía separada —`GUIA-INTEGRACION-ML.md`— que expone **únicamente** la superficie de
> consumo (cómo llamar y qué recibir), sin detalles internos. Entregar siempre esa versión a terceros.

**Qué es.** cardoc-ml es una API (Zoho Catalyst) que actúa de **gateway** entre la plataforma
externa **ML / AutoCheck** y el back-office de Cardoc (**Zoho CRM** + **Cardoc 360**). Cubre el
ciclo completo de una inspección vehicular de punta a punta: **alta de la solicitud → avance de
estados → aprobación del informe → entrega del PDF**. El consumidor externo nunca toca el CRM, ni
Creator, ni WorkDrive: solo ve la API.

---

## 1. Actores del ciclo

| Símbolo | Actor | Rol en el ciclo |
|---|---|---|
| 🟦 **ML / AutoCheck** | Plataforma externa (`mlcenter.com.uy`) | Origina la solicitud de inspección; recibe las notificaciones de estado; descarga el PDF. |
| 🟩 **API cardoc-ml** | Función Catalyst (este servicio) | Gateway. Valida identidad, alcance, cuota y segregación; orquesta a Zoho. |
| 🟨 **Zoho CRM** | Back-office Cardoc (`Deals` / `Contacts` / `Accounts` + `Informes_Revision`) | Donde vive la Oportunidad. El equipo Cardoc avanza etapas y dispara la notificación. |
| 🟧 **Cardoc 360** | Zoho Creator + WorkDrive | Donde se realiza y **se aprueba** el análisis; fuente del PDF del informe. |

---

## 2. El ciclo de vida (end-to-end)

Todo el ciclo gira alrededor de un único número: el **`NroSolicitud`** que ML asigna al crear la
solicitud. Ese número es la llave que une la solicitud de ML, la Oportunidad en el CRM, el Análisis
en Cardoc 360 y la descarga del PDF. El ciclo **cierra sobre el mismo número** con el que arrancó.

### 2.1 Las cuatro fases

```
  🟦 ML/AutoCheck        🟩 API cardoc-ml         🟨 Zoho CRM            🟧 Cardoc 360
      │                       │                       │                       │
 (1)  │  POST /v1/opportunity-contact                 │                       │
      │──────────────────────>│  crea Contacto + Oportunidad (Nueva Solicitud)│
      │                       │──────────────────────>│  bajo la Cuenta "ML"  │
      │<──────────────────────│  201 {contact, opportunity, nroSolicitud}     │
      │                       │                       │                       │
 (2)  │      Equipo Cardoc avanza el Deal de etapa y pulsa el botón "Notificar a ML"
      │                       │<── POST /v1/internal/deal-estado ─────────────│
      │   updateEstado        │    (secreto interno · mapea Stage→Estado)     │
      │<══════════════════════│                       │                       │
      │   PENDIENTE / COORDINACIÓN / FINALIZADO        │                       │
      │                       │                       │                       │
 (3)  │                       │             el análisis se APRUEBA en Cardoc 360
      │                       │                       │<── Creator_Analisis_ID ──│
      │                       │                       │   (módulo Informes_Revision)
      │                       │                       │                       │
 (4)  │  GET /v1/informes/solicitud/{nroSolicitud}/pdf │                       │
      │──────────────────────>│  resuelve vía CRM → genera/streamea el PDF    │
      │                       │──────────────────────>│──────────────────────>│
      │<══════════════════════│  200 application/pdf (stream binario)         │
```

| Fase | Endpoint | Lo dispara | Efecto |
|---|---|---|---|
| **1. Alta** | `POST /v1/opportunity-contact` | 🟦 ML | Contacto (reutilizado por cédula) + Oportunidad `Nueva Solicitud`, bajo la Cuenta del token. |
| **2. Notificación** | `POST /v1/internal/deal-estado` | 🟨 Cardoc (botón / futuro workflow) | Notifica a ML el `PENDIENTE` / `COORDINACIÓN` / `FINALIZADO` según el Stage del Deal. |
| **3. Aprobación** | *(sin endpoint público)* | 🟧 Cardoc 360 | Al aprobar el análisis, el `Creator_Analisis_ID` queda escrito en `Informes_Revision` del CRM. |
| **4. Entrega** | `GET /v1/informes/solicitud/{nroSolicitud}/pdf` | 🟦 ML | Resuelve el análisis vía CRM y entrega el PDF del informe. |

### 2.2 El estado de la Oportunidad (pipeline B2B)

La Oportunidad recorre el **pipeline B2B** del CRM. Cada avance de etapa gobierna qué se notifica a
ML y cuándo queda disponible el PDF:

```
  Nueva Solicitud ──► Agendado B2B ──► Completado ──► Cerrado
        │                 │                 │             │
        ▼                 ▼                 ▼             ▼
  notifica a ML     notifica a ML     notifica a ML  notifica a ML
   PENDIENTE         COORDINACIÓN       FINALIZADO     FINALIZADO
                                       (+ link PDF)   (+ link PDF)

  Rama alternativa:  … ──► Cancelado  →  no se notifica a ML
```

- **`Nueva Solicitud`** → estado inicial → ML recibe `PENDIENTE` (pedido de Nestor 2026-07-03).
- **`Agendado B2B`** → se coordina la inspección → ML recibe `COORDINACIÓN`.
- **`Completado` / `Cerrado`** → la inspección finaliza → ML recibe `FINALIZADO` con el link del PDF.
- **`Cancelado`** → estado terminal sin notificación (AutoCheck no tiene un estado de cancelación).

---

## 3. Decisiones de diseño (CR-003 §10), explicadas con escenarios

Esta sección traduce a lenguaje operativo las definiciones técnicas del punto 10 del CR-003 —las que
gobiernan cómo se comporta la API en la práctica—. Cada una se ilustra con un escenario concreto.

### 3.1 La Oportunidad nace en "Nueva Solicitud"

**Qué se decidió.** Toda alta crea la Oportunidad en el estado **`Nueva Solicitud`** del pipeline
comercial **B2B** (el backend fija el estado; el consumidor no puede elegirlo).

**Por qué.** El backend se integra al flujo de agendamiento **existente** sin rediseñarlo: la
solicitud entra por el mismo funnel B2B que el resto de la operación de Cardoc.

**Escenario.** ML da de alta la solicitud `NroSolicitud 908812` (Chevrolet Onix, matrícula SBA1234).
Se crea el Deal *"ML 908812"* en pipeline B2B, etapa `Nueva Solicitud`. A partir de ahí lo mueve el
equipo Cardoc: `Nueva Solicitud → Agendado B2B → Completado → Cerrado`.

### 3.2 El cliente se identifica por Cédula

**Qué se decidió.** El Contacto se **reutiliza por número de Cédula**. Si el cliente ya existe en el
CRM (misma cédula), se reutiliza su ficha; si no, se crea. El teléfono se guarda como dato de
contacto, pero **no** decide la identidad.

**Por qué.** La cédula es un identificador **estable, único y siempre presente**. A diferencia del
teléfono —que cambia, admite formatos distintos (`+598…` vs `09…`) y puede compartirse— la cédula
garantiza **una única ficha por persona** y un historial consolidado, sin duplicados.

**Escenario.** Juan Pérez (cédula 45321890) pide una revisión hoy con el celular `099123456`. Tres
semanas después pide otra, ya con un número nuevo. Como la clave es la cédula, la API **reconoce a
Juan y reutiliza su Contacto** (`reused: true`): la segunda Oportunidad cuelga de la misma ficha. Su
historial queda unificado; no se genera un cliente duplicado.

### 3.3 Trazabilidad de origen — "Portal solicitante"

**Qué se decidió.** Se mantiene el módulo **Informes de Revisión** tal cual y se agrega el campo
**Portal solicitante**, que identifica desde qué canal se originó la operación (ML). El campo se
completa **dentro del flujo existente** —en el registro de Informes de Revisión al cerrarse la
Oportunidad y en el informe de Creator—; **la API no lo pide en cada llamada** (el origen ML es
implícito, porque la Oportunidad ya nace en el pipeline B2B).

**Por qué.** Da trazabilidad del origen **sin ampliar la superficie de integración** (menos datos
que exigir al consumidor) y sirve de base para que la API **segregue por canal**: un consumidor del
canal B2B/ML **nunca** puede acceder a informes de otro canal.

**Escenario.** ML descarga el PDF de una solicitud. La API resuelve el informe y verifica que
pertenezca al canal ML; si por un cruce de datos el informe fuera de otro canal (p. ej. retail), la
API responde `404` y **no lo entrega**. El campo Portal solicitante permite, además, reportar el
origen de cada operación en el CRM.

### 3.4 El PDF se entrega solo cuando el informe está listo

**Qué se decidió.** El informe queda disponible para consulta externa **una vez que el análisis
aprobado en Cardoc 360 quedó vinculado a la solicitud** (es decir, cuando se cierra la operación y
el `Creator_Analisis_ID` se escribe en el registro de Informes de Revisión). Antes de ese momento, la
API responde `404`. Así **no se expone información parcial o no validada**.

**Por qué.** El informe recién tiene sentido de negocio cuando está terminado y aprobado. Vincular el
análisis al cierre es lo que "habilita" su descarga: sin ese vínculo, no hay nada que entregar.

**Escenario.** ML intenta descargar el PDF de `NroSolicitud 908812` mientras la inspección todavía
está en curso: la API responde `404` (aún no hay informe aprobado vinculado). Una vez que el análisis
se aprueba en Cardoc 360 y el vínculo queda registrado, la misma llamada devuelve el PDF.

### 3.5 Nombre estándar del archivo PDF

**Qué se decidió.** El archivo se nombra `NombreCliente_IDInterno_Fecha.pdf`, con la fecha en
formato **ISO 8601** (`AAAA-MM-DD`). El `IDInterno` es el **código del informe de Cardoc 360** (el
mismo que figura en el informe).

**Por qué.** Nombres **legibles, ordenables por fecha y seguros** para descargar en cualquier sistema
(sin acentos, espacios ni caracteres que rompan la descarga). Facilita localizar el archivo por
cliente, identificador o fecha.

**Escenario.** ML descarga el informe del cliente *"Automotora del Este S.A."*, código `R-12345`,
inspección del 20/06/2026. El archivo llega como
`Automotora-del-Este-S-A_R-12345_2026-06-20.pdf` (acentos y caracteres inseguros saneados).

### 3.6 Límites de consumo (cap)

**Qué se decidió.** Cada endpoint tiene un tope por hora, como capa de protección: **alta = 60/h**,
**descarga de PDF = 100/h**. Al superarlo, la API responde con un error estándar de límite excedido
(`429`) que indica en segundos cuándo reintentar.

**Por qué.** El cap es un **guardrail** contra abuso, loops de integración o picos anómalos que
afecten la estabilidad del servicio. No es un límite comercial: es un piso conservador y **ajustable**
sin tocar código. Un `429` **no** implica falla del sistema, sino protección operativa.

**Escenario.** Una integración baja informes en lote. Al PDF número 101 dentro de la misma hora
recibe `429 CAP_EXCEEDED` con `Retry-After: 1320` (reintentar en ~22 min, cuando resetea la ventana).
El resto del tráfico sigue normal.

### 3.7 Política de no divulgación — 404, no 403

**Qué se decidió.** Si una integración intenta acceder a un recurso que **no le corresponde**, la API
responde **`404 No encontrado`** (no `403`). El `403` queda reservado **exclusivamente** para falta de
permisos (scope).

**Por qué.** Un `403 Prohibido` confirmaría que el recurso **existe** —información que un tercero podría
usar para sondear datos ajenos—. El `404` **no revela nada**. Es una decisión de seguridad por diseño:
no divulgar la existencia de recursos de otra integración.

**Escenario.** Una integración pide, con su propio token, un informe que no le pertenece. Aunque el
informe exista, la API responde `404` —idéntico a si no existiera—, sin filtrar ninguna pista.

---

## 4. Entorno y Base URL

| | |
|---|---|
| **Entorno** | Development (Catalyst — proyecto **ML**) |
| **Base URL** | `https://ml-909785950.development.catalystserverless.com/server/api` |
| **Prefijo de rutas** | `/v1` |

Health check (abierto, sin auth) para validar conectividad:

```bash
curl -i {{BASE_URL}}/v1/health
# → 200 { "status": "ok", "service": "api" }
```

En esta guía la Base URL se referencia como `{{BASE_URL}}`.

---

## 5. Autenticación

Dos mecanismos, según quién llama:

| Mecanismo | Header | Lo usa | Endpoints |
|---|---|---|---|
| **Token de consumidor** | `X-Api-Key: <token>` | 🟦 ML / AutoCheck | `opportunity-contact`, `informes/.../pdf` |
| **Shared-secret interno** | `x-internal-secret: <secreto>` | 🟨 CRM (botón / workflow) | `internal/deal-estado` |

**Reglas clave:**

- El token es **opaco** y está atado a una **Cuenta** (la automotora; hoy la Cuenta "ML"). La Cuenta
  y los permisos (*scopes*) se resuelven **siempre del token**, nunca del payload ni del query.
- *Scopes* por endpoint: `opportunities:create`, `reports:pdf`, `reports:read`.
- El endpoint `internal/deal-estado` **no** usa el token público: es una llamada de confianza
  CRM ↔ Catalyst, protegida por `x-internal-secret`.

Toda respuesta incluye `X-Correlation-Id` (identificador de trazabilidad); guardalo para soporte.

---

## 6. Endpoint 1 — Alta de la solicitud

`POST /v1/opportunity-contact` · **scope** `opportunities:create` · **lo llama 🟦 ML**

Crea (o reutiliza) el **Contacto** y crea la **Oportunidad** en estado fijo `Nueva Solicitud`, ambos
asociados a la **Cuenta del token**. El Contacto se **reutiliza por cédula** (ver §3.2).

### 6.1 Request

Headers: `X-Api-Key` (oblig.) · `Content-Type: application/json` · `X-Idempotency-Key` (opcional, ver §6.4).

```jsonc
{
  "NroCedula":            45321890,               // requerido — identifica al Contacto (llave de reutilización)
  "NroSolicitud":         908812,                 // requerido, único — llave de todo el ciclo
  "Nombres":              "Juan Carlos",          // requerido (≤100)
  "Apellidos":            "Pérez Rodríguez",      // requerido (≤100)
  "CelularCliente":       "099123456",            // opcional (≤30) — dato de contacto, no llave
  "Tenant":               "CARDOC-UY-001",        // opcional (≤100) — código de origen (informativo)
  "Sucursal":             "Centro Montevideo",    // opcional (≤100)
  "DepartamentoSucursal": "Montevideo",           // opcional (≤100)
  "CiudadSucursal":       "Montevideo",           // opcional (≤100)
  "DireccionSucursal":    "Av. 18 de Julio 1234", // opcional (≤200)
  "MarcaVehiculo":        "Chevrolet",            // opcional (≤100)
  "ModeloVehiculo":       "Onix",                 // opcional (≤100)
  "AnioVehiculo":         2022,                    // opcional (entero)
  "MatriculaVehiculo":    "SBA1234"               // opcional (≤30)
}
```

> **Validación estricta.** Sólo se aceptan estas claves. Cualquier campo extra → `400 VALIDATION_ERROR`.
> El campo `Tenant` es una **etiqueta informativa de origen** (se registra junto a la Oportunidad); no
> define la Cuenta ni reutiliza Contactos — eso lo resuelve el token.

### 6.2 Respuestas de éxito

| HTTP | `status` | Cuándo |
|---|---|---|
| `201 Created` | `created` | Primera vez para ese `NroSolicitud`. |
| `200 OK` | `duplicate` | Reintento del mismo `NroSolicitud` (ya existía). |
| `202 Accepted` | `in_progress` | La misma clave está siendo procesada por otro flujo concurrente. |

```json
// 201 Created
{
  "status": "created",
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "nroSolicitud": 908812,
  "contact":     { "id": "ct_001", "reused": false },
  "opportunity": { "id": "op_001", "stage": "Nueva Solicitud" }
}
```

`contact.reused = true` indica que el Contacto ya existía y se reutilizó por cédula.

### 6.3 Errores

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Falta un campo requerido o hay una clave no permitida. |
| 401 | `UNAUTHENTICATED` | Sin `X-Api-Key` o token inválido/revocado/vencido. |
| 403 | `FORBIDDEN_SCOPE` | El token no tiene `opportunities:create`. |
| 409 | `IDEMPOTENCY_CONFLICT` | Mismo `X-Idempotency-Key` con **payload distinto** (ver §6.4). |
| 429 | `CAP_EXCEEDED` | Límite de uso excedido (§3.6). |
| 502 | `UPSTREAM_ERROR` | Falla al crear en el CRM. |

### 6.4 Idempotencia (opcional, recomendada)

Con el header `X-Idempotency-Key: <valor-único>`, un reintento exacto devuelve `200 duplicate` sin
volver a tocar el CRM, y el mismo valor con un payload distinto devuelve `409`. Sin el header, el CRM
deduplica igual por `NroSolicitud`.

### 6.5 Ejemplo

```bash
curl -i -X POST {{BASE_URL}}/v1/opportunity-contact \
  -H "X-Api-Key: {{API_TOKEN}}" \
  -H "X-Idempotency-Key: sol-908812" \
  -H "Content-Type: application/json" \
  -d '{
    "NroCedula": 45321890, "NroSolicitud": 908812,
    "Nombres": "Juan Carlos", "Apellidos": "Pérez Rodríguez", "CelularCliente": "099123456",
    "MarcaVehiculo": "Chevrolet", "ModeloVehiculo": "Onix", "AnioVehiculo": 2022, "MatriculaVehiculo": "SBA1234"
  }'
```

---

## 7. Endpoint 2 — Notificación de estado a ML (el botón)

`POST /v1/internal/deal-estado` · **auth** `x-internal-secret` · **lo dispara 🟨 Cardoc (CRM)**

A medida que la Oportunidad avanza de etapa, Cardoc notifica a ML el cambio de estado. Hoy el disparo
es un **botón** en el CRM (función Deluge `ml_notificar_estado_oportunidad`); a futuro puede
automatizarse como **workflow** sobre el cambio de `Stage`.

### 7.1 Mapeo de estados (Stage del CRM → Estado de ML)

| Stage del Deal (CRM) | Estado notificado a ML | Nota |
|---|---|---|
| `Agendado B2B` | `COORDINACIÓN` | — |
| `Completado` | `FINALIZADO` | Requiere `linkResultado`. |
| `Cerrado` | `FINALIZADO` | Requiere `linkResultado`. |
| `Nueva Solicitud` | `PENDIENTE` | Estado inicial; se re-notifica a ML. |
| `Cancelado` | *(no notifica)* | AutoCheck no tiene estado de cancelación. → `skipped`. |

### 7.2 Request

Headers: `x-internal-secret` (oblig.) · `Content-Type: application/json`.

```jsonc
{
  "nroSolicitud":  908812,                              // requerido — llave de la Oportunidad
  "stage":         "Completado",                        // requerido — valor del Stage del Deal
  "linkResultado": "{{BASE_URL}}/v1/informes/solicitud/908812/pdf", // requerido si el estado es FINALIZADO
  "observaciones": "Inspección sin observaciones"       // opcional (≤500)
}
```

> El `linkResultado` que arma el CRM es la **URL del Endpoint 3** (el PDF por Nº de solicitud): un
> enlace estable al gateway, no una URL interna de WorkDrive.

### 7.3 Respuestas

| HTTP | `status` / code | Cuándo |
|---|---|---|
| 200 | `sent` | Se notificó a ML (incluye `estado`). |
| 200 | `skipped` | El Stage no corresponde a un estado notificable (no es error). |
| 400 | `VALIDATION_ERROR` | Body inválido. |
| 401 | `UNAUTHENTICATED` | `x-internal-secret` ausente o incorrecto. |
| 422 | `UNPROCESSABLE` | `FINALIZADO` sin `linkResultado`. |
| 502 | `UPSTREAM_ERROR` | Falla real de ML. |

### 7.4 Ejemplo (para QA — normalmente lo dispara el botón del CRM)

```bash
curl -i -X POST {{BASE_URL}}/v1/internal/deal-estado \
  -H "x-internal-secret: {{INTERNAL_SECRET}}" \
  -H "Content-Type: application/json" \
  -d '{ "nroSolicitud": 908812, "stage": "Agendado B2B" }'
# → 200 { "status": "sent", "estado": "COORDINACIÓN", ... }
```

---

## 8. Endpoint 3 — Descarga del PDF por Nº de Solicitud

`GET /v1/informes/solicitud/{nroSolicitud}/pdf` · **scope** `reports:pdf` · **lo llama 🟦 ML**

Devuelve el **PDF del informe** de un `NroSolicitud`. La API resuelve la cadena completa internamente:
busca en `Informes_Revision` por `Nro_Solicitud_Externo`, lee el `Creator_Analisis_ID` (id del Análisis
en Cardoc 360) y genera/streamea el PDF. **El consumidor nunca ve el id interno ni ninguna URL de WorkDrive.**

> Disponible **una vez aprobado el análisis** y vinculado en el CRM (§3.4). Antes de eso → `404`.

### 8.1 Request

- Path param `{nroSolicitud}` — el mismo del alta (Endpoint 1).
- Header `X-Api-Key` (oblig.).

### 8.2 Respuesta de éxito — `200 OK` (binario)

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="NombreCliente_IDInterno_Fecha.pdf"
Cache-Control: no-store
```

El cuerpo es el PDF binario (ver §3.5 para la nomenclatura).

### 8.3 Errores

| HTTP | code | Cuándo |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Sin `X-Api-Key` o token inválido. |
| 403 | `FORBIDDEN_SCOPE` | El token no tiene `reports:pdf`. |
| 404 | `NOT_FOUND` | El `NroSolicitud` no tiene informe disponible (aún no aprobado, inexistente, o ajeno). |
| 404 | `PDF_NOT_AVAILABLE` | El informe existe pero su PDF no está disponible. |
| 429 | `CAP_EXCEEDED` | Límite de uso excedido. |
| 502 | `UPSTREAM_ERROR` | Falla al obtener/transmitir desde Cardoc 360 / WorkDrive. |

### 8.4 Ejemplo

```bash
curl -i "{{BASE_URL}}/v1/informes/solicitud/908812/pdf" \
  -H "X-Api-Key: {{API_TOKEN}}" \
  -o informe-908812.pdf
```

---

## 9. Runbook — Test end-to-end

Recorré el ciclo completo con **un mismo `NroSolicitud`** (elegí uno único, p. ej. `908812`).

### Prerrequisitos

- [ ] `GET /v1/health` responde `200`.
- [ ] `{{API_TOKEN}}` (token del consumidor, con los 3 scopes).
- [ ] `{{INTERNAL_SECRET}}` (shared-secret del botón).
- [ ] Acceso a Zoho CRM (para avanzar el Deal / pulsar el botón) y a Cardoc 360 (para aprobar el análisis).

### Pasos

| # | Actor | Acción | Resultado esperado |
|---|---|---|---|
| 1 | 🟦 ML | `POST /v1/opportunity-contact` (§6.5) | `201 created`. Anotá `contact.id`, `opportunity.id`, `nroSolicitud`. |
| 2 | 🟨 Cardoc | Verificar en CRM la Oportunidad con Stage `Nueva Solicitud` y el Contacto bajo la Cuenta "ML". | Deal visible; `NroSolicitud` como llave externa. |
| 3 | 🟨 Cardoc | Avanzar el Deal a `Agendado B2B` y pulsar **"Notificar a ML"**. | `200 { status: "sent", estado: "COORDINACIÓN" }`. ML refleja `COORDINACIÓN`. |
| 4 | 🟧 Cardoc 360 | Realizar y **aprobar** el análisis. | El `Creator_Analisis_ID` queda vinculado en `Informes_Revision`. |
| 5 | 🟨 Cardoc | Avanzar el Deal a `Completado` y notificar con `linkResultado` (§7.2). | `200 { status: "sent", estado: "FINALIZADO" }`. |
| 6 | 🟦 ML | `GET /v1/informes/solicitud/{nroSolicitud}/pdf` (§8.4). | `200 application/pdf`; el archivo abre y corresponde a la inspección. |

### Casos de borde a validar

- **Idempotencia:** repetir el paso 1 con el mismo body → `200 duplicate`; mismo `X-Idempotency-Key`
  con body distinto → `409`.
- **Reutilización por cédula:** un alta con una cédula ya existente → `contact.reused: true`.
- **PDF prematuro:** `GET .../pdf` **antes** del paso 4 → `404`.
- **No divulgación:** pedir un `NroSolicitud` que no corresponde → `404` (no `403`).
- **Validación:** `POST` con una clave extra → `400`.
- **Estado no notificable:** notificar con `stage: "Cancelado"` → `200 skipped`.

---

## 10. Semántica transversal

### 10.1 Sobre de error único

**Todos** los errores tienen la misma forma. Programá contra `code` (estable), no contra el HTTP:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "payload inválido",
    "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "details": { "fields": { "NroSolicitud": ["Required"] } }
  }
}
```

`correlationId` identifica el request en los logs — **inclúilo siempre al reportar un problema.**

### 10.2 Catálogo de códigos

| HTTP | code | Significado |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body inválido / campo faltante / clave no permitida. |
| 401 | `UNAUTHENTICATED` | Credencial ausente o inválida. |
| 403 | `FORBIDDEN_SCOPE` | El token no tiene el permiso requerido (único caso de 403). |
| 404 | `NOT_FOUND` | Recurso inexistente o ajeno (no divulgación, §3.7). |
| 404 | `PDF_NOT_AVAILABLE` | Informe sin PDF disponible. |
| 409 | `IDEMPOTENCY_CONFLICT` | Misma clave de idempotencia con payload distinto. |
| 422 | `UNPROCESSABLE` | Invariante de negocio no cumplido. |
| 429 | `CAP_EXCEEDED` | Límite de uso excedido (`Retry-After` + `X-Cap-*`). |
| 502 | `UPSTREAM_ERROR` | Falla de un sistema upstream (CRM / Creator / WorkDrive / ML). |
| 500 | `INTERNAL_ERROR` | Error no clasificado. |

---

## 11. Soporte

Ante cualquier bloqueo, contactá a **Unicorp Systems** con: el `code` del error, el `correlationId`
de la respuesta, el `NroSolicitud` y el paso del runbook (§9) en el que ocurrió.

---

*Documento preparado por Unicorp Systems · Confidencial (uso interno Cardoc) · Entorno Development · v2.0 · 2026-07-03.*
