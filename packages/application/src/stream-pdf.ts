/**
 * Use-case: abrir el stream del PDF de un informe (GET /v1/informes/{id}/pdf).
 *
 * El adapter (`ReportsSource.openPdf`) encapsula la generación perezosa con caché:
 * Analisis.pdf_url → WorkDrive, o generar en Catalyst + write-back. La resolución
 * id→fileId va SIEMPRE filtrada por la Cuenta del token (tenancy).
 */
import type { ReportPdf, ReportsSource } from "@cardoc/providers";

export function streamReportPdf(
  accountId: string,
  id: string,
  deps: { reports: ReportsSource },
): Promise<ReportPdf> {
  return deps.reports.openPdf(accountId, id);
}
