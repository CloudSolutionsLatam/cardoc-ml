/**
 * GET /v1/informes        — lista informes de la Cuenta autenticada (filtros + cursor).
 * GET /v1/informes/:id/pdf — stream autenticado del PDF, sin URL pública ni ruta interna.
 *
 * El `accountId` lo agrega el backend desde el token (tenancy); el consumidor nunca lo elige.
 */
import type { NextFunction, RequestHandler, Response } from "express";
import { listInformesQuerySchema } from "@cardoc/domain";
import { listInformes, streamReportPdf, streamReportPdfByNroSolicitud } from "@cardoc/application";
import { NotImplementedError, type ReportPdf } from "@cardoc/providers";
import type { AuthedRequest } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";

/** Setea headers (sin URL pública ni ruta interna) y pipea el PDF; 502 si falla antes del 1er byte. */
function pipePdfResponse(res: Response, next: NextFunction, pdf: ReportPdf): void {
  res.setHeader("Content-Type", pdf.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  pdf.stream.on("error", (err: Error) => {
    // Si aún no se enviaron bytes, se traduce a 502; si ya empezó, se corta la conexión.
    if (!res.headersSent) {
      next(new ApiError(502, "UPSTREAM_ERROR", "fallo al transmitir el PDF", { upstream: "workdrive" }));
    } else {
      res.destroy(err);
    }
  });
  pdf.stream.pipe(res);
}

export const listInformesHandler: RequestHandler = asyncHandler<AuthedRequest>(async (req, res): Promise<void> => {
  // `.strict()` → un parámetro fuera de la allowlist (p.ej. un filtro de Cuenta) falla.
  const parsed = listInformesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiError(422, "UNPROCESSABLE", "parámetros de consulta inválidos", {
      fields: parsed.error.flatten().fieldErrors,
    });
  }

  const container = req.container;
  const accountId = req.accountId;
  if (!container || !accountId) {
    throw new ApiError(500, "INTERNAL_ERROR", "container/cuenta no resueltos");
  }

  try {
    const page = await listInformes(accountId, parsed.data, { reports: container.reports });
    res.status(200).json({ ...page, correlationId: req.correlationId ?? "" });
  } catch (e) {
    // Listado descartado (ADR-0015: ML es push). El adapter real (creator) lanza NotImplementedError:
    // lo traducimos a un 501 LIMPIO en vez de un 500 genérico. Sigue operativo en modo mock (dev/test).
    if (e instanceof NotImplementedError) {
      throw new ApiError(501, "NOT_IMPLEMENTED", "el listado de informes no está disponible en este entorno (ML es push; ver ADR-0015)");
    }
    throw e;
  }
});

export const streamPdfHandler: RequestHandler = asyncHandler<AuthedRequest>(async (req, res, next): Promise<void> => {
  const container = req.container;
  const accountId = req.accountId;
  if (!container || !accountId) {
    throw new ApiError(500, "INTERNAL_ERROR", "container/cuenta no resueltos");
  }

  const id = req.params["id"] ?? "";
  // openPdf valida existencia + tenancy ANTES de devolver el stream (404 NOT_FOUND si ajeno).
  const pdf = await streamReportPdf(accountId, id, { reports: container.reports });
  pipePdfResponse(res, next, pdf);
});

/**
 * GET /v1/informes/solicitud/:nroSolicitud/pdf — variante que recibe el N.º de Solicitud externo
 * (no el id interno de Creator): resuelve el Análisis vía CRM (Informes Revisión) y streamea el PDF.
 */
export const streamPdfBySolicitudHandler: RequestHandler = asyncHandler<AuthedRequest>(async (req, res, next): Promise<void> => {
  const container = req.container;
  const accountId = req.accountId;
  if (!container || !accountId) {
    throw new ApiError(500, "INTERNAL_ERROR", "container/cuenta no resueltos");
  }
  const nroSolicitud = req.params["nroSolicitud"] ?? "";
  const pdf = await streamReportPdfByNroSolicitud(accountId, nroSolicitud, {
    crm: container.crm,
    connection: container.connection,
    reports: container.reports,
  });
  pipePdfResponse(res, next, pdf);
});
