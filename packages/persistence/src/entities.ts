/**
 * Tipos de fila del DataStore.
 *
 * `accountId` (la Cuenta CRM = la automotora) es la partition key lógica del modelo de
 * runtime. Toda query filtra por el `accountId` derivado del token, NUNCA del payload —
 * eso es la segregación por tenancy (AC-06/AC-10).
 */
import type { Scope } from "@cardoc/domain";

export type ConsumerStatus = "active" | "suspended";

/** Consumidor de la API (una integración = una automotora). */
export interface Consumer {
  consumerId: string;
  /** Cuenta (Account) de Zoho CRM asociada — el ancla de la tenancy. */
  crmAccountId: string;
  name: string;
  status: ConsumerStatus;
}

export interface ApiToken {
  /** Solo se persiste el HASH; el token plano nunca toca el DataStore. */
  tokenHash: string;
  consumerId: string;
  /** Cuenta resuelta desde el token; se inyecta en cada query de runtime. */
  accountId: string;
  scopes: Scope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type OpportunityStatus = "pending" | "created" | "error";

/**
 * Registro de la Oportunidad creada vía POST. La red FÍSICA anti-duplicación es
 * `UNIQUE(idempotency_key)` single-column (AC-08; la UI de Catalyst no permite UNIQUE
 * compuesto — `account_id` se filtra en la query como defensa de tenancy);
 * `payloadFingerprint` detecta el conflicto "misma clave, payload distinto".
 */
export interface OpportunityRecord {
  accountId: string;
  /** = X-Idempotency-Key del consumidor. */
  idempotencyKey: string;
  payloadFingerprint: string;
  contactId: string | null;
  opportunityId: string | null;
  status: OpportunityStatus;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Auditoría append-only (AC-09): sin UPDATE/DELETE desde la aplicación. La escribe el
 * middleware on-finish, 1 registro por request, con status + latencia ya conocidos.
 */
export interface AuditLogEntry {
  timestamp: string;
  correlationId: string;
  consumerId: string;
  accountId: string;
  /** Endpoint lógico (p.ej. "opportunity-contact", "informes-list", "informes-pdf"). */
  endpoint: string;
  outcome: "success" | "error";
  httpStatus: number;
  latencyMs: number;
  errorCode: string | null;
}

export type CapWindow = "hour" | "day" | "week";

/** Config del cap por consumidor+endpoint (los CONTADORES viven en el middleware/Cache). */
export interface CapConfig {
  consumerId: string;
  endpoint: string;
  limitHour: number | null;
  limitDay: number | null;
  limitWeek: number | null;
}
