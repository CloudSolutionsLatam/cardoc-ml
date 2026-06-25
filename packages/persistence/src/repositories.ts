/**
 * Puertos de repositorio sobre el DataStore.
 *
 * Diseño anti-cross-access: los métodos de runtime reciben `accountId` como primer
 * argumento OBLIGATORIO y filtran por él. El `accountId` viene del token resuelto en
 * el middleware de auth, jamás del payload del request (tenancy, AC-06/AC-10).
 */
import type {
  ApiToken,
  AuditLogEntry,
  CapConfig,
  Consumer,
  OpportunityRecord,
} from "./entities";

export interface TokensRepository {
  /** Fila del token por su hash, o null. La VIGENCIA la decide el middleware de auth. */
  resolveByHash(tokenHash: string): Promise<ApiToken | null>;
  touchLastUsed(tokenHash: string): Promise<void>;
  create(token: ApiToken): Promise<void>;
  listByConsumer(consumerId: string): Promise<ApiToken[]>;
  revoke(tokenHash: string, revokedAt: string): Promise<void>;
}

export interface ConsumersRepository {
  getByConsumerId(consumerId: string): Promise<Consumer | null>;
  getByAccountId(accountId: string): Promise<Consumer | null>;
  create(consumer: Consumer): Promise<void>;
  list(): Promise<Consumer[]>;
}

export interface OpportunitiesRepository {
  /**
   * Inserta de forma idempotente. Si ya existe un row con la misma
   * `(accountId, idempotencyKey)` (UNIQUE), devuelve el existente sin crear otro —
   * red física anti-duplicación (AC-08).
   */
  insertIfAbsent(record: OpportunityRecord): Promise<{ row: OpportunityRecord; created: boolean }>;
  findByKey(accountId: string, idempotencyKey: string): Promise<OpportunityRecord | null>;
  /** Pasa el row a `created` con los IDs de CRM. */
  markCreated(
    accountId: string,
    idempotencyKey: string,
    fields: { contactId: string; opportunityId: string },
  ): Promise<void>;
  /** Pasa el row a `error` (el alta en CRM falló; el intento queda registrado). */
  markError(accountId: string, idempotencyKey: string): Promise<void>;
}

export interface AuditLogRepository {
  /** Append-only: solo inserta. Sin update ni delete. */
  append(entry: AuditLogEntry): Promise<void>;
  searchByCorrelationId(correlationId: string): Promise<AuditLogEntry[]>;
}

export interface CapRepository {
  /** Config del cap del consumidor+endpoint, o null (→ el middleware usa los defaults de env). */
  getConfig(consumerId: string, endpoint: string): Promise<CapConfig | null>;
}

/** Agregado de repos que una función recibe inyectado. */
export interface Repositories {
  tokens: TokensRepository;
  consumers: ConsumersRepository;
  opportunities: OpportunitiesRepository;
  audit: AuditLogRepository;
  cap: CapRepository;
}
