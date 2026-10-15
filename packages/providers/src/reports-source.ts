/**
 * Puerto `ReportsSource` — lectura de Informes de Revisión y stream del PDF.
 *
 * Fuente real: Zoho Creator (form `Informes`/`Analisis`, source of truth) + WorkDrive
 * (archivos). Flujo del PDF (confirmado por Nestor): leer `Analisis.pdf_url`; si está
 * lleno → stream desde WorkDrive; si vacío → generar el PDF en Catalyst, guardar el
 * link en `Analisis.pdf_url` y luego stream. El consumidor NUNCA ve la URL/ubicación.
 */
import type { InformeReport, InformeRevision, ListInformesQuery, Page } from "@cardoc/domain";
import { availableParallelism } from "node:os";
import { Readable } from "node:stream";
import { NotImplementedError, ReportNotFoundError, UpstreamError } from "./errors";
import type { ImageOptimizer } from "./image-optimizer";
import { PdfLibReportGenerator, type ImageFetcher, type PdfGenerator, type PhotoStats } from "./pdf-generator";
import { transformReportData } from "./report-transform";
import type { ReportDetailFetcher } from "./creator-client";
import { PORTAL_TYPE, shouldRejectDetailByPortalType } from "./portal-type";

/** Resultado del stream del PDF: el `Readable` se pipea directo al `res` de Express. */
export interface ReportPdf {
  stream: Readable;
  contentType: string;
  filename: string;
  /**
   * Bytes totales cuando se conocen (el PDF ya está completo en memoria). Se envía como
   * `Content-Length`: sin él la respuesta sale `chunked` y el gateway de Catalyst devuelve
   * `200` VACÍO para PDFs grandes (medido en dev 2026-10-15: 51 MB y 70 MB → 0 bytes).
   */
  contentLength?: number;
}

