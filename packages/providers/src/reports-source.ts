/**
 * Puerto `ReportsSource` — lectura de Informes de Revisión y stream del PDF.
 *
 * Fuente real: Zoho Creator (form `Informes`/`Analisis`, source of truth) + WorkDrive
 * (archivos). Flujo del PDF (confirmado por Nestor): leer `Analisis.pdf_url`; si está
 * lleno → stream desde WorkDrive; si vacío → generar el PDF en Catalyst, guardar el
 * link en `Analisis.pdf_url` y luego stream. El consumidor NUNCA ve la URL/ubicación.
 */
import type { InformeRevision, ListInformesQuery, Page } from "@cardoc/domain";
import { Readable } from "node:stream";
import { NotImplementedError, ReportNotFoundError } from "./errors";

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

/** Mock con datos de muestra, para dev/test y para que los GET respondan en local. */
export class MockReportsSource implements ReportsSource {
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
      throw new ReportNotFoundError(id);
    }
    const pdf = Buffer.from(`%PDF-1.4\n% Mock PDF para ${id}\n`, "utf8");
    return { stream: Readable.from(pdf), contentType: "application/pdf", filename: `informe-${id}.pdf` };
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
