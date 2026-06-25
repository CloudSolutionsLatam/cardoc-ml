/**
 * GET /v1/informes        — lista informes de la Cuenta autenticada (filtros + cursor).
 * GET /v1/informes/:id/pdf — stream autenticado del PDF, sin URL pública ni ruta interna.
 *
 * El `accountId` lo agrega el backend desde el token (tenancy); el consumidor nunca lo elige.
 */
import type { RequestHandler } from "express";
import { listInformesQuerySchema } from "@cardoc/domain";
import { listInformes, streamReportPdf } from "@cardoc/application";
import type { AuthedRequest } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";

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

  const page = await listInformes(accountId, parsed.data, { reports: container.reports });
  res.status(200).json({ ...page, correlationId: req.correlationId ?? "" });
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

  // Headers ANTES del primer byte. Sin URL pública, sin redirect 302, sin ubicación interna.
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
});
