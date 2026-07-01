/**
 * Puerto `ReportsSource` — lectura de Informes de Revisión y stream del PDF.
 *
 * Fuente real: Zoho Creator (form `Informes`/`Analisis`, source of truth) + WorkDrive
 * (archivos). Flujo del PDF (confirmado por Nestor): leer `Analisis.pdf_url`; si está
 * lleno → stream desde WorkDrive; si vacío → generar el PDF en Catalyst, guardar el
 * link en `Analisis.pdf_url` y luego stream. El consumidor NUNCA ve la URL/ubicación.
 */
import type { InformeReport, InformeRevision, ListInformesQuery, Page } from "@cardoc/domain";
import { Readable } from "node:stream";
import { NotImplementedError, ReportNotFoundError } from "./errors";
import { PdfLibReportGenerator, type PdfGenerator } from "./pdf-generator";

/** Resultado del stream del PDF: el `Readable` se pipea directo al `res` de Express. */
export interface ReportPdf {
  stream: Readable;
  contentType: string;
  filename: string;
}

export interface ReportsSource {
  /** Lista informes de la Cuenta (filtro de Cuenta agregado por el backend, no por el consumidor). */
  listByAccount(accountId: string, query: ListInformesQuery): Promise<Page<InformeRevision>>;
  findById(accountId: string, id: string): Promise<InformeRevision | null>;
  /** Abre el stream del PDF (resuelve Analisis.pdf_url → WorkDrive, o genera si falta). */
  openPdf(accountId: string, id: string): Promise<ReportPdf>;
}

/**
 * Fuente de informes de muestra para dev/test. `openPdf` genera un PDF **real** (pdf-lib) a
 * partir de los datos de muestra — el read desde Creator (`Analisis`) se cablea en E-03; la
 * generación ya es real y streameable. El listado sigue siendo data de muestra.
 */
export class MockReportsSource implements ReportsSource {
  constructor(private readonly pdfGenerator: PdfGenerator = new PdfLibReportGenerator()) {}

  private sample(accountId: string): InformeRevision[] {
    return [
      { id: `${accountId}-INF-001`, estado: "completado", matricula: "ABC1234", vehiculo: "VW Amarok 2018", cliente: "Cliente Demo", fecha: "2026-06-20", pdfDisponible: true },
      { id: `${accountId}-INF-002`, estado: "en_progreso", matricula: "XYZ9876", vehiculo: "Toyota Hilux 2021", cliente: "Cliente Demo 2", fecha: "2026-06-24", pdfDisponible: false },
    ];
  }

  async listByAccount(accountId: string, query: ListInformesQuery): Promise<Page<InformeRevision>> {
    let data = this.sample(accountId);
    if (query.estado) {
      data = data.filter((r) => r.estado === query.estado);
    }
    if (query.matricula) {
      data = data.filter((r) => r.matricula === query.matricula);
    }
    const limited = data.slice(0, query.limit);
    return { data: limited, page: { limit: query.limit, nextCursor: null, hasMore: false } };
  }

  async findById(accountId: string, id: string): Promise<InformeRevision | null> {
    return this.sample(accountId).find((r) => r.id === id) ?? null;
  }

  async openPdf(accountId: string, id: string): Promise<ReportPdf> {
    const informe = await this.findById(accountId, id);
    if (!informe) {
      throw new ReportNotFoundError(id); // no existe / de otra Cuenta → 404 (tenancy)
    }
    // Generación perezosa: hoy se genera siempre (el read real de Analisis + caché es E-03).
    // Se arma un InformeReport de MUESTRA (los datos ricos vienen de Creator al cablear E-03).
    const bytes = await this.pdfGenerator.generate(this.sampleReport(informe));
    return {
      stream: Readable.from(Buffer.from(bytes)),
      contentType: "application/pdf",
      filename: `informe-${id}.pdf`,
    };
  }

