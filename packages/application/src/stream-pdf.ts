/**
 * Use-case: abrir el stream del PDF de un informe (GET /v1/informes/{id}/pdf).
 *
 * El adapter (`ReportsSource.openPdf`) encapsula la generación perezosa con caché:
 * Analisis.pdf_url → WorkDrive, o generar en Catalyst + write-back. La resolución
 * id→fileId va SIEMPRE filtrada por la Cuenta del token (tenancy).
 */
import type { CrmClient, CrmConnection, ReportPdf, ReportsSource } from "@cardoc/providers";
import { ReportNotFoundError } from "@cardoc/providers";

export function streamReportPdf(
  accountId: string,
  id: string,
  deps: { reports: ReportsSource },
): Promise<ReportPdf> {
  return deps.reports.openPdf(accountId, id);
}

/**
 * Use-case: PDF por **N.º de Solicitud externo** (GET /v1/informes/solicitud/{nroSolicitud}/pdf).
 * Resuelve NroSolicitud → id de Análisis vía CRM (módulo Informes Revisión) y delega en `openPdf`
 * (que aplica tenancy). El consumidor nunca ve el id interno de Creator. (Variante D3b, 2026-07-02.)
 */
export async function streamReportPdfByNroSolicitud(
  accountId: string,
  nroSolicitudExterno: string,
  deps: { crm: CrmClient; connection: CrmConnection; reports: ReportsSource },
): Promise<ReportPdf> {
  const analisisId = await deps.crm.findAnalisisIdByNroSolicitud(nroSolicitudExterno, deps.connection);
  if (!analisisId) {
    throw new ReportNotFoundError(`solicitud:${nroSolicitudExterno}`); // → 404 NOT_FOUND (no divulgación)
  }
  return deps.reports.openPdf(accountId, analisisId);
}
