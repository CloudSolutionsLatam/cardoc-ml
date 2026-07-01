/**
 * Rutas internas (CRM → Catalyst), NO expuestas al consumidor público.
 *
 * `POST /v1/internal/deal-estado` — lo dispara el workflow del CRM cuando cambia el
 * `Stage` de un Deal; notifica el cambio de estado a ML. Se protege con shared-secret
 * (`x-internal-secret`), no con Bearer (es una llamada de confianza CRM↔Catalyst).
 */
import type { RequestHandler } from "express";
import { dealEstadoSchema } from "@cardoc/domain";
import { notifyEstadoChange } from "@cardoc/application";
import type { AuthedRequest } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";

export const dealEstadoHandler: RequestHandler = asyncHandler<AuthedRequest>(async (req, res): Promise<void> => {
  req.endpoint = "internal-deal-estado";
  const parsed = dealEstadoSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "payload inválido", { fields: parsed.error.flatten().fieldErrors });
  }
  const container = req.container;
  if (!container) {
    throw new ApiError(500, "INTERNAL_ERROR", "container no adjunto");
  }

  const correlationId = req.correlationId ?? "";
  const outcome = await notifyEstadoChange(parsed.data, { mlCenter: container.mlCenter });

  switch (outcome.status) {
    case "sent":
      res.status(200).json({ status: "sent", estado: outcome.estado, correlationId });
      return;
    case "skipped":
      // El Stage no corresponde a un estado notificable a ML — no es error.
      res.status(200).json({ status: "skipped", reason: outcome.reason, correlationId });
      return;
    case "invalid":
      // Falla de validación del invariante (p.ej. FINALIZADO sin LinkResultado): ML nunca se
      // llamó → 422, NO 502. Reintentar contra ML no arregla un payload incompleto.
      throw new ApiError(422, "UNPROCESSABLE", outcome.message);
    case "error":
      // Falla REAL del upstream ML.
      throw new ApiError(502, "UPSTREAM_ERROR", "no se pudo notificar el estado a ML", { upstream: "mlcenter" });
  }
});
