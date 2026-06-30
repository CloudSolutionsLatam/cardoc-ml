/**
 * Use-case: crear/reutilizar Contacto + crear Oportunidad (POST /v1/opportunity-contact).
 *
 * Idempotencia en DOS capas (ver ADR-0002):
 *  - **Capa 1 (middleware / Catalyst)** — SOLO si llega `X-Idempotency-Key` (`ctx.idempotencyKey`).
 *    Se siembra/consulta un row en la DataStore **antes** de tocar Zoho → un duplicado corta
 *    sin roundtrip al CRM (replay → `duplicate`; misma clave + payload distinto → `conflict`).
 *  - **Capa 2 (base / Zoho CRM)** — SIEMPRE. Dedup del Contacto por cédula (`findContactByCedula`)
 *    y de la Oportunidad por `EXTERNAL_ID` único: al recrear, Zoho responde `DUPLICATE_DATA` con
 *    el id existente, que el adapter devuelve como `duplicate` (no como error).
 *
 * Sin header, la Capa 1 se omite y el CRM es la única autoridad de dedup (no hay detección de
 * "mismo NroSolicitud + payload distinto" → eso es una garantía exclusiva de la Capa 1).
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
  /** Valor del header `X-Idempotency-Key` (opcional). Si viene → activa la Capa 1 (DataStore). */
  idempotencyKey?: string;
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

interface EffectResult {
  contactId: string;
  opportunityId: string;
  reusedContact: boolean;
  /** true si la Oportunidad ya existía en el CRM (Zoho `DUPLICATE_DATA` por `EXTERNAL_ID`). */
  dealDuplicate: boolean;
}

export async function createOpportunityContact(
  input: OpportunityContactInput,
  ctx: CreateOpportunityContext,
  deps: CreateOpportunityDeps,
): Promise<CreateOpportunityOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());

  // Capa 2 — efecto en CRM, idempotente: Contacto por cédula, Oportunidad por EXTERNAL_ID.
  const runEffect = async (): Promise<EffectResult> => {
    const found = await deps.crm.findContactByCedula(input.nroCedula, deps.connection);
    let contactId: string;
    let reusedContact: boolean;
    if (found) {
      contactId = found.id;
      reusedContact = true;
    } else {
      const c = await deps.crm.createContact(
        {
          nroCedula: input.nroCedula,
          nombres: input.nombres,
          apellidos: input.apellidos,
          celular: input.celularCliente,
          accountId: ctx.accountId,
        },
        deps.connection,
      );
      contactId = c.id;
      reusedContact = c.duplicate; // si Zoho dedupeó el Contacto (cédula única) también es reuso
    }
    const opp = await deps.crm.createOpportunity(
      {
        nroSolicitud: input.nroSolicitud,
        contactId,
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
    );
    return { contactId, opportunityId: opp.id, reusedContact, dealDuplicate: opp.duplicate };
  };

  // ── Sin header → Capa 1 OFF: directo al CRM (dedup por EXTERNAL_ID / cédula) ──
  if (!ctx.idempotencyKey) {
    try {
      const r = await runEffect();
      return r.dealDuplicate
        ? { status: "duplicate", contactId: r.contactId, opportunityId: r.opportunityId }
        : {
            status: "created",
            contactId: r.contactId,
            opportunityId: r.opportunityId,
            reusedContact: r.reusedContact,
          };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Con header → Capa 1 ON: fast-path en la DataStore ANTES de tocar Zoho ──
  const idempotencyKey = ctx.idempotencyKey;
  const fingerprint = payloadFingerprint(input);
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

  if (!created) {
    if (row.payloadFingerprint !== fingerprint) return { status: "conflict" };
    if (row.status === "created") {
      return { status: "duplicate", contactId: row.contactId, opportunityId: row.opportunityId };
    }
    if (row.status === "pending") return { status: "in_progress" };
    // status === "error": un intento previo falló; el efecto es idempotente → reintentamos.
  }

  try {
    const r = await runEffect();
    await deps.opportunities.markCreated(ctx.accountId, idempotencyKey, {
      contactId: r.contactId,
      opportunityId: r.opportunityId,
    });
    // Si el Deal ya existía en el CRM (DUPLICATE_DATA), es `duplicate` aunque la clave de
    // Capa 1 sea nueva — mismo criterio que el camino sin header (consistencia entre capas).
    return r.dealDuplicate
      ? { status: "duplicate", contactId: r.contactId, opportunityId: r.opportunityId }
      : {
          status: "created",
          contactId: r.contactId,
          opportunityId: r.opportunityId,
          reusedContact: r.reusedContact,
        };
  } catch (e) {
    await deps.opportunities.markError(ctx.accountId, idempotencyKey);
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
