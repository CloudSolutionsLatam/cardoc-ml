/**
 * Auditoría on-finish (AC-09): exactamente 1 registro por request, en los 3 endpoints,
 * capturando http_status + latency_ms + correlationId + outcome ya conocidos al cierre
 * de la respuesta. Se registra desde un único lugar (no dentro de cada use-case), así
 * los GET (sin use-case que audite) también quedan auditados.
 *
 * No loguea payload, PII ni bytes del PDF — solo identificadores y estado.
 */
import type { NextFunction, Response } from "express";
import type { AuditLogEntry } from "@cardoc/persistence";
import type { AuthedRequest } from "./auth";

export function auditOnFinish(req: AuthedRequest, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    const container = req.container;
    if (!container) {
      // /v1/health u otras rutas sin auth/container → no se auditan.
      return;
    }
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      correlationId: req.correlationId ?? "",
      consumerId: req.consumerId ?? "anonymous",
      accountId: req.accountId ?? "",
      endpoint: req.endpoint ?? `${req.method} ${req.path}`,
      outcome: res.statusCode < 400 ? "success" : "error",
      httpStatus: res.statusCode,
      latencyMs: req.startMs ? Date.now() - req.startMs : 0,
      errorCode: req.errorCode ?? null,
    };
    void container.audit.append(entry).catch((e: unknown) => {
      console.error(
        `[audit] correlationId=${entry.correlationId} append failed: ${(e as Error).message}`,
      );
    });
  });
  next();
}
