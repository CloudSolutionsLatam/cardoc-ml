/**
 * POST /v1/opportunity-contact — crea/reutiliza Contacto + crea Oportunidad
 * ('Agendamiento Ready', fijado server-side). Idempotente por X-Idempotency-Key.
 *
 * La ruta solo valida forma + headers y traduce el outcome del use-case a HTTP.
 */
import type { RequestHandler } from "express";
import { FIXED_OPPORTUNITY_STAGE, opportunityContactSchema } from "@cardoc/domain";
import { createOpportunityContact } from "@cardoc/application";
import type { AuthedRequest } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";

export const opportunityContactHandler: RequestHandler = asyncHandler<AuthedRequest>(async (req, res): Promise<void> => {
  const idempotencyKey = req.header("x-idempotency-key")?.trim() ?? "";
  if (idempotencyKey.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "falta el header X-Idempotency-Key", {
      header: "X-Idempotency-Key",
    });
  }

  const parsed = opportunityContactSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "payload inválido", {
      fields: parsed.error.flatten().fieldErrors,
    });
  }

  const container = req.container;
  const accountId = req.accountId;
  if (!container || !accountId) {
    throw new ApiError(500, "INTERNAL_ERROR", "container/cuenta no resueltos");
  }

  const correlationId = req.correlationId ?? "";
  const outcome = await createOpportunityContact(
    parsed.data,
    { accountId, correlationId, idempotencyKey },
    { opportunities: container.opportunities, crm: container.crm, connection: container.connection },
  );

  switch (outcome.status) {
    case "created":
      res.status(201).json({
        status: "created",
        correlationId,
        idempotencyKey,
        contact: { id: outcome.contactId, reused: outcome.reusedContact },
        opportunity: { id: outcome.opportunityId, stage: FIXED_OPPORTUNITY_STAGE },
      });
      return;
    case "duplicate":
      res.status(200).json({
        status: "duplicate",
        correlationId,
        idempotencyKey,
        contact: { id: outcome.contactId },
        opportunity: { id: outcome.opportunityId, stage: FIXED_OPPORTUNITY_STAGE },
      });
      return;
    case "in_progress":
      res.status(202).json({ status: "in_progress", correlationId, idempotencyKey });
      return;
    case "conflict":
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "la misma X-Idempotency-Key se usó con un payload distinto",
        { idempotencyKey },
      );
    case "error":
      throw new ApiError(502, "UPSTREAM_ERROR", "no se pudo crear en CRM", { upstream: "crm" });
  }
});
