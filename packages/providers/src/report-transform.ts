/**
 * Normalización del informe: raw de la Custom API `GET_INSPECTION_REPORT_DETAIL` → modelo de
 * dominio `InformeReport`. **Port verbatim** del `reportTransform.js` del portal (misma lógica,
 * mismas reglas) — ver `docs/reference/pdf-backend/planning.md` §4.5 y §5.2.
 *
 * Vive en providers porque es la traducción del shape UPSTREAM (Zoho Creator) al dominio: la
 * usará `ZohoCreatorReportsSource` tras leer la Custom API. Es lógica PURA (sin HTTP) → testeable.
 *
 * Trampas de fallo silencioso que este port respeta (planning.md §4.4):
 *  - `vehicle.año` (clave literal con Ñ+tilde), `matricula`→`placa`, `kms` sin unidad.
 *  - Anidamiento OBLIGATORIO de 3 niveles: `modulos[].sub_modulos[].components[]`.
 *  - `score = 0` es VÁLIDO (gate `!= null`, nunca truthy).
 *  - vocabularios `status.name` / `evidence.type` exactos (lowercase snake).
 */
import type {
  EstadoComponente,
  Evidencia,
  InformeReport,
  ReportDetalle,
  ReportSeccion,
} from "@cardoc/domain";

// ── Shape crudo (Zoho Creator / GET_INSPECTION_REPORT_DETAIL) ──────────────────

interface RawStatus {
  name?: string;
  label?: string;
}
interface RawEvidence {
  type?: string;
  resource?: string;
  note?: string;
  nombreArchivo?: string;
}
interface RawComponent {
  id?: string;
  name?: string;
  description?: string;
  status?: RawStatus;
  ai_summary?: string;
  inspector_note?: string;
  evidences?: RawEvidence[];
}
interface RawSubModulo {
  name?: string;
  components?: RawComponent[];
}
interface RawModulo {
  name?: string;
  sub_modulos?: RawSubModulo[];
}
interface RawVehicle {
  marca?: string;
  modelo?: string;
  /** Clave literal con Ñ+tilde en el backend. */
  año?: string;
  matricula?: string;
  kms?: number;
  motor?: string;
  transmision?: string;
  image?: string;
}
interface RawInspector {
  name?: string;
  fecha?: string;
  telefono?: string;
}

/** Shape de entrada (`response.result`). Todo opcional: el transform defiende con `|| {}` / `?.`. */
export interface RawInspectionReport {
  code?: string;
  recomendaciones?: string;
  /** 0–10. Puede venir number, '' o null/ausente. `0` es válido. */
  score?: number | string | null;
  score_comentario?: string;
  summary_audio?: string;
  transcription_audio?: string;
  /** Discriminador de portal ('ml' | 'cardoc'). */
  portalType?: string;
  vehicle?: RawVehicle;
  inspector?: RawInspector;
  inspection_agency?: { name?: string };
  cliente?: { nombre?: string; telefono?: string };
  modulos?: RawModulo[];
}

// ── Helpers (verbatim) ─────────────────────────────────────────────────────────

/** Iniciales (máx 2) desde un nombre. Fallback "IC" si vacío. */
export const getInitials = (name: string): string => {
  if (!name) return "IC";
  const parts = name.split(" ");
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
};

/** `status.name` → estado interno. 'advertencia'→observacion, 'malo'→critico, resto→aprobado. */
const mapEstado = (statusName: string | undefined): EstadoComponente => {
  if (statusName === "advertencia") return "observacion";
  if (statusName === "malo") return "critico";
  return "aprobado";
};

/**
 * Puntaje 0–10: `''`/null/ausente → null (oculta la sección). `0` es VÁLIDO. Un valor NO numérico
 * (`"N/A"`) también → null (blinda contra imprimir "NaN/10"; el modelo exige `number | null`).
 */
