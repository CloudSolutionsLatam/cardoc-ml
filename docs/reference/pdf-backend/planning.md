# Feature: pdf-backend

> **📌 Nota as-built en cardoc-ml (2026-07-01):** este spec es la **fuente de verdad del
> contrato de datos, reglas de negocio y layout** (§4/§5), y sigue vigente como tal. PERO el
> **motor de render** en cardoc-ml es **pdf-lib** (JS puro), **no** headless Chromium — ver
> [ADR-0012](../../decisions/README.md#adr-0012). cardoc-ml es el **generador único** del PDF y ya
> reconstruye el informe de forma fiel (transform portado a Node + `PdfLibReportGenerator`). No
> integrar Puppeteer/Playwright. El circuito §6 (Chromium) es el plan original del portal, superado.

> **Tipo:** planning (operativo) + spec cross-project embebida.
> **Estado (en cardoc-ml):** motor pdf-lib implementado (slice E-03: genera el informe real con datos de muestra; read de Creator pendiente).
> **Owner:** Equipo Unicorp Systems.
> **Fecha de inicio:** 2026-07-01.
> **Motor de render backend:** ~~headless Chromium (Puppeteer/Playwright)~~ → **pdf-lib en Catalyst** (ADR-0012).

> ⚠️ **Este documento es autocontenido a propósito.** El proyecto backend (Catalyst) **no tiene acceso a este repo**. Todo lo que necesita para reproducir el PDF —contrato de datos, reglas de negocio, código verbatim de cada pieza del circuito, CSS de impresión y el logo como data-URI— está embebido acá. No hay que abrir ningún `.vue` ni `.js` del portal.

---

## Objetivo

Mover la generación del PDF del informe **del navegador al backend**. Hoy el PDF se produce con impresión nativa (`window.print()` + `@media print`) sobre el DOM del cliente. La feature expone un endpoint/función en **Zoho Catalyst (Node)** que, dado un `reportId`, devuelve el PDF (o su URL en WorkDrive) renderizado server-side con **fidelidad 1:1** respecto al PDF actual.

## Alcance

### Lo que entra
1. Función Catalyst (Node) que: obtiene los datos del informe (misma Custom API o consulta directa a Análisis, con filtro `portalType` server-side), aplica la **misma normalización** que [`reportTransform.js`](../../../src/services/transforms/reportTransform.js), renderiza el **mismo HTML/CSS** de [`InformePdfTemplate.vue`](../../../src/components/informes/InformePdfTemplate.vue) en headless Chromium y produce el PDF A4.
2. Contrato de datos **autoritativo** (§4) — reemplaza el JSDoc incompleto del transform.
3. El HTML/CSS del documento re-authored como **plantilla standalone** (des-scopeada, sin Vue, sin Tailwind), con el logo embebido.
4. Frontend: el botón "Descargar PDF" pasa a llamar a la función Catalyst en vez de `window.print()` (cambio menor, fuera del camino crítico de esta spec).

### Lo que NO entra (anti-objetivos)
- **Embeber audio/video** en el PDF. Igual que hoy: se muestra un placeholder ("disponible en la versión digital"). Ver §6.
- **Editar datos.** El portal/backend de PDF **nunca escribe** en Zoho. Solo lee y renderiza.
- **Cambiar el diseño.** Es una migración de motor, no un rediseño. El PDF debe salir idéntico.
- **Tocar el listado** (`GET_INSPECTIONS_REPORT`) ni el flujo de auth. Solo el detalle → PDF.
- **Reproducir la vista previa paginada** (`paginarPreview`). Es UI-only del portal; el backend no la necesita.

---

## Contexto: por qué backend

El PDF actual depende del navegador del cliente (diálogo nativo "Guardar como PDF", esperar carga de fotos, `print-color-adjust`). Mover a backend da: generación consistente e independiente del browser/OS del cliente, posibilidad de adjuntar el PDF a un email/WorkDrive automáticamente, y un único punto de verdad del documento. Catalyst + headless Chromium es el encaje correcto porque **reutiliza el mismo HTML/CSS** que ya existe → fidelidad 1:1, sin rehacer el diseño en una herramienta de merge.

---

## El circuito actual (mapa de 4 etapas)

```
[1] ORIGEN                 [2] TRANSFORM              [3] PLANTILLA HTML        [4] RENDER → PDF
GET_INSPECTION_        →   transformReportData    →   InformePdfTemplate    →   window.print()
REPORT_DETAIL              (reportTransform.js)       (portada + secciones)     + @media print
(get_inspection_report.dg) + defense-in-depth                                   + preview modal
     │                          │                          │                        │
  JSON crudo               objeto `informe`          DOM en #print-root         diálogo nativo
  {code:3000, result}      (shape estable)           (off-screen)               "Guardar como PDF"
```

**Qué reproduce el backend:** etapas [2], [3] y [4] server-side. La etapa [1] (los datos) ya existe — se reutiliza. El **origen de verdad visual** es la etapa [3] + el CSS de impresión de la etapa [4] (que hoy vive en otro archivo, ver §5.6).

Flujo detallado del frontend hoy:
1. [`DetallesInforme.vue`](../../../src/views/DetallesInforme.vue) → `Api.fetchVehicleReport(reportId)` invoca la Custom API `GET_INSPECTION_REPORT_DETAIL`.
2. Se valida el envelope (`code === 3000`), se corre `shouldRejectDetailByPortalType(result, 'ml')` (defense-in-depth) y se normaliza con `transformReportData(result)` → objeto `informe`.
3. `informe` alimenta **dos** instancias de `InformePdfTemplate`: el `#print-root` off-screen (para imprimir) y el template oculto del preview.
4. `imprimirNativo()` espera las fotos (`waitImages()`) y llama `window.print()`. Las reglas `@media print` ocultan la app y revelan `#print-root`.

---

## 4. Contrato de datos (AUTORITATIVO)

> El JSDoc de `reportTransform.js` (que verás embebido en §5.2) **está incompleto**: omite `recomendaciones`, `score`, `score_comentario` y `evidence.nombreArchivo`. **Usá esta sección, no ese comentario.**

### 4.1 Envelope de respuesta

- El transport es una Custom API de Zoho Creator invocada con **token como query param** (no header): `id={reportId}&token={token}&portalType=ml`.
- La respuesta cruda es `{ code: 3000, result: { ...informe... } }`. **El transform se alimenta de `response.result`, no de `response`.** Cualquier otro `code` cae en la rama de error del portal.
- `response.result.status === 401 && response.result.error === 'UNAUTHORIZED'` dispara logout.
- `result` puede traer un `portalType` top-level; si está presente **debe** ser `'ml'` o el frontend bloquea el informe. El filtro primario es **server-side** (ver §7).

### 4.2 Shape de entrada completo (`result` / `apiData`)

```
{
  code:                string,   // código humano del informe (ej. "#R-12345"). → reportCode e id. Ausente → ""
  recomendaciones:     string,   // ⚠️ NO está en el JSDoc. Mueve la sección "Recomendaciones del Inspector"
  score:               number,   // 0–10. ⚠️ 0 ES VÁLIDO. "" / null / ausente = "no cargado" (oculta la sección)
  score_comentario:    string,   // comentario del puntaje. "" = sin texto (el número igual se muestra)
  summary_audio:       string,   // URL audio resumen (WorkDrive). NO se usa en el PDF (sí en el portal)
  transcription_audio: string,   // transcripción. Gateada por feature flag (§8). "" → tratado como ausente
  portalType:          string,   // 'ml' | 'cardoc'. Discriminador (§7)
  vehicle: {
    marca: string, modelo: string, año: string,   // ⚠️ "año" con Ñ+tilde, literal
    matricula: string,   // → OUTPUT "placa". Ausente → "Sin matrícula"
    kms: number,         // número CRUDO sin unidad; el front le agrega " km"
    motor: string, transmision: string,
    image: string        // URL. → OUTPUT "imagen". NO se usa en el PDF (sí en el portal)
  },
  inspector: {
    name: string,        // → inspector.nombre. Ausente → "Inspector"
    fecha: string,       // ⚠️ string YA formateado (ej "dd/mm/yyyy"). El front NO formatea fechas
    telefono: string     // NO se usa en el PDF
  },
  inspection_agency: { name: string },   // el front arma "Inspector @ {name}". Ausente → "Inspector" sin sufijo
  cliente: {             // ⚠️ DEUDA BACKEND (§7): hoy get_inspection_report.dg NO lo expone
    nombre: string,      // desde Analisis.clienteNombre
    telefono: string     // desde Analisis.clienteTelefono
  },
  modulos: [             // ⚠️ anidamiento OBLIGATORIO de 3 niveles
    {
      name: string,      // → seccion.titulo (1 módulo = 1 sección). Ausente → "Sin título"
      sub_modulos: [     // los components viven ACÁ, nunca directo bajo el módulo
        {
          name: string,
          components: [
            {
              id: string,             // id estable del componente (para damage map; no lo usa el PDF)
              name: string,
              description: string,    // NO cae a status.label (nunca mostrar "bueno" como descripción)
              status: { name: string, label: string },   // ver vocabulario §4.3. label NO se lee
              ai_summary: string,
              inspector_note: string,
              evidences: [
                {
                  type: string,          // 'foto' | 'audio' | 'video' | 'ocr' (§4.3)
                  resource: string,      // URL WorkDrive (vacío en OCR y a veces en video)
                  note: string,          // nunca se lee
                  nombreArchivo: string  // ⚠️ NO está en el JSDoc. Nombre con extensión (video/OCR)
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### 4.3 Vocabularios controlados (tokens EXACTOS, lowercase snake)

El transform hace `switch` sobre estos strings literales. Un valor distinto (`'warning'`, `'bad'`, `'photo'`, `'document'`, capitalizado o localizado) **no rompe con error**: mapea todo a verde/aprobado y no descarta nada. **Silencioso y peligroso.**

**`status.name`:**

| Valor backend | `estado` interno | Color borde izq. | Efecto extra |
|---|---|---|---|
| `advertencia` | `observacion` | ámbar `#d97706` | — |
| `malo` | `critico` | rojo `#dc2626` | — |
| `sin_evaluar` | — | — | **componente DESCARTADO** (no se renderiza) |
| `bueno` / cualquier otro / null | `aprobado` | verde `#16a34a` | — |

**`evidence.type`:**

| Valor | Bucket | Requiere `resource` no vacío |
|---|---|---|
| `foto` | `imagenes` (solo la URL) | Sí (si vacío, se descarta) |
| `audio` | `audioData` (objeto completo) | Sí |
| `video` | `videoData` (objeto completo) | **No** (se conserva sin resource; el portal muestra "no disponible") |
| `ocr` | `pdfData` (PDF/doc de Archivos_Staging) | Sí |

### 4.4 Do-not-guess: claves que rompen en silencio

Un dev sin acceso al repo no puede inferir esto; cada error produce **contenido faltante sin error**:

1. **`vehicle.año`** — clave literal con Ñ y tilde. No es `anio` ni `year`. Mal → año en blanco en la portada.
2. **Renombres solo en OUTPUT** — el input mantiene: `matricula` (no `placa`), `image` (no `imagen`), `kms` como número **sin** `" km"` (el front agrega la unidad), `inspection_agency.name` como nombre pelado (el front arma `"Inspector @ {name}"`).
3. **Anidamiento 3 niveles** — `modulos[].sub_modulos[].components[]`. Aplanar los components sobre el módulo → **cero detalles** (el transform solo itera `modulo.sub_modulos`).
4. **`score = 0` es válido** — enviarlo como número `0`. Coalescerlo a `null`/`""`/omitirlo (instinto de "limpiar el payload") **oculta toda la sección Puntaje**. El gate es `score != null`, nunca truthy.
5. **`recomendaciones`, `score`, `score_comentario`, `nombreArchivo`** no están en el JSDoc del transform — hay que exponerlos igual.

### 4.5 Reglas de negocio del transform (verificadas contra tests)

- **estado:** ver tabla §4.3.
- **`sin_evaluar` skip:** componente con `status.name === 'sin_evaluar'` se omite entero.
- **sub_modulo vacío skip:** `if (!subModulo.components?.length) return`.
- **`tituloJerarquico`** (único título que muestra el PDF por componente): `[modulo.name, subModulo.name, componente.name]` → trim cada uno → drop vacíos → **colapsar duplicados CONSECUTIVOS** (`i===0 || p !== arr[i-1]`) → join `" - "` → fallback `"Sin nombre"`. Ej: `"2- CHASIS - FRENTE - Chasis delantero izquierdo"`.
- **Fallbacks `''` vs `null` vs literal:** campos de vehículo → `''` (nunca "N/A"), salvo `placa` → `"Sin matrícula"` y `kilometraje` → `''` (con `" km"` solo si hay valor). `recomendaciones`/`descripcion`/`nota`/`aiSummary`/`resumenAudio`/`resumenTranscripcion` → `null`. `score_comentario` → `''`. `inspector.nombre`/`cargo` → `"Inspector"`, `iniciales` vía `getInitials` (fallback último `"IC"`).
- **`detalle.id`:** contador 1-based corrido en todo el informe (no es id de backend). El id real del componente va en `componenteId`.
- **evidence bucketing:** ver §4.3.
- **`getInitials(name)`:** 2+ palabras → iniciales de las 2 primeras; 1 palabra → primeras 2 letras; vacío → `"IC"`.

### 4.6 Mapeo entrada → salida (referencia rápida)

| Input (`apiData`) | Output (`informe`) | Consumido por el PDF |
|---|---|:---:|
| `code` | `id`, `reportCode` | ✅ portada + pie |
| `recomendaciones` | `recomendaciones` | ✅ sección |
| `score` | `score` | ✅ sección (gate `!= null`) |
| `score_comentario` | `score_comentario` | ✅ |
| `transcription_audio` | `resumenTranscripcion` | ✅ (flag §8) |
| `summary_audio` | `resumenAudio` | ❌ (portal only) |
| `vehicle.marca/modelo/año` | `vehiculo.marca/modelo/año` | ✅ portada |
| `vehicle.matricula` | `vehiculo.placa` | ✅ |
| `vehicle.kms` | `vehiculo.kilometraje` (`+ " km"`) | ✅ |
| `vehicle.motor/transmision` | idem | ✅ |
| `vehicle.image` | `vehiculo.imagen` | ❌ (portal only) |
| `inspector.name` | `inspector.nombre` + `iniciales` | ✅ (iniciales ❌) |
| `inspector.fecha` | `fechaInspeccion` (top-level) | ✅ |
| `inspection_agency.name` | `inspector.cargo` (`"Inspector @ …"`) | ✅ |
| `cliente.nombre/telefono` | `cliente.nombre/telefono` | ✅ portada |
| `modulos[].name` | `secciones[].titulo` | ✅ título sección |
| `…components[]` | `detalles[]` | ✅ tarjetas |

---

## 5. Código embebido (verbatim del portal)

> Copiado tal cual del repo. Esta es la fuente de verdad; el backend lo porta a Node / HTML standalone.

### 5.1 `src/services/api.js` — invoker + contrato portalType

```js
import { AuthService } from './auth.js'

/**
 * Discriminador del portal — el backend usa este valor para filtrar qué
 * registros del módulo Análisis se devuelven. Portal ML solo debe ver
 * análisis marcados como flujo ML. Este flag viaja en query_params
 * (`portalType=ml`) en cada lectura de datos del módulo Análisis.
 *
 * Contrato con backend (Deluge):
 *  - GET_INSPECTIONS_REPORT y GET_INSPECTION_REPORT_DETAIL deben leer
 *    `input.portalType` y aplicarlo como filtro en la query del módulo
 *    Análisis (campo `Analisis.portalType`).
 *  - Si el campo discriminador aún no existe en Análisis, el backend
 *    DEBE fallar cerrado (devolver listado vacío / 404) en lugar de
 *    exponer registros no marcados.
 *  - Ver docs/specifications/portal-type.md y docs/runbooks/portal-type.md
 *    para el contrato completo. Nomenclatura: camelCase alineado a la
 *    convención de cardoc-360 (ver docs-cardoc-360/zoho-creator-forms/README.md).
 */
export const PORTAL_TYPE = 'ml'

/**
 * API Service Layer
 *
 * Servicio para gestionar todas las llamadas al SDK privado de ZOHO Creator.
 * Cada método invoca una Custom API del sistema ZOHO.
 */
export class Api {
  /**
   * Valida el código OTP para autenticación
   * @param {string} code - Código OTP de 6 dígitos
   * @returns {Promise} Respuesta de la API con el resultado de validación
   */
  static async validateOtp(code) {
    return await ZOHO.CREATOR.DATA.invokeCustomApi({
      api_name: 'cardoc_validate_otp',
      http_method: 'POST',
      content_type: 'application/json',
      payload: { otp_code: code },
    })
  }

  /**
   * Valida las credenciales del usuario y retorna un token de autenticación
   * @param {string} id - UID del usuario
   * @param {string} authType - Tipo de autenticación ('code' para OTP, 'psw' para password)
   * @param {string} credential - Credencial (código OTP o contraseña)
   * @returns {Promise} Respuesta de la API con el token si es exitoso
   */
  static async authValidation(id, authType, credential, userName = '') {
    return await ZOHO.CREATOR.DATA.invokeCustomApi({
      api_name: 'AUTH_VALIDATION',
      http_method: 'POST',
      content_type: 'application/json',
      public_key: import.meta.env.VITE_ZOHO_KEY_AUTH_VALIDATION,
      payload: {
        id: id,
        auth_type: authType,
        credential: credential,
        user_name: userName,
      },
    })
  }

  /**
   * Envía un nuevo código OTP al usuario
   * @param {string} uid - UID del usuario
   * @returns {Promise} Respuesta de la API
   */
  static async sendCodeOtp(uid) {
    return await ZOHO.CREATOR.DATA.invokeCustomApi({
      api_name: 'send_code_otp',
      http_method: 'POST',
      content_type: 'application/json',
      public_key: import.meta.env.VITE_ZOHO_KEY_SEND_OTP,
      payload: { id: uid },
    })
  }

  /**
   * Verifica si la respuesta de una API indica que el token expiró
   * @param {Object} response - Respuesta de la API
   * @returns {Object} La misma respuesta si el token es válido
   * @throws {Error} Si el token es inválido o expiró
   */
  static checkTokenExpiration(response) {
    // Las APIs de datos retornan 401 cuando el token expira
    // La estructura es: { result: { status: 401, error: "UNAUTHORIZED", message: "..." }, code: 3000 }
    if (response.result?.status === 401 && response.result?.error === 'UNAUTHORIZED') {
      console.warn('Token expirado o inválido, redirigiendo a login')
      AuthService.handleUnauthorized()
      throw new Error('Token inválido o expirado')
    }
    return response
  }

  /**
   * Obtiene los datos completos de un reporte de vehículo
   * @param {string} reportId - ID del reporte a consultar
   * @returns {Promise} Respuesta con los datos del reporte
   */
  static async fetchVehicleReport(reportId) {
    const token = AuthService.getToken()

    const response = await ZOHO.CREATOR.DATA.invokeCustomApi({
      api_name: 'GET_INSPECTION_REPORT_DETAIL',
      http_method: 'GET',
      content_type: 'application/json',
      query_params: `id=${reportId}&token=${token}&portalType=${PORTAL_TYPE}`,
      public_key: import.meta.env.VITE_ZOHO_KEY_INSPECTION_DETAIL,
    })

    // Verificar si el token expiró
    return this.checkTokenExpiration(response)
  }

  /**
   * Obtiene el listado de reportes de inspecciones con paginación y filtros
   * @param {number} page - Número de página (default: 1)
   * @param {number} perPage - Items por página (default: 10)
   * @param {Object} filters - Filtros para la búsqueda (opcional)
   * @param {string} filters.search - Término de búsqueda
   * @param {string} filters.dateFrom - Fecha desde (formato: DD-MM-YYYY)
   * @param {string} filters.dateTo - Fecha hasta (formato: DD-MM-YYYY)
   * @returns {Promise} Respuesta con el listado de reportes paginado
   */
  static async fetchDashboardReports(page = 1, perPage = 10, filters = {}) {
    const token = AuthService.getToken()
    const cleanFilters = JSON.parse(JSON.stringify(filters))
    const filtersEncoded = encodeURIComponent(JSON.stringify(cleanFilters))

    const response = await ZOHO.CREATOR.DATA.invokeCustomApi({
      api_name: 'GET_INSPECTIONS_REPORT',
      http_method: 'GET',
      content_type: 'application/json',
      query_params: `page=${page}&per_page=${perPage}&filters=${filtersEncoded}&token=${token}&portalType=${PORTAL_TYPE}`,
      public_key: import.meta.env.VITE_ZOHO_KEY_INSPECTIONS_REPORT,
    })

    // Verificar si el token expiró
    return this.checkTokenExpiration(response)
  }

  /**
   * Obtiene las estadísticas del dashboard
   * @returns {Promise} Respuesta con las estadísticas generales
   */
  static async fetchDashboardStats() {
    const token = AuthService.getToken()

    const response = await ZOHO.CREATOR.DATA.invokeCustomApi({
      api_name: 'cardoc_fetch_dashboard_stats',
      http_method: 'GET',
      content_type: 'application/json',
      query_params: `token=${token}`,
    })

    // Verificar si el token expiró
    return this.checkTokenExpiration(response)
  }
}
```

### 5.2 `src/services/transforms/reportTransform.js` — normalización (PORTAR A NODE)

> Es lógica pura sin dependencias de Vue → se porta a Node casi textual. **Recordá que su JSDoc de entrada está incompleto (§4).**

```js
/**
 * Construye iniciales (max 2 letras) desde un nombre completo.
 * Fallback "IC" si el input es vacío/null.
 */
export const getInitials = (name) => {
  if (!name) return 'IC'
  const parts = name.split(' ')
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.substring(0, 2).toUpperCase()
}

/**
 * Mapea el campo status.name del backend al estado interno usado por la UI.
 *   - 'advertencia' → 'observacion'
 *   - 'malo'        → 'critico'
 *   - cualquier otro (incluye 'bueno', null) → 'aprobado'
 */
const mapEstado = (statusName) => {
  if (statusName === 'advertencia') return 'observacion'
  if (statusName === 'malo') return 'critico'
  return 'aprobado'
}

/**
 * Transforma la respuesta de GET_INSPECTION_REPORT_DETAIL al shape consumido
 * por DetallesInforme.vue.
 *
 * Shape de entrada — alineado con get_inspection_report.dg (función Deluge):
 *   {
 *     code: string,
 *     vehicle: { marca, modelo, año, matricula, kms, motor, transmision, image },
 *     inspector: { name, fecha, telefono },
 *     inspection_agency: { name },
 *     cliente: { nombre, telefono },   // desde Analisis.clienteNombre / clienteTelefono
 *     summary_audio: string,
 *     transcription_audio: string,
 *     modulos: [
 *       {
 *         name: string,
 *         sub_modulos: [
 *           {
 *             name: string,
 *             components: [
 *               {
 *                 name, description,
 *                 status: { name, label },
 *                 ai_summary, inspector_note,
 *                 evidences: [{ type, resource, note }]
 *               }
 *             ]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 */
export const transformReportData = (apiData) => {
  const vehicle = apiData.vehicle || {}
  const inspector = apiData.inspector || {}
  const inspectionAgency = apiData.inspection_agency || {}
  // Datos del cliente: en Analisis viven como clienteNombre/clienteTelefono. La Custom API
  // get_inspection_report debe exponerlos bajo `cliente: { nombre, telefono }`.
  const cliente = apiData.cliente || {}
  const modulos = apiData.modulos || []

  const secciones = []
  const detalles = []

  modulos.forEach((modulo, index) => {
    const seccionId = index + 1

    secciones.push({
      id: seccionId,
      titulo: modulo.name || 'Sin título',
      completada: false,
      activa: index === 0
    })

    const seccionDetalles = []
    modulo.sub_modulos?.forEach((subModulo) => {
      if (!subModulo.components?.length) return

      subModulo.components.forEach((componente) => {
        if (componente.status?.name === 'sin_evaluar') return

        const evidences = componente.evidences || []
        const evidenciasImagenes = evidences
          .filter(e => e.type === 'foto' && e.resource)
          .map(e => e.resource)

        // Título jerárquico "Módulo - [Submódulo] - Componente" para mostrar en UI y PDF.
        // Se omiten partes vacías y se colapsan duplicados CONSECUTIVOS (el submódulo a veces
        // repite el módulo, p.ej. "2- CHASIS"). La "zona" suele venir pegada al nombre del
        // componente, así que ya viaja dentro de la última parte.
        // Ej: "2- CHASIS - FRENTE - Chasis delantero izquierdo" / "Motor - Bloque - Filtro".
        const tituloJerarquico = [modulo.name, subModulo.name, componente.name]
          .map(p => (p || '').trim())
          .filter(Boolean)
          .filter((p, i, arr) => i === 0 || p !== arr[i - 1])
          .join(' - ') || 'Sin nombre'

        seccionDetalles.push({
          id: detalles.length + seccionDetalles.length + 1,
          componenteId: componente.id || null,
          seccionId,
          titulo: componente.name || 'Sin nombre',
          subtitulo: subModulo.name || modulo.name || '',
          tituloJerarquico,
          estado: mapEstado(componente.status?.name),
          descripcion: componente.description || null,
          imagenes: evidenciasImagenes,
          audioData: evidences.filter(e => e.type === 'audio' && e.resource),
          // Preservar videos aunque WorkDrive no haya generado URL; la UI muestra
          // un estado explícito en vez de ocultar la evidencia silenciosamente.
          videoData: evidences.filter(e => e.type === 'video'),
          // PDFs/documentos llegan con tipoArchivo 'ocr' desde el backend (Archivos_Staging).
          pdfData: evidences.filter(e => e.type === 'ocr' && e.resource),
          nota: componente.inspector_note || null,
          aiSummary: componente.ai_summary || null
        })
      })
    })
    detalles.push(...seccionDetalles)
  })

  return {
    id: apiData.code || '',
    reportCode: apiData.code || '',
    recomendaciones: apiData.recomendaciones || null,
    vehiculo: {
      // Campos faltantes caen a '' (no 'N/A'): así el título del vehículo y la grilla
      // de la portada no muestran "N/A", quedan en blanco.
      marca: vehicle.marca || '',
      modelo: vehicle.modelo || '',
      año: vehicle.año || '',
      placa: vehicle.matricula || 'Sin matrícula',
      kilometraje: vehicle.kms ? `${vehicle.kms} km` : '',
      motor: vehicle.motor || '',
      transmision: vehicle.transmision || '',
      imagen: vehicle.image || ''
    },
    cliente: {
      nombre: cliente.nombre || '',
      telefono: cliente.telefono || ''
    },
    fechaInspeccion: inspector.fecha || '',
    inspector: {
      nombre: inspector.name || 'Inspector',
      cargo: inspectionAgency.name ? `Inspector @ ${inspectionAgency.name}` : 'Inspector',
      telefono: inspector.telefono || '',
      avatar: '',
      iniciales: getInitials(inspector.name || 'I')
    },
    resumenAudio: apiData.summary_audio || null,
    resumenTranscripcion: apiData.transcription_audio || null,
    // Puntaje técnico (0–10, manual, solo lectura). OJO: 0 ES un puntaje válido, así que NO
    // se puede usar `|| null` (ocultaría el 0). Solo null/''/undefined (técnico no lo cargó)
    // caen a null para que la UI oculte el bloque. score_comentario puede venir '' (sin texto).
    score: apiData.score === '' || apiData.score == null ? null : apiData.score,
    score_comentario: apiData.score_comentario || '',
    secciones,
    detalles
  }
}
```

### 5.3 `src/services/portal-type-filter.js` — defense-in-depth

```js
/**
 * Defense in depth para el contrato `portalType`.
 *
 * Funciones puras que verifican que los datos recibidos del backend
 * pertenezcan al portal esperado. Aplica los requisitos R2 y R3 de la spec.
 *
 * Spec: docs/specifications/portal-type.md §5
 *  - R2: rechazar registros con portalType distinto al esperado.
 *  - R3: tolerar registros sin portalType (back-compat con backend
 *    que aún no envía el campo).
 *
 * Estas funciones son la línea secundaria. La línea primaria es el
 * filtrado server-side. Cuando ambas líneas estén activas, R2 se
 * cumple end-to-end.
 */

/**
 * Filtra una lista de items recibidos del backend, descartando los que
 * tienen `portalType` distinto al esperado. Items sin el campo se
 * permiten (back-compat — R3).
 *
 * @param {Array<object>} items - Items crudos del backend.
 * @param {string} expectedType - Valor esperado de `portalType` (ej. 'ml').
 * @returns {{ items: Array<object>, filteredCount: number }}
 *   `items` contiene los registros que pasaron el filtro.
 *   `filteredCount` indica cuántos fueron descartados — útil para logging.
 */
export function filterListingByPortalType(items, expectedType) {
  if (!Array.isArray(items)) {
    return { items: [], filteredCount: 0 }
  }
  const accepted = items.filter(
    (item) => item?.portalType === undefined || item?.portalType === expectedType
  )
  return {
    items: accepted,
    filteredCount: items.length - accepted.length,
  }
}

/**
 * Decide si un registro de detalle debe ser rechazado por no pertenecer
 * al portal esperado.
 *
 * - Si `portalType` está presente y NO matchea → rechazar (R2).
 * - Si `portalType` no está presente → permitir (R3, back-compat).
 * - Si el record es null/undefined → permitir (la view ya maneja datos vacíos).
 *
 * @param {object|null|undefined} record - Registro recibido del backend.
 * @param {string} expectedType - Valor esperado de `portalType`.
 * @returns {boolean} `true` si debe rechazarse, `false` si se permite.
 */
export function shouldRejectDetailByPortalType(record, expectedType) {
  if (record === null || record === undefined) return false
  if (record.portalType === undefined) return false
  return record.portalType !== expectedType
}
```

### 5.4 `src/config/features.js` — feature flag (transcripción)

> En Catalyst esto pasa a ser **config del servicio** (env var), no build-time. Misma semántica opt-out/default-ON. Ver §8.

```js
/**
 * Feature flags del portal — evaluados en build time desde variables `VITE_*`.
 *
 * Las env vars de Vite siempre llegan como STRING (o undefined si no están definidas),
 * así que la coerción a booleano se centraliza acá para no repetir el parseo —y sus
 * sutilezas (`"false"` es truthy como string)— en cada consumidor.
 */

// Valores que interpretamos como "apagado". Cualquier otra cosa (incluido no definir la
// var) deja el flag en su default.
const VALORES_FALSE = ['false', '0', 'off', 'no']

/**
 * Coerciona el string de una env var de Vite a booleano. Exportada para poder testearla
 * sin depender del valor real de import.meta.env.
 *
 * @param {string|undefined} valor  Valor crudo de import.meta.env.VITE_*
 * @param {boolean} porDefecto      Valor si la var no está definida / viene vacía
 */
export const parseBool = (valor, porDefecto) => {
  if (valor === undefined || valor === null || valor === '') return porDefecto
  return !VALORES_FALSE.includes(String(valor).trim().toLowerCase())
}

/**
 * Transcripción del audio resumen (componente TranscripcionResumen en la UI + bloque
 * "Resumen del Técnico" del PDF).
 *
 * OPT-OUT: encendida por defecto (no rompe lo ya desplegado). Se apaga poniendo
 * `VITE_FEATURE_TRANSCRIPCION=false` en el .env y rebuildeando.
 */
export const transcripcionHabilitada = parseBool(
  import.meta.env.VITE_FEATURE_TRANSCRIPCION,
  true
)
```

### 5.5 `src/components/informes/InformePdfTemplate.vue` — el documento (plantilla + CSS)

> Fuente de verdad visual. El backend re-authorea esto como **HTML standalone**: quitar el wrapper `<template>`/`<script setup>`, materializar el binding de `informe.*` con datos reales, mover el `<style scoped>` a CSS inline **des-scopeado** (sin `data-v-*`), e **inline el logo** (`import logoMl` → data-URI del Anexo A). El `INDICE_PORTADA` es una constante **fija** (no deriva de los datos) — copiar verbatim. `generadoEn` se genera en cliente con `new Date().toLocaleString('es-UY', …)` → el backend estampa su propio timestamp. Fotos capadas a 6 por componente (`.slice(0,6)`).

```vue
<template>
  <!-- Raíz del PDF. La usan la VISTA PREVIA (modal) y la IMPRESIÓN NATIVA (window.print +
       @media print), que es el ÚNICO camino de generación del PDF (el botón "Descargar PDF"
       abre el diálogo nativo). El padding lateral lo da la raíz; en print la paginación la
       maneja el motor de Chrome (break-inside: avoid en los componentes). -->
  <div class="pdf-root" ref="root">

    <!-- ===== PORTADA ===== -->
    <section class="pdf-cover">
      <!-- Logo centrado de marca Portal ML + código/fecha del informe. -->
      <div class="pdf-cover__header">
        <img :src="logoMl" alt="Portal ML" class="pdf-cover__logo" />
        <div class="pdf-cover__meta">
          <span class="pdf-cover__code">{{ informe.reportCode }}</span>
          <span class="pdf-cover__date">Generado: {{ generadoEn }}</span>
        </div>
      </div>

      <!-- Título del vehículo. -->
      <div class="pdf-cover__vehicle-name">
        {{ informe.vehiculo.marca }} {{ informe.vehiculo.modelo }}
        <span class="pdf-cover__vehicle-year">{{ informe.vehiculo.año }}</span>
      </div>

      <!-- Tarjeta: Datos del vehículo -->
      <div class="pdf-card">
        <div class="pdf-card__head">
          <svg class="pdf-card__check" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="9" fill="none" stroke="#F5C400" stroke-width="1.5" />
            <path d="M6 10.5l2.5 2.5L14 7.3" fill="none" stroke="#F5C400" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="pdf-card__title">Datos del Vehículo</span>
        </div>
        <div class="pdf-card__cols">
          <div class="pdf-field">
            <span class="pdf-field__label">Matrícula</span>
            <span class="pdf-field__value">{{ informe.vehiculo.placa || '—' }}</span>
          </div>
          <div class="pdf-field">
            <span class="pdf-field__label">Kilometraje</span>
            <span class="pdf-field__value">{{ informe.vehiculo.kilometraje || '—' }}</span>
          </div>
          <div class="pdf-field">
            <span class="pdf-field__label">Motor</span>
            <span class="pdf-field__value">{{ informe.vehiculo.motor || '—' }}</span>
          </div>
          <div class="pdf-field">
            <span class="pdf-field__label">Transmisión</span>
            <span class="pdf-field__value">{{ informe.vehiculo.transmision || '—' }}</span>
          </div>
        </div>
      </div>

      <!-- Tarjeta: Cliente -->
      <div class="pdf-card">
        <div class="pdf-card__head">
          <svg class="pdf-card__check" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="9" fill="none" stroke="#F5C400" stroke-width="1.5" />
            <path d="M6 10.5l2.5 2.5L14 7.3" fill="none" stroke="#F5C400" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="pdf-card__title">Cliente</span>
        </div>
        <div class="pdf-card__cols">
          <div class="pdf-field pdf-field--wide">
            <span class="pdf-field__label">Nombre</span>
            <span class="pdf-field__value">{{ informe.cliente.nombre || '—' }}</span>
          </div>
          <div class="pdf-field">
            <span class="pdf-field__label">Teléfono</span>
            <span class="pdf-field__value">{{ informe.cliente.telefono || '—' }}</span>
          </div>
        </div>
      </div>

      <!-- Tarjeta: Inspección -->
      <div class="pdf-card">
        <div class="pdf-card__head">
          <svg class="pdf-card__check" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="9" fill="none" stroke="#F5C400" stroke-width="1.5" />
            <path d="M6 10.5l2.5 2.5L14 7.3" fill="none" stroke="#F5C400" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="pdf-card__title">Inspección</span>
        </div>
        <div class="pdf-card__cols">
          <div class="pdf-field">
            <span class="pdf-field__label">Inspector</span>
            <span class="pdf-field__value">{{ informe.inspector.nombre || '—' }}</span>
          </div>
          <div class="pdf-field">
            <span class="pdf-field__label">Agencia</span>
            <span class="pdf-field__value">{{ informe.inspector.cargo || '—' }}</span>
          </div>
          <div class="pdf-field">
            <span class="pdf-field__label">Fecha inspección</span>
            <span class="pdf-field__value">{{ informe.fechaInspeccion || '—' }}</span>
          </div>
        </div>
      </div>

      <!-- ÍNDICE de secciones del informe. -->
      <div class="pdf-toc">
        <div class="pdf-toc__bar">ÍNDICE</div>
        <div class="pdf-toc__cols">
          <div v-for="(columna, ci) in indiceColumnas" :key="`toc-col-${ci}`" class="pdf-toc__col">
            <div v-for="item in columna" :key="`toc-${item.n}`" class="pdf-toc__item">
              <span class="pdf-toc__num">{{ item.n }}</span>
              <div class="pdf-toc__body">
                <div class="pdf-toc__title">{{ item.titulo }}</div>
                <p v-if="item.descripcion" class="pdf-toc__desc">{{ item.descripcion }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Descargo legal de ML (al pie de la portada). -->
      <div class="pdf-cover__legal">
        El servicio se limita a la revisión, análisis técnico e informe sobre el estado del vehículo. El mismo no constituye una garantía.
        ML se deslinda de toda responsabilidad ante cualquier tipo de anomalía o desperfecto no detectado, como también por vicios ocultos.
        ML no será responsable ante ninguna acción u omisión de buena fe o con culpa simple, ni estará sujeto a ningún tipo de responsabilidad implícita, obligándose únicamente a la realización del análisis técnico e informe contratado.
      </div>
    </section>

    <!-- ===== RESUMEN TÉCNICO ===== -->
    <!-- Oculto vía feature flag VITE_FEATURE_TRANSCRIPCION (mismo flag que la UI). -->
    <section v-if="transcripcionHabilitada && informe.resumenTranscripcion" class="pdf-summary">
      <h2 class="pdf-section__title pdf-section__title--flush">Resumen del Técnico</h2>
      <div class="pdf-summary-block">
        <p class="pdf-summary-block__label">Transcripción del audio</p>
        <p class="pdf-summary-block__text">{{ informe.resumenTranscripcion }}</p>
      </div>
    </section>

    <!-- ===== RECOMENDACIONES DEL INSPECTOR (título propio, como "Resumen del Técnico") ===== -->
    <section v-if="informe.recomendaciones" class="pdf-summary">
      <h2 class="pdf-section__title">Recomendaciones del Inspector</h2>
      <div class="pdf-summary-block pdf-summary-block--reco">
        <p class="pdf-summary-block__text">{{ informe.recomendaciones }}</p>
      </div>
    </section>

    <!-- ===== PUNTAJE TÉCNICO (0–10 + comentario, solo lectura). 0 es VÁLIDO → score != null ===== -->
    <section v-if="informe.score != null" class="pdf-summary">
      <h2 class="pdf-section__title">Puntaje Técnico</h2>
      <div class="pdf-summary-block pdf-summary-block--score">
        <p class="pdf-score">{{ informe.score }}<span class="pdf-score__max">/10</span></p>
        <!-- Comentario opcional: se oculta si viene ''. -->
        <p v-if="informe.score_comentario" class="pdf-summary-block__text">{{ informe.score_comentario }}</p>
      </div>
    </section>

    <!-- ===== SECCIONES DE INSPECCIÓN (título + componentes, aplanados) ===== -->
    <template v-for="seccion in informe.secciones" :key="seccion.id">
      <h2 class="pdf-section__title">
        {{ seccion.titulo }}
      </h2>

      <div
        v-for="detalle in detallesPorSeccion(seccion.id)"
        :key="detalle.id"
        class="pdf-component"
        :class="`pdf-component--${detalle.estado}`"
      >
        <!-- Cabecera del componente -->
        <div class="pdf-component__header">
          <div class="pdf-component__title-wrap">
            <span class="pdf-component__title">{{ detalle.tituloJerarquico }}</span>
          </div>
        </div>

        <!-- Descripción técnica -->
        <p v-if="detalle.descripcion" class="pdf-component__desc">{{ detalle.descripcion }}</p>

        <!-- Nota del inspector -->
        <div v-if="detalle.nota" class="pdf-component__nota">
          <span class="pdf-component__nota-label">Nota del inspector:</span>
          <span class="pdf-component__nota-text">{{ detalle.nota }}</span>
        </div>

        <!-- Diagnóstico del componente -->
        <p v-if="detalle.aiSummary" class="pdf-component__diag">{{ detalle.aiSummary }}</p>

        <!-- Evidencias fotográficas -->
        <div v-if="detalle.imagenes && detalle.imagenes.length" class="pdf-component__photos">
          <img
            v-for="(url, idx) in detalle.imagenes.slice(0, 6)"
            :key="idx"
            :src="url"
            class="pdf-component__photo"
            crossorigin="anonymous"
            alt=""
          />
        </div>

        <!-- Placeholder audio/video -->
        <div
          v-if="(detalle.audioData && detalle.audioData.length) || (detalle.videoData && detalle.videoData.length)"
          class="pdf-component__media-placeholder"
        >
          <span v-if="detalle.audioData && detalle.audioData.length">
            🎙 {{ detalle.audioData.length }} archivo(s) de audio — disponible en la versión digital
          </span>
          <span v-if="detalle.videoData && detalle.videoData.length">
            🎬 {{ detalle.videoData.length }} video(s) — disponible en la versión digital
          </span>
        </div>
      </div>
    </template>

    <!-- ===== PIE ===== -->
    <section class="pdf-footer">
      <div class="pdf-footer__main">
        <span>{{ informe.reportCode }}</span>
        <span>{{ generadoEn }}</span>
        <span>Documento informativo. No sustituye revisión técnica presencial.</span>
      </div>
      <div class="pdf-footer__disclaimer">
        Los análisis de componentes de este informe son asistidos por inteligencia artificial y validados por inspectores certificados.
      </div>
    </section>

  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import logoMl from '@/assets/logo-ml.png'
import { transcripcionHabilitada } from '@/config/features.js'

const props = defineProps({
  informe: {
    type: Object,
    required: true
  }
})

/**
 * ÍNDICE FIJO de la portada: estructura estándar de inspección de ML, tal cual la maqueta.
 * Es deliberadamente FIJO — se muestra siempre, independientemente de qué módulos traiga la
 * plantilla/informe puntual (pedido de ML). No derivar del informe.
 */
const INDICE_PORTADA = [
  { titulo: 'Resumen, Recomendaciones y Puntaje', descripcion: 'En esta sección podrá visualizar los comentarios generales del técnico, junto con unas recomendaciones para seguir con el funcionamiento del vehículo y un puntaje general del estado del mismo.' },
  { titulo: 'Chasis', descripcion: 'El chasis es la estructura principal del vehículo. Evaluamos que no presente deformaciones, daños o reparaciones que puedan comprometer la seguridad de los ocupantes.' },
  { titulo: 'Carrocería', descripcion: 'Revisamos los paneles de carrocería y medimos el espesor de pintura para determinar si las piezas conservan su estado original de fábrica o si han sido reparadas y/o repintadas.' },
  { titulo: 'Interior', descripcion: 'Evaluamos el estado y funcionamiento de los componentes del interior del vehículo, verificando su nivel de conservación y operatividad.' },
  { titulo: 'Mecánica', descripcion: 'Evaluamos los componentes que conforman la mecánica del vehículo, verificando su estado y detectando posibles fallas o desgastes.' },
  { titulo: 'Electrónica', descripcion: 'Analizamos las alertas e indicadores presentes en el vehículo y realizamos un escaneo con equipos de diagnóstico para detectar posibles fallas electrónicas.' },
  { titulo: 'Prueba Dinámica', descripcion: 'Realizamos una prueba de conducción para evaluar el comportamiento real del vehículo y detectar posibles fallas o anomalías en funcionamiento que no pueden apreciarse con el vehículo detenido.' },
  { titulo: 'PRO', descripcion: 'En esta sección se agregan los componentes del PRO, que le dan un enfoque aún más ampliado y con más información al resto del informe.' }
]

const root = ref(null)

const generadoEn = new Date().toLocaleString('es-UY', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit'
})

// Entradas del ÍNDICE, numeradas 1..N a partir de la lista fija INDICE_PORTADA.
const indiceItems = computed(() => INDICE_PORTADA.map((it, i) => ({ ...it, n: i + 1 })))

// El ÍNDICE se maqueta en 2 columnas con orden vertical (1..mitad a la izquierda, resto a la
// derecha), igual que la maqueta de ML.
const indiceColumnas = computed(() => {
  const items = indiceItems.value
  const mitad = Math.ceil(items.length / 2)
  return [items.slice(0, mitad), items.slice(mitad)]
})

const detallesPorSeccion = (seccionId) =>
  props.informe.detalles.filter(d => d.seccionId === seccionId)

/**
 * Espera a que todas las imágenes dentro de `el` terminen (load o error). La impresión
 * nativa la usa para no imprimir fotos a medio cargar. Tope para no colgarse.
 */
const waitForImages = (el, timeout = 8000) => {
  const pendientes = Array.from(el.querySelectorAll('img'))
    .filter((img) => !(img.complete && img.naturalHeight !== 0))
    .map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    }))
  if (!pendientes.length) return Promise.resolve()
  return Promise.race([
    Promise.all(pendientes),
    new Promise((resolve) => setTimeout(resolve, timeout)),
  ])
}

// waitImages: lo usa la impresión nativa (window.print) antes de imprimir.
defineExpose({ waitImages: () => waitForImages(root.value) })
</script>

<style scoped>
/* ── Raíz ─────────────────────────────────────────────── */
/* 794px = A4 (210mm). El padding lateral (48px) hace de margen del documento (usado por la
   vista previa y la impresión nativa). */
.pdf-root {
  font-family: Arial, Helvetica, sans-serif;
  /* Tamaño base del PDF: 14px (pedido del cliente). El resto de tamaños escala desde acá. */
  font-size: 14px;
  color: #2c2c2c;
  background: #ffffff;
  width: 794px;
  box-sizing: border-box;
  padding: 0 48px;
  margin: 0;
}

/* ── Portada ──────────────────────────────────────────── */
.pdf-cover {
  padding: 32px 0 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* Cabecera como la maqueta: logo arriba a la IZQUIERDA, código/fecha centrados en la página.
   El logo va en position:absolute para que el centrado del meta sea respecto al ancho completo
   (y no se corra según el ancho del logo). */
.pdf-cover__header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  /* Filete amarillo de marca Portal ML bajo la cabecera. */
  border-bottom: 3px solid #F5C400;
  padding-bottom: 18px;
}

.pdf-cover__logo {
  position: absolute;
  left: 0;
  top: 0;
  height: 56px;
  width: auto;
}

.pdf-cover__meta {
  text-align: center;
}

.pdf-cover__code {
  display: block;
  font-size: 16px;
  font-weight: 700;
  color: #2c2c2c;
  white-space: nowrap;
}

.pdf-cover__date {
  display: block;
  font-size: 12px;
  color: #888;
  margin-top: 4px;
}

.pdf-cover__vehicle-name {
  font-size: 26px;
  font-weight: 800;
  color: #2c2c2c;
  margin: 2px 0;
}

.pdf-cover__vehicle-year {
  font-size: 18px;
  font-weight: 400;
  color: #666;
  margin-left: 8px;
}

/* ── Tarjetas de datos (vehículo / cliente / inspección) ── */
.pdf-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 16px;
}

.pdf-card__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
}

.pdf-card__check {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.pdf-card__title {
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #2c2c2c;
}

/* Campos en fila, separados por filetes verticales (como la maqueta). */
.pdf-card__cols {
  display: flex;
  align-items: stretch;
}

.pdf-card__cols .pdf-field {
  flex: 1 1 0;
  padding: 0 16px;
  border-left: 1px solid #eef0f2;
  min-width: 0;
}

.pdf-card__cols .pdf-field:first-child {
  padding-left: 0;
  border-left: none;
}

.pdf-field--wide {
  flex: 2 1 0 !important;
}

.pdf-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pdf-field__label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #999;
}

.pdf-field__value {
  font-size: 14px;
  font-weight: 700;
  color: #2c2c2c;
  word-break: break-word;
}

/* ── ÍNDICE ───────────────────────────────────────────── */
.pdf-toc {
  margin-top: 4px;
}

.pdf-toc__bar {
  background: #F5C400;
  color: #1a1a1a;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 8px 16px;
  border-radius: 4px;
  margin-bottom: 14px;
}

.pdf-toc__cols {
  display: flex;
  gap: 28px;
}

.pdf-toc__col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pdf-toc__item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  break-inside: avoid;
  page-break-inside: avoid;
}

.pdf-toc__num {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #F5C400;
  color: #1a1a1a;
  font-size: 12px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.pdf-toc__body {
  min-width: 0;
}

.pdf-toc__title {
  font-size: 13px;
  font-weight: 700;
  color: #1a1a1a;
  line-height: 1.25;
}

.pdf-toc__desc {
  font-size: 10.5px;
  line-height: 1.45;
  color: #666;
  margin-top: 3px;
}

/* ── Descargo legal de portada ────────────────────────── */
.pdf-cover__legal {
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid #eef0f2;
  font-size: 9px;
  line-height: 1.5;
  color: #9aa0a6;
  text-align: justify;
}

/* ── Títulos de sección ───────────────────────────────── */
.pdf-section__title {
  font-size: 18px;
  font-weight: 800;
  color: #1a1a1a;
  border-bottom: 2px solid #1a1a1a;
  padding-bottom: 8px;
  margin-top: 28px;
  margin-bottom: 16px;
}

/* En el bloque de resumen el título va pegado al tope de su sección. */
.pdf-section__title--flush {
  margin-top: 0;
}

/* ── Resumen técnico ──────────────────────────────────── */
.pdf-summary {
  margin-top: 28px;
}

.pdf-summary-block {
  background: #f9f9f9;
  border-left: 3px solid #d1d5db;
  padding: 12px 16px;
  margin-bottom: 12px;
  border-radius: 0 6px 6px 0;
}

.pdf-summary-block--reco {
  border-left-color: #F6A872;
  background: #fffaf5;
}

.pdf-summary-block__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #999;
  margin-bottom: 6px;
}

.pdf-summary-block__text {
  font-size: 14px;
  line-height: 1.6;
  color: #2c2c2c;
  white-space: pre-wrap;
}

/* Variante puntaje: filete amarillo de marca + número en grande ("8/10"). */
.pdf-summary-block--score {
  border-left-color: #F5C400;
  background: #fffdf2;
}

.pdf-score {
  font-size: 28px;
  font-weight: 800;
  color: #2c2c2c;
  line-height: 1;
}

.pdf-score__max {
  font-size: 16px;
  font-weight: 700;
  color: #999;
  margin-left: 2px;
}

/* Separación con el comentario solo cuando ambos están presentes. */
.pdf-score + .pdf-summary-block__text {
  margin-top: 6px;
}

/* ── Componentes inspeccionados ───────────────────────── */
.pdf-component {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 14px 16px;
  margin-bottom: 12px;
}

.pdf-component--aprobado { border-left: 4px solid #16a34a; }
.pdf-component--observacion { border-left: 4px solid #d97706; }
.pdf-component--critico { border-left: 4px solid #dc2626; }

.pdf-component__header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.pdf-component__title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pdf-component__title {
  font-size: 15px;
  font-weight: 700;
  color: #2c2c2c;
}

.pdf-component__desc,
.pdf-component__nota,
.pdf-component__diag {
  font-size: 14px;
  line-height: 1.5;
  margin-top: 6px;
  color: #444;
}

.pdf-component__nota-label {
  font-weight: 700;
  margin-right: 4px;
}

/* ── Fotos ────────────────────────────────────────────── */
/* 2 fotos por fila (~mitad del ancho del componente). NO fijamos alto ni object-fit:
   html2canvas no respeta object-fit y deforma. Con ancho fijo + height:auto la foto
   mantiene su proporción real. (33% ≈ 3 por fila, 100% = 1 grande.) */
.pdf-component__photos {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
}

.pdf-component__photo {
  width: calc(50% - 4px);
  height: auto;
  border-radius: 4px;
  border: 1px solid #e5e7eb;
}

/* ── Placeholder media ────────────────────────────────── */
.pdf-component__media-placeholder {
  margin-top: 8px;
  font-size: 13px;
  color: #888;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── Pie de página ────────────────────────────────────── */
.pdf-footer {
  padding: 16px 0 20px;
  margin-top: 24px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pdf-footer__main {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #aaa;
}

.pdf-footer__disclaimer {
  text-align: center;
  font-size: 10px;
  color: #bbb;
  border-top: 1px dashed #e5e7eb;
  padding-top: 6px;
}
</style>
```

### 5.6 CSS de impresión — vive en `DetallesInforme.vue`, NO en el template

> ⚠️ **Load-bearing y separado del template.** Estas reglas (`@page`, `print-color-adjust`, `break-*`, y los override de geometría `width:auto`/`padding:0`) están en el `<style>` **no-scoped** de `DetallesInforme.vue`, no en el `.vue` de la plantilla. Reproducir "solo el template" sin esto = fondos de color perdidos, cortes de página rotos y escalado fit-to-page de Chrome. La CSS del **preview** (paginación en hojas simuladas) es UI-only y **NO** se necesita en backend.

```css
/* =============================================
   IMPRESIÃ“N NATIVA (window.print) â€” alta calidad, vectorial
   ---------------------------------------------
   Ocultan la app y revelan #print-root (el template off-screen), dejando que el motor de
   impresiÃ³n de Chrome pagine solo. Es el ÃšNICO camino de generaciÃ³n del PDF.
   ============================================= */
@page {
  size: A4;
  /* MÃ¡rgenes REALES (no full-bleed). El full-bleed anterior (794px = 210mm exactos +
     margen lateral 0) no dejaba tolerancia: cualquier desborde mÃ­nimo disparaba el
     "ajustar a la pÃ¡gina" de Chrome â†’ escalaba todo (margen derecho grande + menos
     pÃ¡ginas). Con margen real, el contenido llena el Ã¡rea imprimible y nunca desborda. */
  margin: 12mm;
}

@media print {
  /* Ocultar todo salvo el documento del informe. (visibility, no display, para no romper
     el layout interno del template). */
  body * {
    visibility: hidden !important;
  }
  #print-root,
  #print-root * {
    visibility: visible !important;
  }

  /* Forzar la impresiÃ³n de COLORES DE FONDO. Chrome los omite por defecto (ahorro de tinta),
     por eso en el PDF desaparecÃ­an el amarillo de la barra ÃNDICE, los badges numerados y los
     fondos de los bloques de resumen. Con esto se imprimen sÃ­ o sÃ­, sin depender del check
     "GrÃ¡ficos de fondo" del diÃ¡logo. */
  #print-root,
  #print-root * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  /* Traer el template (off-screen a left:-9999px) al Ã¡rea imprimible y dejar que LLENE el
     ancho imprimible (left+right:0, width:auto) en vez de un ancho fijo de 794px. */
  #print-root {
    position: absolute !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
    width: auto !important;
    overflow: visible !important;
  }

  /* El template en print: ancho fluido y sin su padding lateral propio (el margen lateral
     ya lo da @page). AsÃ­ el contenido = ancho imprimible exacto, sin desbordar. */
  #print-root .pdf-root {
    width: auto !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }

  /* Blindaje anti-desborde horizontal (otra fuente del "ajustar a pÃ¡gina"):
     fotos acotadas, palabras/cÃ³digos largos que cortan en vez de empujar el ancho. */
  #print-root img {
    max-width: 100% !important;
    height: auto !important;
  }
  /* El reset de arriba (height:auto) deja el logo a tamaÃ±o natural del PNG = gigante en print.
     Le devolvemos su alto fijo (gana por especificidad: id+clase > id+elemento). */
  #print-root .pdf-cover__logo {
    height: 56px !important;
    width: auto !important;
  }
  #print-root * {
    overflow-wrap: break-word;
  }
  .pdf-cover__code {
    white-space: normal !important;
  }

  /* Cortes naturales del motor de impresiÃ³n: no partir bloques por la mitad. */
  .pdf-component,
  .pdf-summary-block,
  .pdf-card,
  .pdf-toc__item,
  .pdf-footer {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  /* Un tÃ­tulo de secciÃ³n nunca queda huÃ©rfano al pie: se mantiene con el bloque que le sigue. */
  .pdf-section__title {
    break-after: avoid;
    page-break-after: avoid;
  }

  /* Portada en su propia pÃ¡gina. */
  .pdf-cover {
    break-after: page;
    page-break-after: always;
  }

}
```

**Glue JS del frontend (para contexto — no se porta, se reemplaza):**

```js
// #print-root: contenedor off-screen que monta una 2da instancia del template.
// <div id="print-root" style="position:absolute;left:-9999px;top:0;width:794px;overflow:hidden;pointer-events:none;">
//   <InformePdfTemplate ref="pdfTemplateRef" :informe="informe" />
// </div>

// imprimirNativo(): espera las fotos y dispara el diálogo nativo.
const imprimirNativo = async () => {
  if (pdfTemplateRef.value?.waitImages) {
    await pdfTemplateRef.value.waitImages()   // ← waitForImages: load/error de cada <img>, tope 8000ms
  }
  window.print()
}
```

---

## 6. Implementación backend (Catalyst + Node + headless Chromium)

Reconstrucción de las etapas [2]–[4] server-side. Camino recomendado: **Puppeteer/Playwright** (Chromium headless) sobre el HTML standalone → fidelidad 1:1 con el `@media print` actual.

### 6.1 Pipeline de la función
1. Recibir `reportId` (+ auth).
2. Obtener datos: invocar `GET_INSPECTION_REPORT_DETAIL` (o consultar Análisis) **aplicando `portalType=ml` server-side** (§7). Validar envelope `code === 3000`, tomar `result`.
3. Normalizar con el port de `reportTransform.js` (§5.2) → `informe`.
4. Renderizar el HTML standalone (§5.5) con `informe`.
5. `waitImages` equivalente: esperar `load`/`error` de todas las fotos (tope ~8000ms) **antes** de `page.pdf()`, o salen en blanco.
6. `page.pdf(...)` (§6.2) → devolver el buffer / subir a WorkDrive.

### 6.2 Opciones `page.pdf()` (mapeo del `@page` / `@media print`)

```js
await page.pdf({
  format: 'A4',
  printBackground: true,   // ⚠️ OBLIGATORIO — equivale a print-color-adjust:exact.
                           // Sin esto desaparecen: barra ÍNDICE #F5C400, badges numerados,
                           // fondos de los bloques resumen/score/reco. Documento visiblemente roto.
  margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
})
```

- **No hay opción de `page.pdf` para fragmentación.** `break-inside:avoid` / `break-after:avoid` / `break-after:page` deben quedar como **CSS inline** en `.pdf-component`, `.pdf-summary-block`, `.pdf-card`, `.pdf-toc__item`, `.pdf-footer`, `.pdf-section__title`, `.pdf-cover`. Declarar **ambas** propiedades (moderna `break-*` y legacy `page-break-*`).

### 6.3 Conflicto de geometría (el error más probable)

La `.pdf-root` base es `width:794px; padding:0 48px`, **pero el layout impreso correcto** es `width:auto; padding-left/right:0` con margen dado por `@page margin:12mm` (área imprimible ≈ 704px). Si copiás la regla scoped (794px + 48px) **y además** ponés margin 12mm en Puppeteer, **doblás el inset** → overflow → Chrome escala fit-to-page. **Resolución:** en el HTML standalone, dropear `width:794px` y el `padding:0 48px` de `.pdf-root`, y confiar en el `@page margin`.

### 6.4 Dependencias del entorno de render (silenciosas)
- **Fuente Arial/Helvetica:** `.pdf-root` usa `font-family: Arial, Helvetica, sans-serif` **sin** `@font-face`. Chromium headless normalmente **no la tiene** y sustituye por una de métricas distintas → cambian saltos de línea, alturas y paginación (rompe la fidelidad). **Instalar Arial o el clon métrico Liberation Sans** en el contenedor. `font-size` base = `14px` (pedido del cliente); el resto son px explícitos.
- **Fuente de emoji:** el placeholder de audio/video usa glifos 🎙/🎬 literales. Sin fuente de emoji → cajas tofu. Instalar **Noto Color Emoji** o sustituir por texto/SVG. Solo afecta informes con audio/video.
- **Des-scoping:** quitar todos los atributos/selectores `[data-v-*]`; los nombres de clase `.pdf-*` no deben colisionar en la página.

### 6.5 Valores generados en cliente (no vienen del payload)
- **`generadoEn`** (timestamp "Generado:" en portada + pie): `new Date().toLocaleString('es-UY', {day,month,year,hour,minute})`. El backend estampa el suyo.
- **`fechaInspeccion`**: se renderiza **verbatim**, sin formateo → el backend debe mandar `inspector.fecha` ya formateada (dd/mm/yyyy), no ISO/epoch.
- **`INDICE_PORTADA`**: TOC fijo de 8 entradas, embebido en el template (§5.5). No deriva de `modulos`. Copiar verbatim.
- **Cap de fotos**: `.slice(0, 6)` por componente.

---

## 7. Deudas backend bloqueantes

Prerequisitos que **el backend debe cumplir** (no son supuestos):

1. **`cliente: { nombre, telefono }`** — hoy `get_inspection_report.dg` **no lo expone** (memoria del repo `pendiente-backend-cliente-api`). La tarjeta "Cliente" de la portada ya lo consume; sin esto sale `— / —`. Fuente: `Analisis.clienteNombre` / `Analisis.clienteTelefono`.
2. **Filtro `portalType` server-side** — `GET_INSPECTION_REPORT_DETAIL` debe leer `input.portalType`, filtrar Análisis por `Analisis.portalType`, y **fallar cerrado** (vacío/404) si el campo discriminador no existe. Nunca exponer registros sin marcar. El `result` puede además traer `portalType` top-level que el frontend rechaza si no es `'ml'`. Contrato completo: [`portal-type.md`](../../specifications/portal-type.md) (garantías G1–G5).

---

## Premisas / dependencias

- **Spec aplicable:** [`portal-type.md`](../../specifications/portal-type.md) — el filtro server-side es parte del contrato.
- **Estrategia PDF actual:** impresión nativa (memoria `pdf-generacion-estrategia`); html2pdf y pdfmake fueron retirados. Esta feature la **reemplaza** por render backend.
- **Upstream cardoc-360:** `get_inspection_report.dg` (datos), campos `score`/`score_comentario`/`recomendaciones`/`cliente` en form Análisis.
- **Feature flag:** [`feature-flag-transcripcion.md`](../../feature-flag-transcripcion.md) — semántica del gate de transcripción.
- **Workflow:** [`feature-workflow.md`](../../runbooks/feature-workflow.md).

## Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| Olvidar `printBackground:true` | Media | Alto | Documento sin fondos de marca. Test visual comparativo contra el PDF actual. |
| Doble inset de geometría (§6.3) | Alta | Alto | Dropear `794px`/`48px` de `.pdf-root`; confiar en `@page margin`. |
| Arial ausente en el contenedor | Alta | Medio | Instalar Arial/Liberation Sans en la imagen de Catalyst. |
| `score = 0` coalescido a null | Media | Alto | Enviar `0` numérico; gate `!= null`. Test dedicado. |
| Tokens de `status.name`/`type` distintos | Media | Alto | Vocabulario §4.3 como enum estricto; test de mapeo. |
| `cliente` no expuesto aún | Alta | Medio | Deuda §7 como prerequisito bloqueante. |
| Anidamiento aplanado → 0 detalles | Baja | Alto | §4.4 punto 3; validar shape de entrada. |

## Done criteria

- [ ] Función Catalyst devuelve PDF A4 dado `reportId` (auth + `portalType=ml` server-side).
- [ ] Port de `reportTransform.js` a Node con tests espejo (0 válido, null/''→null, títulos jerárquicos, `sin_evaluar`, buckets de evidencia).
- [ ] HTML standalone des-scopeado con logo inline (Anexo A) e `INDICE_PORTADA` verbatim.
- [ ] `page.pdf` con `printBackground:true` + `@page` 12mm; geometría reconciliada (§6.3).
- [ ] Arial + Noto Color Emoji en el contenedor de render.
- [ ] Backend expone `cliente` y aplica filtro `portalType` (deudas §7).
- [ ] **Comparación visual 1:1** contra el PDF de impresión nativa (portada, índice, cada tipo de sección, estados de color, score=0, sin transcripción).
- [ ] Frontend: botón "Descargar PDF" apunta a la función Catalyst.

---

## Anexo A — `logo-ml.png` como data-URI

> El único binario duro del circuito. `InformePdfTemplate.vue` lo importa como módulo Vite (`@/assets/logo-ml.png`, 33.410 bytes) → no es una URL y no viene en el payload. El backend lo **inline** como `data:image/png;base64,…` en el `src` del `<img class="pdf-cover__logo">` (fijado a `height:56px; width:auto`). Pegado acá para que viaje con el documento.

<details>
<summary>data-URI (base64, 44.548 chars) — click para expandir</summary>

```text
data:image/png;base64,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
```

</details>
