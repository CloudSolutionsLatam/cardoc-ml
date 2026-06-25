/**
 * Use-case: crear/reutilizar Contacto + crear Oportunidad (POST /v1/opportunity-contact).
 *
 * Orquesta el pipeline sobre los PUERTOS, sin saber de Express ni de Catalyst.
 *
 *   idempotency seed → (replay/conflict? corta) → findContact|createContact →
 *   createOpportunity(stage fijo) → markCreated
 *
 * Garantía rectora: la Oportunidad NO se duplica. El row "pending" se siembra con
 * `(accountId, idempotencyKey)` (UNIQUE) ANTES de tocar CRM; solo el creador ejecuta
 * el efecto externo. Misma clave + payload distinto → conflicto (AC-08).
 */
import {
  FIXED_OPPORTUNITY_STAGE,
  payloadFingerprint,
  type OpportunityContactInput,
} from "@cardoc/domain";
import type { CrmClient, CrmConnection } from "@cardoc/providers";
import type { OpportunitiesRepository, OpportunityRecord } from "@cardoc/persistence";

export interface CreateOpportunityContext {
  /** Cuenta resuelta del token (middleware de auth) — NUNCA del payload. */
  accountId: string;
  correlationId: string;
  /** = X-Idempotency-Key del consumidor. */
  idempotencyKey: string;
}

export interface CreateOpportunityDeps {
  opportunities: OpportunitiesRepository;
  crm: CrmClient;
  connection: CrmConnection;
  now?: () => string;
}

export type CreateOpportunityOutcome =
  | { status: "created"; contactId: string; opportunityId: string; reusedContact: boolean }
  | { status: "duplicate"; contactId: string | null; opportunityId: string | null }
  | { status: "in_progress" }
  | { status: "conflict" }
  | { status: "error"; message: string };

export async function createOpportunityContact(
  input: OpportunityContactInput,
  ctx: CreateOpportunityContext,
  deps: CreateOpportunityDeps,
): Promise<CreateOpportunityOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const fingerprint = payloadFingerprint(input);

  // 1) Sembrar el registro en estado "pending" de forma idempotente.
  const seed: OpportunityRecord = {
    accountId: ctx.accountId,
    idempotencyKey: ctx.idempotencyKey,
    payloadFingerprint: fingerprint,
    contactId: null,
    opportunityId: null,
    status: "pending",
    correlationId: ctx.correlationId,
    createdAt: now(),
    updatedAt: now(),
  };
  const { row, created } = await deps.opportunities.insertIfAbsent(seed);

  // 2) Si NO creamos el row, otro flujo ya tomó esta clave.
  if (!created) {
    if (row.payloadFingerprint !== fingerprint) {
      return { status: "conflict" };
    }
    if (row.status === "created") {
      return { status: "duplicate", contactId: row.contactId, opportunityId: row.opportunityId };
    }
    if (row.status === "error") {
      return { status: "error", message: "un intento previo de esta clave terminó en error" };
    }
    return { status: "in_progress" };
  }

  // 3) Somos el creador → efecto externo en CRM.
  try {
    const existing = await deps.crm.findContactByDocument(input.contact.documento, deps.connection);
    const contact = existing ?? (await deps.crm.createContact(input.contact, deps.connection));
    const reusedContact = existing !== null;

    const opportunity = await deps.crm.createOpportunity(
      {
        nombre: input.opportunity.nombre,
        accountId: ctx.accountId,
        contactId: contact.id,
        stage: FIXED_OPPORTUNITY_STAGE,
        meta: input.opportunity.meta,
      },
      deps.connection,
    );

    await deps.opportunities.markCreated(ctx.accountId, ctx.idempotencyKey, {
      contactId: contact.id,
      opportunityId: opportunity.id,
    });
    return { status: "created", contactId: contact.id, opportunityId: opportunity.id, reusedContact };
  } catch (e) {
    await deps.opportunities.markError(ctx.accountId, ctx.idempotencyKey);
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
