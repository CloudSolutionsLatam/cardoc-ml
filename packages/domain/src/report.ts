/**
 * Modelo del **Informe de Revisión** completo (el que alimenta el PDF).
 *
 * Es el shape de SALIDA del transform (raw Custom API `GET_INSPECTION_REPORT_DETAIL` →
 * este modelo), alineado 1:1 con el informe del portal de clientes (ver
 * `docs/reference/pdf-backend/planning.md` §4.6). cardoc-ml es el **generador único** del PDF.
 *
 * Distinto de `InformeRevision` (types.ts), que es el ítem liviano del listado (mock; el
 * endpoint de listado quedó descartado, ADR-0015). Este es el informe DETALLE, rico.
 */

/** Estado interno de un componente (mapeado desde `status.name` del backend). */
export type EstadoComponente = "aprobado" | "observacion" | "critico";

/** Evidencia de un componente (foto/audio/video/ocr). El PDF solo usa fotos y el conteo de audio/video. */
export interface Evidencia {
  type: string;
  resource: string;
  note?: string;
  nombreArchivo?: string;
}

export interface ReportVehiculo {
  marca: string;
  modelo: string;
  /** Clave literal con Ñ y tilde en el backend (`vehicle.año`) — ver planning.md §4.4. */
  año: string;
  /** Renombre de OUTPUT: viene como `vehicle.matricula`. Fallback "Sin matrícula". */
  placa: string;
  /** Ya con " km" si hay valor; '' si no (el número crudo `vehicle.kms` no trae unidad). */
  kilometraje: string;
  motor: string;
  transmision: string;
  /** URL de la imagen del vehículo. NO se usa en el PDF (sí en el portal). */
  imagen: string;
}

export interface ReportCliente {
  nombre: string;
  telefono: string;
}

export interface ReportInspector {
  nombre: string;
  /** "Inspector @ {agencia}" o "Inspector" si no hay agencia. */
  cargo: string;
  telefono: string;
  avatar: string;
  iniciales: string;
}

export interface ReportSeccion {
  id: number;
  titulo: string;
  completada: boolean;
  activa: boolean;
}

export interface ReportDetalle {
  /** Contador 1-based corrido en todo el informe (NO es id de backend). */
  id: number;
  /** Id estable del componente en backend (para damage map; el PDF no lo usa). */
  componenteId: string | null;
  seccionId: number;
  titulo: string;
  subtitulo: string;
  /** Único título que muestra el PDF por componente: "Módulo - Submódulo - Componente". */
  tituloJerarquico: string;
  estado: EstadoComponente;
  descripcion: string | null;
  /** URLs de fotos (WorkDrive). El PDF muestra hasta 6. */
  imagenes: string[];
  audioData: Evidencia[];
  videoData: Evidencia[];
  pdfData: Evidencia[];
  nota: string | null;
  aiSummary: string | null;
}

/** Informe de Revisión completo (salida del transform, entrada del generador de PDF). */
export interface InformeReport {
  id: string;
  reportCode: string;
  recomendaciones: string | null;
  vehiculo: ReportVehiculo;
  cliente: ReportCliente;
  fechaInspeccion: string;
  inspector: ReportInspector;
  /** URL del audio resumen. NO se usa en el PDF (sí en el portal). */
  resumenAudio: string | null;
  /** Transcripción del audio resumen. En el PDF va gateada por feature flag. */
  resumenTranscripcion: string | null;
  /** Puntaje técnico 0–10. **0 es válido**; `null` = no cargado (oculta la sección). */
  score: number | null;
  score_comentario: string;
  secciones: ReportSeccion[];
  detalles: ReportDetalle[];
}
