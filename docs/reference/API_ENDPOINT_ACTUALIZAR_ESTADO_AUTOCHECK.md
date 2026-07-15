# API Endpoint: Actualizar Estado AutoCheck

| Versión | Última actualización | Aplicación |
|---|---|---|
| 1.1 | Julio 2026 | TuAuto - Gestión de AutoCheck |

## Endpoints

### Producción

```text
https://www.mlcenter.com.uy/apimiauto/api/autocheck/estado/actualizar
```

### Testing

```text
https://www.mlcenter.com.uy/ApiMiAutoTesting/api/autocheck/estado/actualizar
```

## Descripción

```http
POST /api/autocheck/estado/actualizar
```

Actualiza el estado de una solicitud AutoCheck aplicando una máquina de estados estricta. Cada cambio de estado genera un registro histórico en la base de datos. Registra información del técnico y de la empresa que realiza la inspección.

## Autenticación

| Aspecto | Valor |
|---|---|
| Requerida | Sí |
| Tipo | JWT Bearer Token |
| Duración | 3600 segundos (1 hora) |

### Obtener token

```http
POST /api/login/authenticatecardoc
Content-Type: application/json
```

```json
{
  "Usuario": "<usuario>",
  "Password": "<contraseña>"
}
```

### Usar token

Incluir en cada solicitud:

```http
Authorization: Bearer <token>
```

## Request

### Headers

```http
Content-Type: application/json
Authorization: Bearer <token>
```

### Parámetros

| Parámetro | Tipo | Requerido | Máximo | Descripción |
|---|---|---|---|---|
| `NroSolicitud` | `long` | Sí | - | ID de la solicitud a actualizar |
| `Estado` | `string` | Sí | 50 caracteres | Nuevo estado: `COORDINACIÓN`, `FINALIZADO` |
| `LinkResultado` | `string` | Condicional | 500 caracteres | URL del resultado; obligatorio si `Estado = FINALIZADO` |
| `NombreTecnico` | `string` | Sí | 100 caracteres | Nombre del técnico que realiza el chequeo |
| `Empresa` | `string` | Sí | 100 caracteres | Nombre de la empresa que realiza el chequeo |
| `Observaciones` | `string` | No | 500 caracteres | Notas adicionales |

### Ejemplo

```bash
curl -X POST "https://www.mlcenter.com.uy/apimiauto/api/autocheck/estado/actualizar" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGc..." \
  -d '{
    "NroSolicitud": 908812,
    "Estado": "COORDINACIÓN",
    "NombreTecnico": "Juan García",
    "Empresa": "Inspecciones XYZ",
    "Observaciones": "Iniciando coordinación"
  }'
```

## Respuestas

### 200 OK - Éxito

```json
{
  "mensaje": "Estado actualizado con éxito.",
  "nroSolicitud": 908812,
  "estado": "COORDINACIÓN"
}
```

### 400 Bad Request - Campos obligatorios faltantes

```json
{
  "codigo": 400,
  "mensaje": "Los datos enviados no son válidos o están incompletos.",
  "detalles": [
    "El número de solicitud es obligatorio.",
    "El estado es obligatorio.",
    "El nombre técnico es obligatorio.",
    "El nombre de empresa es obligatorio."
  ]
}
```

### 400 Bad Request - Mismo estado

```json
{
  "codigo": 400,
  "mensaje": "No se pudo actualizar el estado",
  "detalles": [
    "La solicitud ya está en estado 'Coordinación'. No se puede actualizar al mismo estado."
  ]
}
```

### 401 Unauthorized

```json
{
  "Message": "Se ha denegado la autorización para esta solicitud."
}
```

## Máquina de estados

```text
PENDIENTE
    ↓
COORDINACIÓN
    ↓
FINALIZADO
```

## Reglas de transición

| Estado actual | Puede cambiar a | Requiere |
|---|---|---|
| `PENDIENTE` | `COORDINACIÓN` | - |
| `COORDINACIÓN` | `FINALIZADO` | `LinkResultado` |
| `FINALIZADO` | Ninguno | - |

## Casos de uso

### Caso 1: Cambiar de PENDIENTE a COORDINACIÓN

#### Request

```http
POST /api/autocheck/estado/actualizar HTTP/1.1
Host: www.mlcenter.com.uy
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

{
  "NroSolicitud": 908812,
  "Estado": "COORDINACIÓN",
  "NombreTecnico": "Juan García",
  "Empresa": "Inspecciones XYZ",
  "Observaciones": "Iniciando coordinación"
}
```

#### Response

```json
{
  "mensaje": "Estado actualizado con éxito.",
  "nroSolicitud": 908812,
  "estado": "COORDINACIÓN"
}
```

## Notas importantes

- **Validación de estado:** solo se aceptan los estados definidos en la máquina de estados.
- **`LinkResultado` obligatorio:** cuando `Estado = "FINALIZADO"`, `LinkResultado` es obligatorio.
- **Campos nuevos (v1.1):** `NombreTecnico` y `Empresa` son campos obligatorios desde esta versión.
- **Prevención de duplicados:** no se puede actualizar una solicitud al mismo estado en el que ya está.
- **Token:** el token expira después de 3600 segundos. Obtener uno nuevo si es necesario.

---

*Documento generado: julio de 2026.*
