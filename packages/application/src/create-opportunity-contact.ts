/**
 * Use-case: crear/reutilizar Contacto + crear Oportunidad (POST /v1/opportunity-contact).
 *
 *   idempotency seed (por NroSolicitud) → (replay/conflict? corta) →
 *   findContactByCedula | createContact → createOpportunity(stage fijo) → markCreated
 *
 * Garantía rectora: la Oportunidad NO se duplica. El row "pending" se siembra con
 * `(accountId, NroSolicitud)` (UNIQUE) ANTES de tocar CRM; solo el creador ejecuta el
 * efecto externo. Mismo NroSolicitud + payload distinto → conflicto.
 *
 * Dedup del Contacto: por **cédula** (ML no manda email).
 */
import {
  FIXED_OPPORTUNITY_STAGE,
  payloadFingerprint,
  type OpportunityContactInput,
} from "@cardoc/domain";
import type { CrmClient, CrmConnection } from "@cardoc/providers";
import type { OpportunitiesRepository, OpportunityRecord } from "@cardoc/persistence";

export interface CreateOpportunityContext {
  /** Cuenta resuelta del token (la Cuenta "ML") — NUNCA del payload. */
  accountId: string;
  correlationId: string;
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
  // El NroSolicitud (único en ML) es la clave de idempotencia / External ID.
  const idempotencyKey = String(input.nroSolicitud);
  const fingerprint = payloadFingerprint(input);

  // 1) Sembrar el registro en estado "pending" de forma idempotente.
  const seed: OpportunityRecord = {
    accountId: ctx.accountId,
    idempotencyKey,
    payloadFingerprint: fingerprint,
    contactId: null,
    opportunityId: null,
    status: "pending",
    correlationId: ctx.correlationId,
    createdAt: now(),
    updatedAt: now(),
  };
  const { row, created } = await deps.opportunities.insertIfAbsent(seed);

  // 2) Si NO creamos el row, ese NroSolicitud ya fue tomado.
  if (!created) {
    if (row.payloadFingerprint !== fingerprint) {
      return { status: "conflict" };
    }
    if (row.status === "created") {
      return { status: "duplicate", contactId: row.contactId, opportunityId: row.opportunityId };
    }
    if (row.status === "pending") {
      return { status: "in_progress" };
    }
    // status === "error": un intento previo falló. El efecto externo es IDEMPOTENTE (dedup
    // de Contacto por cédula + de Oportunidad por EXTERNAL_ID), así que un fallo transitorio
    // (red/5xx) es reintentable: caemos al efecto en vez de quedar muertos para siempre.
  }

  // 3) Creador (row nuevo) o retry de "error" → efecto externo en CRM (idempotente).
  const isRetry = !created;
  try {
    const existing = await deps.crm.findContactByCedula(input.nroCedula, deps.connection);
    const contact =
      existing ??
      (await deps.crm.createContact(
        {
          nroCedula: input.nroCedula,
          nombres: input.nombres,
          apellidos: input.apellidos,
          celular: input.celularCliente,
          accountId: ctx.accountId,
        },
        deps.connection,
      ));
    const reusedContact = existing !== null;

    // En un retry, la Oportunidad pudo haberse creado en un intento previo que perdió la
    // respuesta: buscarla por EXTERNAL_ID antes de crear evita duplicar el Deal.
    const existingDeal = isRetry
      ? await deps.crm.findDealByExternalId(input.nroSolicitud, deps.connection)
      : null;
    const opportunity =
      existingDeal ??
      (await deps.crm.createOpportunity(
      {
        nroSolicitud: input.nroSolicitud,
        contactId: contact.id,
        stage: FIXED_OPPORTUNITY_STAGE,
        marca: input.marcaVehiculo,
        modelo: input.modeloVehiculo,
        anio: input.anioVehiculo,
        matricula: input.matriculaVehiculo,
        sucursal: input.sucursal,
        departamento: input.departamentoSucursal,
        ciudad: input.ciudadSucursal,
        direccion: input.direccionSucursal,
        tenant: input.tenant,
      },
        deps.connection,
      ));

    await deps.opportunities.markCreated(ctx.accountId, idempotencyKey, {
      contactId: contact.id,
      opportunityId: opportunity.id,
    });
    return { status: "created", contactId: contact.id, opportunityId: opportunity.id, reusedContact };
  } catch (e) {
    await deps.opportunities.markError(ctx.accountId, idempotencyKey);
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
