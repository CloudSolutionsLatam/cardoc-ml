/**
 * `streamReportPdfByNroSolicitud` (variante D3b): NroSolicitud externo → id de Análisis (CRM)
 * → openPdf(Cuenta, analisisId). 404 si el NroSolicitud no resuelve.
 */
import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { CrmClient, CrmConnection, ReportPdf, ReportsSource } from "@cardoc/providers";
import { ReportNotFoundError } from "@cardoc/providers";
import { streamReportPdfByNroSolicitud } from "../src/stream-pdf";

const conn: CrmConnection = { apiDomain: "https://x", getAccessToken: async () => "tok" };

function crmStub(resolve: (n: string) => string | null): CrmClient {
  return {
    findContactByCedula: async () => null,
    createContact: async () => ({ id: "", duplicate: false }),
    createOpportunity: async () => ({ id: "", duplicate: false }),
    findAnalisisIdByNroSolicitud: async (n) => resolve(n),
  };
}

function reportsStub(openPdf: ReportsSource["openPdf"]): ReportsSource {
  return {
    listByAccount: async () => ({ data: [], page: { limit: 10, nextCursor: null, hasMore: false } }),
    findById: async () => null,
    openPdf,
  };
}

const pdf: ReportPdf = { stream: Readable.from(Buffer.from("%PDF-")), contentType: "application/pdf", filename: "f.pdf" };

describe("streamReportPdfByNroSolicitud", () => {
  it("resuelve NroSolicitud → id de Análisis y abre el PDF de esa Cuenta", async () => {
    const openPdf = vi.fn(async (_acc: string, _id: string) => pdf);
    const out = await streamReportPdfByNroSolicitud("acc_dev", "1001", {
      crm: crmStub((n) => (n === "1001" ? "AN-9" : null)),
      connection: conn,
      reports: reportsStub(openPdf),
    });
    expect(out).toBe(pdf);
    expect(openPdf).toHaveBeenCalledWith("acc_dev", "AN-9"); // tenancy: la Cuenta la pone el backend
  });

  it("NroSolicitud inexistente → ReportNotFoundError (→404), sin tocar openPdf", async () => {
    const openPdf = vi.fn(async () => pdf);
    await expect(
      streamReportPdfByNroSolicitud("acc_dev", "nope", {
        crm: crmStub(() => null),
        connection: conn,
        reports: reportsStub(openPdf),
      }),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
    expect(openPdf).not.toHaveBeenCalled();
  });
});