/** Envuelve los bytes del PDF SIN copiarlos (un PDF de 50 MB no se duplica en memoria; tope 512 MB). */
function pdfStream(bytes: Uint8Array): Readable {
  return Readable.from(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export interface ReportsSource {
  /** Lista informes de la Cuenta (filtro de Cuenta agregado por el backend, no por el consumidor). */
  listByAccount(accountId: string, query: ListInformesQuery): Promise<Page<InformeRevision>>;
  findById(accountId: string, id: string): Promise<InformeRevision | null>;
  /** Abre el stream del PDF (resuelve Analisis.pdf_url → WorkDrive, o genera si falta). */
  openPdf(accountId: string, id: string): Promise<ReportPdf>;
}

/** Sanitiza un componente para nombre de archivo: sin acentos, solo [A-Za-z0-9], resto → "-". */
function sanitizeFilenamePart(value: string, fallback: string): string {
  const clean = (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // quita marcas combinantes (acentos, tilde de la ñ) tras NFD
    .replace(/[^A-Za-z0-9]+/g, "-") // todo lo no alfanumérico (espacios, /, #, ", _) -> guion
    .replace(/^-+|-+$/g, ""); // recorta guiones de los extremos
  return clean || fallback;
}

/** Fecha "dd/mm/yyyy" (o ya ISO "AAAA-MM-DD") → ISO 8601 "AAAA-MM-DD"; si no parsea, `fallback`. */
function toIsoDate(value: string, fallback: string): string {
  const s = (value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : fallback;
}

/**
 * Nomenclatura del PDF (decisión §10 D4, confirmada por Cardoc 2026-07-02):
 * `NombreCliente_IDInterno_Fecha.pdf` con fecha en ISO 8601 (AAAA-MM-DD).
 * - NombreCliente ← `cliente.nombre` (fallback "Cliente").
 * - IDInterno ← `reportCode` (hoy "#R-12345"; PENDIENTE que el backend exponga el "INFREV-xxxx"
 *   del CRM en el detalle — ver OQ). Fallback al `id` de la URL.
 * - Fecha ← `fechaInspeccion` normalizada a ISO; si no viene o no parsea, `fallbackDate` (el adapter
 *   Creator pasa la fecha de generación mientras la Custom API no devuelva `inspector.fecha`; default
 *   "sin-fecha").
 */
export function buildReportFilename(informe: InformeReport, fallbackId: string, fallbackDate = "sin-fecha"): string {
  const cliente = sanitizeFilenamePart(informe.cliente?.nombre ?? "", "Cliente");
  const idInterno = sanitizeFilenamePart(informe.reportCode ?? "", sanitizeFilenamePart(fallbackId, "informe"));
  const fecha = toIsoDate(informe.fechaInspeccion ?? "", fallbackDate);
  return `${cliente}_${idInterno}_${fecha}.pdf`;
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
    const report = this.sampleReport(informe);
    const bytes = await this.pdfGenerator.generate(report);
    return {
      stream: pdfStream(bytes),
      contentType: "application/pdf",
      contentLength: bytes.byteLength,
      filename: buildReportFilename(report, id),
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

export interface ZohoCreatorReportsSourceDeps {
  /** Trae el envelope crudo del informe (HTTP server-to-server; ver creator-client.ts). */
  fetchReportDetail: ReportDetailFetcher;
  /** Fetcher de fotos de WorkDrive (OAuth). Sin él, las fotos van como placeholder. */
  fetchImage?: ImageFetcher;
  /** Texto "Generado:" del PDF (el container estampa la fecha del request). */
  generatedAt?: string;
  /** Descargas de fotos en paralelo (default del generador; tunable por env desde el container). */
  imageConcurrency?: number;
  /** Reduce/endereza las fotos antes de embeberlas (ADR-0016). Sin él (o sin sharp), originales. */
  optimizeImage?: ImageOptimizer;
  /** Inyectable para tests; por defecto pdf-lib con el `fetchImage`/`generatedAt` provistos. */
  pdfGenerator?: PdfGenerator;
}

/**
 * Línea de log `[pdf-fotos]` (sin URLs ni PII): peso antes/después, fotos reducidas/enderezadas/
 * duplicadas/perdidas y CPUs visibles — para dimensionar la reducción en el entorno REAL (la ventana
 * de Advanced I/O es 30s y la CPU de Catalyst no se conoce de antemano). Exportado para test.
 */
export function describePhotoStats(s: PhotoStats, optimizer: boolean): string {
  const mb = (n: number): string => (n / 1e6).toFixed(1);
  return (
    `[pdf-fotos] informe=${s.reportCode} urls=${s.urls} unicas=${s.unicas} duplicadas=${s.duplicadas} ` +
    `fallidas=${s.fallidas} optimizador=${optimizer ? "sharp" : "off"} reducidas=${s.reducidas} ` +
    `enderezadas=${s.enderezadas} MB=${mb(s.bytesOriginales)}->${mb(s.bytesEmbebidos)} ` +
    `optimizeMs=${s.optimizeMs} descargas=${s.descargasParalelas} descargaMs=${s.descargaMs} fotosMs=${s.fotosMs} ` +
    `cpus=${availableParallelism()}`
  );
}

/**
 * Adapter real Zoho Creator + WorkDrive (E-03). `openPdf`: trae el detalle por REST →valida el
 * envelope →aplica la defensa `portalType` →`transformReportData` →genera el PDF (fotos desde
 * WorkDrive) →streamea. Único lugar autorizado a HTTP con Creator/WorkDrive.
 *
 * El **listado** (`listByAccount`/`findById`) queda sin implementar: ML es push, el pull se
 * descartó (ADR-0015). La resolución perezosa con caché (`Analisis.pdf_url` → stream | generar +
 * write-back) es un paso posterior; hoy se **genera siempre** desde los datos del detalle.
 */
export class ZohoCreatorReportsSource implements ReportsSource {
  private readonly gen: PdfGenerator;
  constructor(private readonly deps: ZohoCreatorReportsSourceDeps) {
    this.gen =
      deps.pdfGenerator ??
      new PdfLibReportGenerator({
        fetchImage: deps.fetchImage,
        generatedAt: deps.generatedAt,
        imageConcurrency: deps.imageConcurrency,
        optimizeImage: deps.optimizeImage,
        onPhotoStats: (s) => console.log(describePhotoStats(s, deps.optimizeImage !== undefined)),
        // Hito intermedio: queda en el log aunque después la función corte por tiempo (red vs. CPU).
        onPhotoDownloadsDone: (d) =>
          console.log(
            `[pdf-fotos] informe=${d.reportCode} descargas completas: urls=${d.urls} descargas=${d.descargasParalelas} ` +
              `MB=${(d.bytesOriginales / 1e6).toFixed(1)} descargaMs=${d.descargaMs} pendientes=${d.pendientes}`,
          ),
      });
  }

  async listByAccount(_accountId: string, _query: ListInformesQuery): Promise<Page<InformeRevision>> {
    throw new NotImplementedError("ZohoCreatorReportsSource", "listByAccount"); // ADR-0015: listado descartado
  }

  async findById(_accountId: string, _id: string): Promise<InformeRevision | null> {
    throw new NotImplementedError("ZohoCreatorReportsSource", "findById"); // ADR-0015
  }

  async openPdf(_accountId: string, id: string): Promise<ReportPdf> {
    const t0 = Date.now();
    const env = await this.deps.fetchReportDetail(id, PORTAL_TYPE);
    const tDetail = Date.now() - t0;
    // Envelope: cualquier code != 3000 (o env/result ausente) es error del upstream (§4.1).
    if (!env || env.code !== 3000 || !env.result) {
      throw new UpstreamError("creator", 502, `envelope inválido (code=${env?.code ?? "?"})`);
    }
    const result = env.result;
    // result de ERROR del upstream: `status` numérico >=400 (401 UNAUTHORIZED, 403, 500…). → 502,
    // NUNCA transformar (un result de error daría un PDF vacío con 200, enmascarando la falla).
    if (typeof result.status === "number" && result.status >= 400) {
      throw new UpstreamError("creator", 502, `Creator error (status=${result.status}${result.error ? ` ${result.error}` : ""})`);
    }
    // Defensa portalType (§5.3): recurso de otro portal → NOT_FOUND (no revelar existencia).
    if (shouldRejectDetailByPortalType(result, PORTAL_TYPE)) {
      throw new ReportNotFoundError(id);
    }
    const informe = transformReportData(result);
    const tGen0 = Date.now();
    const bytes = await this.gen.generate(informe);
    // Telemetría de fases (logs de la función): permite diagnosticar dónde se va el tiempo EN EL
    // ENTORNO REAL (la ventana de Advanced I/O es 30s y el óptimo de concurrencia varía por entorno).
    console.log(
      `[pdf] id=${id} detailMs=${tDetail} genMs=${Date.now() - tGen0} pdfBytes=${bytes.length} componentes=${informe.detalles.length}`,
    );
    return {
      stream: pdfStream(bytes),
      contentType: "application/pdf",
      contentLength: bytes.byteLength,
      // Fallback de fecha del nombre: hoy la Custom API no devuelve `inspector.fecha` fiable
      // (pendiente en el Deluge, junto con motor/transmisión) → usamos la fecha de GENERACIÓN.
      filename: buildReportFilename(informe, id, toIsoDate(this.deps.generatedAt ?? "", "sin-fecha")),
    };
  }
}
