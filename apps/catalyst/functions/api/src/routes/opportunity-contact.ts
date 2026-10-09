/**
 * POST /v1/opportunity-contact — crea/reutiliza Contacto + crea Oportunidad
 * ('Nueva Solicitud', server-side). Idempotente por `NroSolicitud` (del body).
 *
 * La ruta solo valida forma y traduce el outcome del use-case a HTTP.
 */
import type { RequestHandler } from "express";
import { FIXED_OPPORTUNITY_STAGE, opportunityContactSchema } from "@cardoc/domain";
import { createOpportunityContact } from "@cardoc/application";
import type { AuthedRequest } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";

export const opportunityContactHandler: RequestHandler = asyncHandler<AuthedRequest>(async (req, res): Promise<void> => {
  // Inspección (CARDOC_ML_DEBUG=1): loggea el payload CRUDO que mandó ML antes de validar, así un
  // 400 también deja rastro de qué llegó. OJO: este body SÍ trae PII del consumidor final (cédula,
  // nombres, celular) — excepción opt-in a "logs sin payload" decidida por el owner (2026-08-04).
  const debugPayload = process.env["CARDOC_ML_DEBUG"] === "1";
  if (debugPayload) {
    console.log(
      `[opp-contact] inbound /opportunity-contact correlationId=${req.correlationId ?? "-"} payload=${JSON.stringify(req.body)}`,
    );
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
  const nroSolicitud = parsed.data.nroSolicitud;
  // Header OPCIONAL: si viene, activa la idempotencia de Capa 1 (DataStore de Catalyst).
  // Sin él, la dedup la hace el CRM (Capa 2, por EXTERNAL_ID/cédula). Ver ADR-0002.
  const idemHeader = req.headers["x-idempotency-key"];
  const idempotencyKey =
    typeof idemHeader === "string" && idemHeader.trim() !== "" ? idemHeader.trim() : undefined;
  const outcome = await createOpportunityContact(
    parsed.data,
    { accountId, correlationId, idempotencyKey },
    { opportunities: container.opportunities, crm: container.crm, connection: container.connection },
  );

  // La decisión también se loggea bajo inspección (created/duplicate/in_progress/conflict/error),
  // para correlacionar payload → resultado en los Logs sin abrir el audit_log.
  if (debugPayload) {
    console.log(
      `[opp-contact] correlationId=${correlationId || "-"} nroSolicitud=${nroSolicitud} -> outcome=${outcome.status}`,
    );
  }

  switch (outcome.status) {
    case "created":
      res.status(201).json({
        status: "created",
        correlationId,
        nroSolicitud,
        contact: { id: outcome.contactId, reused: outcome.reusedContact },
        opportunity: { id: outcome.opportunityId, stage: FIXED_OPPORTUNITY_STAGE },
      });
      return;
    case "duplicate":
      res.status(200).json({
        status: "duplicate",
        correlationId,
        nroSolicitud,
        contact: { id: outcome.contactId },
        opportunity: { id: outcome.opportunityId, stage: FIXED_OPPORTUNITY_STAGE },
      });
      return;
    case "in_progress":
      res.status(202).json({ status: "in_progress", correlationId, nroSolicitud });
      return;
    case "conflict":
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "el mismo NroSolicitud llegó con un payload distinto",
        { nroSolicitud },
      );
    case "error":
      // Motivo real del CRM SIEMPRE al log (no solo bajo debug): sin esto un 502 es una caja negra.
      // El mensaje lo arma el adapter (code + api_name del campo culpable), sin valores del payload.
      // Al consumidor le sigue llegando el sobre opaco.
      console.error(
        `[opp-contact] correlationId=${correlationId || "-"} nroSolicitud=${nroSolicitud} crm error: ${outcome.message}`,
      );
      throw new ApiError(502, "UPSTREAM_ERROR", "no se pudo crear en CRM", { upstream: "crm" });
  }
});