  /** Informe rico de muestra a partir del ítem liviano (stand-in del read de Creator, E-03). */
  private sampleReport(informe: InformeRevision): InformeReport {
    // Parse robusto del string de muestra ("VW Amarok 2018", "Toyota Land Cruiser 2020"):
    // año = último token si es 4 dígitos; marca = primero; modelo = lo del medio.
    const tokens = (informe.vehiculo ?? "").split(" ").filter(Boolean);
    const anio = tokens.length && /^\d{4}$/.test(tokens[tokens.length - 1] ?? "") ? (tokens.pop() as string) : "";
    const marca = tokens.shift() ?? "";
    const modelo = tokens.join(" ");
    const det = (
      id: number,
      seccionId: number,
      tituloJerarquico: string,
      estado: InformeReport["detalles"][number]["estado"],
      extra: Partial<InformeReport["detalles"][number]> = {},
    ): InformeReport["detalles"][number] => ({
      id,
      componenteId: `c${id}`,
      seccionId,
      titulo: tituloJerarquico,
      subtitulo: "",
      tituloJerarquico,
      estado,
      descripcion: null,
      imagenes: [],
      audioData: [],
      videoData: [],
      pdfData: [],
      nota: null,
      aiSummary: null,
      ...extra,
    });
    return {
      id: informe.id,
      reportCode: informe.id,
      recomendaciones:
        "Realizar service de mantenimiento en los próximos 1.000 km y revisar el desgaste de pastillas de freno delanteras.",
      vehiculo: {
        marca,
        modelo,
        año: anio,
        placa: informe.matricula ?? "Sin matrícula",
        kilometraje: "90.000 km",
        motor: "2.0 TDI",
        transmision: "Automática",
        imagen: "",
      },
      cliente: { nombre: informe.cliente ?? "", telefono: "099 123 456" },
      fechaInspeccion: informe.fecha ?? "",
      inspector: { nombre: "Inspector Demo", cargo: "Inspector @ AutoCheck", telefono: "", avatar: "", iniciales: "ID" },
      resumenAudio: null,
      resumenTranscripcion:
        "El vehículo se encuentra en buen estado general. Se detectaron observaciones menores en el tren delantero y una fuga leve de aceite sin criticidad.",
      score: 8,
      score_comentario: "Buen estado general, con observaciones menores no críticas.",
      secciones: [
        { id: 1, titulo: "Chasis", completada: true, activa: true },
        { id: 2, titulo: "Mecánica", completada: true, activa: false },
      ],
      detalles: [
        det(1, 1, "Chasis - Frente - Larguero delantero izquierdo", "aprobado", {
          descripcion: "Sin deformaciones ni signos de reparación estructural.",
        }),
        det(2, 1, "Chasis - Piso - Zona de anclaje", "observacion", {
          descripcion: "Óxido superficial incipiente en la zona de anclaje.",
          nota: "Tratar con antióxido en el próximo service.",
          aiSummary: "Corrosión superficial no estructural; monitorear evolución.",
        }),
        det(3, 2, "Mecánica - Motor - Sellos y juntas", "critico", {
          descripcion: "Fuga de aceite en la tapa de válvulas.",
          aiSummary: "Fuga activa; requiere reemplazo de junta a corto plazo.",
          audioData: [{ type: "audio", resource: "wd://audio/1" }],
        }),
      ],
    };
  }
}

/**
 * Adapter real Zoho Creator + WorkDrive. STUB — se implementa en E-03. `openPdf`
 * encapsula la generación perezosa con caché (Analisis.pdf_url → WorkDrive | generar
 * → write-back). Único lugar autorizado a hablar HTTP con Creator/WorkDrive.
 */
export class ZohoCreatorReportsSource implements ReportsSource {
  async listByAccount(_accountId: string, _query: ListInformesQuery): Promise<Page<InformeRevision>> {
    throw new NotImplementedError("ZohoCreatorReportsSource", "listByAccount");
  }

  async findById(_accountId: string, _id: string): Promise<InformeRevision | null> {
    throw new NotImplementedError("ZohoCreatorReportsSource", "findById");
  }

  async openPdf(_accountId: string, _id: string): Promise<ReportPdf> {
    throw new NotImplementedError("ZohoCreatorReportsSource", "openPdf");
  }
}
