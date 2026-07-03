---
title: Guía de integración — API cardoc para ML / AutoCheck
document_type: entregable-cliente
audience: ML / AutoCheck (mlcenter.com.uy)
environment: Development (Catalyst)
status: para-validación
version: 1.0
date: 2026-07-03
owner: Unicorp Systems
---

# API cardoc — Guía de integración para ML / AutoCheck

Esta guía cubre **todo lo que ML necesita** para integrarse con cardoc. Son **tres cosas**:

1. **Crear una solicitud** de inspección (ML → cardoc).
2. **Recibir las notificaciones** de cambio de estado (cardoc → ML).
3. **Obtener el PDF** del informe cuando la inspección finaliza (ML → cardoc).

No necesitás conocer nada del back-office de Cardoc (CRM, Cardoc 360): cardoc lo resuelve por
detrás. Esta guía es tu contrato completo.

```
   ML / AutoCheck                         cardoc (API)
        │                                     │
  (1)   │  POST /v1/opportunity-contact  ───► │   crea la solicitud
        │  ◄─── 201 { nroSolicitud, ... }     │
        │                                     │
  (2)   │  ◄─── POST tu endpoint AutoCheck ── │   te avisa cada cambio de estado
        │   (PENDIENTE/COORDINACIÓN/FINALIZADO)│  (PENDIENTE → COORDINACIÓN → FINALIZADO + link)
        │                                     │
  (3)   │  GET /v1/informes/solicitud/{nro}/pdf ► │   te entrega el PDF del informe
        │  ◄─── 200 application/pdf           │
```

Todo gira alrededor del **`NroSolicitud`**: es el número que elegís al crear la solicitud y con
el que después recibís las notificaciones y descargás el PDF.

---

## 1. Conexión y autenticación

| | |
|---|---|
| **Base URL (Development)** | `https://ml-909785950.development.catalystserverless.com/server/api` |
| **Autenticación** | Header `X-Api-Key: <token>` en cada request. |
| **Formato** | JSON (`Content-Type: application/json`). |

> El **token** (`X-Api-Key`) lo provee Unicorp. Es secreto: no lo publiques ni lo compartas por
> canales inseguros. En esta guía se lo referencia como `{{API_TOKEN}}` y a la Base URL como
> `{{BASE_URL}}`.
>
> ⚠️ Confirmá la URL de invocación exacta con Unicorp antes de empezar (es un entorno de
> Development; aún no hay producción).

Probá la conexión (endpoint abierto, sin token):

```bash
curl -i {{BASE_URL}}/v1/health
# → 200 { "status": "ok", "service": "api" }
```

Cada respuesta trae un header `X-Correlation-Id` (id de trazabilidad). **Guardalo**: es lo que
pedimos para diagnosticar cualquier problema.

---

## 2. Crear la solicitud

`POST /v1/opportunity-contact`

Da de alta la solicitud de inspección con los datos del cliente y del vehículo.

### 2.1 Request

Headers: `X-Api-Key` · `Content-Type: application/json` · `X-Idempotency-Key` (opcional, ver §2.4).

```jsonc
{
  "NroCedula":            45321890,               // requerido — cédula del cliente
  "NroSolicitud":         908812,                 // requerido, único — tu número de solicitud
  "Nombres":              "Juan Carlos",          // requerido
  "Apellidos":            "Pérez Rodríguez",      // requerido
  "CelularCliente":       "099123456",            // opcional
  "Sucursal":             "Centro Montevideo",    // opcional
  "DepartamentoSucursal": "Montevideo",           // opcional
  "CiudadSucursal":       "Montevideo",           // opcional
  "DireccionSucursal":    "Av. 18 de Julio 1234", // opcional
  "MarcaVehiculo":        "Chevrolet",            // opcional
  "ModeloVehiculo":       "Onix",                 // opcional
  "AnioVehiculo":         2022,                    // opcional
  "MatriculaVehiculo":    "SBA1234"               // opcional
}
```

**Reglas:**
- Requeridos: `NroCedula`, `NroSolicitud`, `Nombres`, `Apellidos`. El resto es opcional.
- `NroSolicitud` debe ser **único**: es la llave de toda la integración.
- Enviá **sólo** estos campos. Cualquier clave extra devuelve `400`.

### 2.2 Respuestas

| HTTP | Significado |
|---|---|
| `201 Created` | Solicitud creada (`status: "created"`). |
| `200 OK` | Ya existía ese `NroSolicitud` — reintento seguro (`status: "duplicate"`). |
| `202 Accepted` | En proceso por otro envío concurrente (`status: "in_progress"`). |

```json
// 201 Created
{
  "status": "created",
  "nroSolicitud": 908812,
  "contact":     { "id": "ct_001", "reused": false },
  "opportunity": { "id": "op_001", "stage": "Nueva Solicitud" },
  "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

### 2.3 Errores frecuentes

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Falta un campo requerido o hay una clave no permitida. |
| 401 | `UNAUTHENTICATED` | Token ausente o inválido. |
| 429 | `CAP_EXCEEDED` | Superaste el límite de uso (ver §5). Reintentá tras `Retry-After`. |

### 2.4 Reintentos seguros (idempotencia)

Para poder reintentar sin duplicar, agregá `X-Idempotency-Key: <valor-único-por-solicitud>`. Un
reintento exacto devuelve `200 duplicate`; la misma clave con un cuerpo distinto devuelve `409`.
Sin el header, igual deduplicamos por `NroSolicitud`.

### 2.5 Ejemplo

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

## 3. Recibir las notificaciones de estado

A medida que la inspección avanza, **cardoc llama a tu endpoint de AutoCheck** ("Actualizar
Estado"). No tenés que consultar nada: las notificaciones llegan solas (*push*).

### 3.1 Tu endpoint (el que cardoc invoca)

| | |
|---|---|
| **Testing** | `POST https://www.mlcenter.com.uy/ApiMiAutoTesting/api/autocheck/estado/actualizar` |
| **Producción** | `POST https://www.mlcenter.com.uy/apimiauto/api/autocheck/estado/actualizar` |
| **Autenticación** | cardoc se loguea en `POST {base}/api/login/authenticatecardoc` con `{ Usuario, Password }` → `{ Status: "OK", Token }` (JWT, ~1 h) y luego llama con `Authorization: Bearer <token>`. |