function scoreOrNull(raw: number | string | null | undefined): number | null {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

// ── Transform ──────────────────────────────────────────────────────────────────

/** Normaliza una evidencia cruda a la del dominio (resource siempre string). */
function toEvidencia(e: RawEvidence): Evidencia {
  return { type: e.type ?? "", resource: e.resource ?? "", note: e.note, nombreArchivo: e.nombreArchivo };
}

export function transformReportData(apiData: RawInspectionReport): InformeReport {
  const vehicle = apiData.vehicle ?? {};
  const inspector = apiData.inspector ?? {};
  const inspectionAgency = apiData.inspection_agency ?? {};
  const cliente = apiData.cliente ?? {};
  const modulos = apiData.modulos ?? [];

  const secciones: ReportSeccion[] = [];
  const detalles: ReportDetalle[] = [];

  modulos.forEach((modulo, index) => {
    const seccionId = index + 1;

    secciones.push({
      id: seccionId,
      titulo: modulo.name || "Sin título",
      completada: false,
      activa: index === 0,
    });

    const seccionDetalles: ReportDetalle[] = [];
    modulo.sub_modulos?.forEach((subModulo) => {
      if (!subModulo.components?.length) return; // sub_modulo vacío → skip

      subModulo.components.forEach((componente) => {
        if (componente.status?.name === "sin_evaluar") return; // componente sin evaluar → skip entero

        const evidences = componente.evidences ?? [];
        const imagenes = evidences.filter((e) => e.type === "foto" && e.resource).map((e) => e.resource as string);

        // Título jerárquico "Módulo - [Submódulo] - Componente": trim, drop vacíos, colapsar
        // duplicados CONSECUTIVOS, join " - ", fallback "Sin nombre".
        const tituloJerarquico =
          [modulo.name, subModulo.name, componente.name]
            .map((p) => (p ?? "").trim())
            .filter(Boolean)
            .filter((p, i, arr) => i === 0 || p !== arr[i - 1])
            .join(" - ") || "Sin nombre";

        seccionDetalles.push({
          id: detalles.length + seccionDetalles.length + 1, // contador 1-based corrido
          componenteId: componente.id || null,
          seccionId,
          titulo: componente.name || "Sin nombre",
          subtitulo: subModulo.name || modulo.name || "",
          tituloJerarquico,
          estado: mapEstado(componente.status?.name),
          descripcion: componente.description || null,
          imagenes,
          audioData: evidences.filter((e) => e.type === "audio" && e.resource).map(toEvidencia),
          videoData: evidences.filter((e) => e.type === "video").map(toEvidencia), // se preservan sin resource
          pdfData: evidences.filter((e) => e.type === "ocr" && e.resource).map(toEvidencia),
          nota: componente.inspector_note || null,
          aiSummary: componente.ai_summary || null,
        });
      });
    });
    detalles.push(...seccionDetalles);
  });

  return {
    id: apiData.code || "",
    reportCode: apiData.code || "",
    recomendaciones: apiData.recomendaciones || null,
    vehiculo: {
      marca: vehicle.marca || "",
      modelo: vehicle.modelo || "",
      año: vehicle.año || "",
      placa: vehicle.matricula || "Sin matrícula",
      kilometraje: vehicle.kms ? `${vehicle.kms} km` : "",
      motor: vehicle.motor || "",
      transmision: vehicle.transmision || "",
      imagen: vehicle.image || "",
    },
    cliente: { nombre: cliente.nombre || "", telefono: cliente.telefono || "" },
    fechaInspeccion: inspector.fecha || "",
    inspector: {
      nombre: inspector.name || "Inspector",
      cargo: inspectionAgency.name ? `Inspector @ ${inspectionAgency.name}` : "Inspector",
      telefono: inspector.telefono || "",
      avatar: "",
      iniciales: getInitials(inspector.name || "I"),
    },
    resumenAudio: apiData.summary_audio || null,
    resumenTranscripcion: apiData.transcription_audio || null,
    score: scoreOrNull(apiData.score),
    score_comentario: apiData.score_comentario || "",
    secciones,
    detalles,
  };
}
