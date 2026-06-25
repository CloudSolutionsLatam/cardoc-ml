/**
 * Sobre de error ÚNICO + manejo async para Express 4.
 *
 * Express 4 NO captura rechazos de promesas en handlers `async`: `asyncHandler` envía
 * cualquier rechazo a `next(err)`. `errorMiddleware` (último del app) traduce TODO al
 * sobre único `{ error: { code, message, correlationId, details? } }`, SIN filtrar
 * detalle interno, PII ni URLs/rutas/fileId del upstream.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { PdfNotAvailableError, ReportNotFoundError, UpstreamError } from "@cardoc/providers";
import type { AuthedRequest } from "./auth";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN_SCOPE"
  | "NOT_FOUND"
  | "PDF_NOT_AVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "UNPROCESSABLE"
  | "CAP_EXCEEDED"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

/** Error de transporte con código estable e independiente del HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Envuelve un handler async tipado por su Request, devolviendo un RequestHandler de Express. */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req as Req, res, next).catch(next);
  };
}

/** Traduce errores conocidos de los puertos a un ApiError con código opaco. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  if (err instanceof ReportNotFoundError) {
    return new ApiError(404, "NOT_FOUND", "recurso no encontrado");
  }
  if (err instanceof PdfNotAvailableError) {
    return new ApiError(404, "PDF_NOT_AVAILABLE", "PDF no disponible", { informeId: err.id });
  }
  if (err instanceof UpstreamError) {
    // details.upstream = etiqueta OPACA ("crm"|"creator"|"workdrive"); nunca la URL interna.
    return new ApiError(502, "UPSTREAM_ERROR", "error del sistema upstream", { upstream: err.upstream });
  }
  return new ApiError(500, "INTERNAL_ERROR", "error interno");
}

/** Error handler global (4 args = Express lo reconoce como tal). Se monta al final. */
export function errorMiddleware(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const apiError = toApiError(err);
  const authed = req as AuthedRequest;
  const correlationId = authed.correlationId ?? null;

  // Log operativo: solo IDs y código, nunca payload/PII ni URL interna.
  console.error(`[error] correlationId=${correlationId ?? "-"} ${req.method} ${req.path} ${apiError.code}`);

  // Marca el código para que la auditoría on-finish lo registre.
  authed.errorCode = apiError.code;

  res.status(apiError.httpStatus).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      correlationId,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  });
}