> **Lo que ML debe proveer:** el `Usuario` y `Password` de `authenticatecardoc` para que cardoc
> se autentique. Se los pasás a Unicorp; se cargan como secreto en cardoc (no viajan en el repo).

### 3.2 Payload que cardoc te envía

```jsonc
{
  "NroSolicitud":  908812,                                  // el mismo de §2
  "Estado":        "FINALIZADO",                            // "PENDIENTE" | "COORDINACIÓN" | "FINALIZADO"
  "LinkResultado": "{{BASE_URL}}/v1/informes/solicitud/908812/pdf", // sólo en FINALIZADO
  "Observaciones": "Inspección sin observaciones"           // opcional
}
```

### 3.3 Cuándo y qué estados

| Momento de la inspección | `Estado` que recibís | Incluye `LinkResultado` |
|---|---|---|
| Solicitud creada (inicial) | `PENDIENTE` | No |
| Se agenda / coordina la inspección | `COORDINACIÓN` | No |
| El informe está listo y aprobado | `FINALIZADO` | **Sí** — la URL del PDF (§4) |

Máquina de estados: `PENDIENTE → COORDINACIÓN → FINALIZADO` (terminal). cardoc te notifica los tres:
`PENDIENTE` al crearse la solicitud (stage `Nueva Solicitud`), `COORDINACIÓN` al agendarse, y
`FINALIZADO` al cerrarse (con `LinkResultado`).

> **Importante — `LinkResultado`.** Es la **URL del PDF del informe** (el endpoint de §4). Es un
> enlace **autenticado**: para descargarlo necesitás tu `X-Api-Key`, igual que en §4. No es un link
> público. *(Punto a confirmar entre ML y Cardoc: si tu flujo requiere un enlace público en su lugar,
> avisanos antes del arranque.)*

---

## 4. Obtener el PDF del informe

`GET /v1/informes/solicitud/{nroSolicitud}/pdf`

Descarga el **PDF completo del informe de inspección** usando tu `NroSolicitud`. No necesitás
ningún id interno: cardoc resuelve el informe por vos.

### 4.1 Request

- Path param `{nroSolicitud}` — el mismo número que usaste en §2.
- Header `X-Api-Key`.

### 4.2 Respuesta

`200 OK` con el PDF binario:

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="NombreCliente_IDInterno_Fecha.pdf"
```

El PDF contiene el informe con todos los detalles de la inspección (datos del vehículo, checklist,
observaciones y fotos del análisis realizado en Cardoc 360).

### 4.3 Errores

| HTTP | code | Cuándo |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Token ausente o inválido. |
| 404 | `NOT_FOUND` | El `NroSolicitud` no tiene un informe disponible (aún no finalizó, o no existe). |
| 404 | `PDF_NOT_AVAILABLE` | El informe existe pero su PDF no está disponible. |
| 429 | `CAP_EXCEEDED` | Límite de uso excedido. |

> Este endpoint sólo devuelve el PDF **después** de que la inspección finaliza. En la práctica lo
> vas a llamar cuando recibís la notificación `FINALIZADO` (§3) — que además te trae la URL exacta
> en `LinkResultado`.

### 4.4 Ejemplo

```bash
curl -i "{{BASE_URL}}/v1/informes/solicitud/908812/pdf" \
  -H "X-Api-Key: {{API_TOKEN}}" \
  -o informe-908812.pdf
```

---

## 5. Detalles transversales

### 5.1 Sobre de error

Todos los errores tienen la misma forma. Programá contra `code`, no contra el HTTP:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "payload inválido",
    "correlationId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

Al reportar un problema, mandanos el `code`, el `correlationId` y el `NroSolicitud`.

### 5.2 Límites de uso

Cada endpoint tiene un tope por hora/día/semana. Al excederlo devolvemos `429 CAP_EXCEEDED` con el
header `Retry-After` (segundos a esperar). Topes por hora acordados: crear solicitud = **60**,
descargar PDF = **100**.

---

## 6. Checklist de arranque

- [ ] Recibiste de Unicorp: `{{BASE_URL}}` confirmada y `{{API_TOKEN}}`.
- [ ] Le pasaste a Unicorp el `Usuario`/`Password` de `authenticatecardoc` (para las notificaciones).
- [ ] Tu endpoint AutoCheck `estado/actualizar` está operativo en testing.
- [ ] Prueba E2E: crear solicitud (§2) → recibir `PENDIENTE`, `COORDINACIÓN` y `FINALIZADO` (§3) → bajar el PDF (§4).

---

*Documento preparado por Unicorp Systems · Entorno Development · v1.0 · 2026-07-03.*
