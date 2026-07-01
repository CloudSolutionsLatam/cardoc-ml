/**
 * Implementaciones in-memory de los repositorios.
 *
 * Para tests unitarios y para correr el pipeline en local sin DataStore. NO es
 * persistencia real: en un contenedor serverless el estado vive solo mientras el
 * contenedor está caliente. La impl DataStore-backed la reemplaza en `catalyst.ts`.
 */
import type {
  ApiToken,
  AuditLogEntry,
  CapConfig,
  Consumer,
  OpportunityRecord,
} from "./entities";
import type {
  AuditLogRepository,
  CapRepository,
  ConsumersRepository,
  OpportunitiesRepository,
  TokensRepository,
} from "./repositories";

export class InMemoryTokensRepository implements TokensRepository {
  private readonly byHash = new Map<string, ApiToken>();

  /** Siembra un token (dev/test). En producción los crea el backoffice/admin. */
  seed(token: ApiToken): void {
    this.byHash.set(token.tokenHash, token);
  }

  async resolveByHash(tokenHash: string): Promise<ApiToken | null> {
    return this.byHash.get(tokenHash) ?? null;
  }
  async touchLastUsed(tokenHash: string): Promise<void> {
    const t = this.byHash.get(tokenHash);
    if (t) {
      t.lastUsedAt = new Date().toISOString();
    }
  }
  async create(token: ApiToken): Promise<void> {
    this.byHash.set(token.tokenHash, { ...token });
  }
  async listByConsumer(consumerId: string): Promise<ApiToken[]> {
    return [...this.byHash.values()].filter((t) => t.consumerId === consumerId);
  }
  async revoke(tokenHash: string, revokedAt: string): Promise<void> {
    const t = this.byHash.get(tokenHash);
    if (t) {
      t.revokedAt = revokedAt;
    }
  }
}

export class InMemoryConsumersRepository implements ConsumersRepository {
  private readonly byId = new Map<string, Consumer>();

  seed(consumer: Consumer): void {
    this.byId.set(consumer.consumerId, consumer);
  }
  async getByConsumerId(consumerId: string): Promise<Consumer | null> {
    return this.byId.get(consumerId) ?? null;
  }
  async getByAccountId(accountId: string): Promise<Consumer | null> {
    for (const c of this.byId.values()) {
      if (c.crmAccountId === accountId) {
        return c;
      }
    }
    return null;
  }
  async create(consumer: Consumer): Promise<void> {
    this.byId.set(consumer.consumerId, { ...consumer });
  }
  async list(): Promise<Consumer[]> {
    return [...this.byId.values()];
  }
}

export class InMemoryOpportunitiesRepository implements OpportunitiesRepository {
  /** key = `${accountId}|${idempotencyKey}`. El DataStore real solo tiene UNIQUE(idempotency_key)
   *  single-column (la UI de Catalyst no permite compuesto); este fake compone con account_id, así
   *  que es MÁS estricto que producción. */
  private readonly byKey = new Map<string, OpportunityRecord>();

  private key(accountId: string, idempotencyKey: string): string {
    return `${accountId}|${idempotencyKey}`;
  }

  async insertIfAbsent(
    record: OpportunityRecord,
  ): Promise<{ row: OpportunityRecord; created: boolean }> {
    const k = this.key(record.accountId, record.idempotencyKey);
    const existing = this.byKey.get(k);
    if (existing) {
      return { row: existing, created: false };
    }
    const row: OpportunityRecord = { ...record };
    this.byKey.set(k, row);
    return { row, created: true };
  }

  async findByKey(accountId: string, idempotencyKey: string): Promise<OpportunityRecord | null> {
    return this.byKey.get(this.key(accountId, idempotencyKey)) ?? null;
  }

  async markCreated(
    accountId: string,
    idempotencyKey: string,
    fields: { contactId: string; opportunityId: string },
  ): Promise<void> {
    const k = this.key(accountId, idempotencyKey);
    const row = this.byKey.get(k);
    if (!row) {
      return;
    }
    this.byKey.set(k, {
      ...row,
      status: "created",
      contactId: fields.contactId,
      opportunityId: fields.opportunityId,
      updatedAt: new Date().toISOString(),
    });
  }

  async markError(accountId: string, idempotencyKey: string): Promise<void> {
    const k = this.key(accountId, idempotencyKey);
    const row = this.byKey.get(k);
    if (!row) {
      return;
    }
    this.byKey.set(k, { ...row, status: "error", updatedAt: new Date().toISOString() });
  }
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  /** Append-only: solo se agregan entradas, nunca se mutan ni borran. */
  readonly entries: AuditLogEntry[] = [];

  async append(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }
  async searchByCorrelationId(correlationId: string): Promise<AuditLogEntry[]> {
    return this.entries.filter((e) => e.correlationId === correlationId);
  }
}

export class InMemoryCapRepository implements CapRepository {
  private readonly byKey = new Map<string, CapConfig>();

  seed(config: CapConfig): void {
    this.byKey.set(`${config.consumerId}|${config.endpoint}`, config);
  }
  async getConfig(consumerId: string, endpoint: string): Promise<CapConfig | null> {
    return this.byKey.get(`${consumerId}|${endpoint}`) ?? null;
  }
}
