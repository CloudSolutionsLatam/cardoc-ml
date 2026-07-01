/**
 * Implementación DataStore-backed de los repositorios (Zoho Catalyst).
 *
 * Tipado ESTRUCTURAL: este módulo NO importa `zcatalyst-sdk-node`. Define la rebanada
 * mínima de la API del SDK que usa (`CatalystAppLike`); la función pasa su
 * `catalyst.initialize(req)` real, que la satisface por duck-typing. Así `@cardoc/persistence`
 * sigue sin dependencia (ni runtime ni tipos) del SDK.
 *
 * API del SDK usada:
 *   app.datastore().table(name).insertRow / updateRow
 *   app.zcql().executeZCQLQuery(sql)  → [{ <tableName>: { ...columns } }]
 *
 * Columnas en snake_case del DataStore ↔ camelCase del dominio. La red física de la
 * idempotencia Capa 1 es UNIQUE(idempotency_key) single-column en `crm_opportunities` (la UI de
 * Catalyst NO permite UNIQUE compuesto); se crea en la consola. El filtro por account_id en las
 * queries es defensa de tenancy, no parte del índice.
 */
import type { Scope } from "@cardoc/domain";
import type {
  ApiToken,
  AuditLogEntry,
  CapConfig,
  Consumer,
  ConsumerStatus,
  OpportunityRecord,
  OpportunityStatus,
} from "./entities";
import type {
  AuditLogRepository,
  CapRepository,
  ConsumersRepository,
  OpportunitiesRepository,
  Repositories,
  TokensRepository,
} from "./repositories";

// ── Rebanada estructural del SDK (lo que de verdad usamos) ───────────────────
type Row = Record<string, unknown>;

export interface CatalystTableLike {
  insertRow(row: Row): Promise<Row>;
  updateRow(row: Row & { ROWID: string | number }): Promise<Row>;
}
export interface CatalystDatastoreLike {
  table(id: string | number): CatalystTableLike;
}
export interface CatalystZcqlLike {
  executeZCQLQuery(sql: string): Promise<Array<Record<string, Row>>>;
}
export interface CatalystAppLike {
  datastore(): CatalystDatastoreLike;
  zcql(): CatalystZcqlLike;
}

const TOKENS = "api_tokens";
const CONSUMERS = "consumers";
const OPPORTUNITIES = "crm_opportunities";
const AUDIT = "audit_log";
const CAPS = "consumer_caps";

/** Escapa comillas simples para literales ZCQL (defensa; los inputs son server-derived). */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined || v === "" ? null : Number(v);
}
function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || v.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────
export class CatalystTokensRepository implements TokensRepository {
  constructor(private readonly app: CatalystAppLike) {}

  private async findRaw(tokenHash: string): Promise<Row | null> {
    const res = await this.app
      .zcql()
      .executeZCQLQuery(`SELECT * FROM ${TOKENS} WHERE token_hash = ${lit(tokenHash)} LIMIT 1`);
    const first = res[0];
    return first ? (first[TOKENS] ?? null) : null;
  }

  private mapToken(r: Row): ApiToken {
    return {
      tokenHash: str(r["token_hash"]),
      consumerId: str(r["consumer_id"]),
      accountId: str(r["account_id"]),
      scopes: parseJson<Scope[]>(r["scopes"], []),
      expiresAt: strOrNull(r["expires_at"]),
      lastUsedAt: strOrNull(r["last_used_at"]),
      revokedAt: strOrNull(r["revoked_at"]),
    };
  }

  async resolveByHash(tokenHash: string): Promise<ApiToken | null> {
    const r = await this.findRaw(tokenHash);
    return r ? this.mapToken(r) : null;
  }
  async touchLastUsed(tokenHash: string): Promise<void> {
    const r = await this.findRaw(tokenHash);
    if (!r) {
      return;
    }
    await this.app.datastore().table(TOKENS).updateRow({
      ROWID: r["ROWID"] as string | number,
      last_used_at: new Date().toISOString(),
    });
  }
  async create(token: ApiToken): Promise<void> {
    await this.app.datastore().table(TOKENS).insertRow({
      token_hash: token.tokenHash,
      consumer_id: token.consumerId,
      account_id: token.accountId,
      scopes: JSON.stringify(token.scopes),
      expires_at: token.expiresAt,
      last_used_at: token.lastUsedAt,
      revoked_at: token.revokedAt,
    });
  }
  async listByConsumer(consumerId: string): Promise<ApiToken[]> {
    const res = await this.app
      .zcql()
      .executeZCQLQuery(`SELECT * FROM ${TOKENS} WHERE consumer_id = ${lit(consumerId)}`);
    return res
      .map((w) => w[TOKENS])
      .filter((r): r is Row => Boolean(r))
      .map((r) => this.mapToken(r));
  }
  async revoke(tokenHash: string, revokedAt: string): Promise<void> {
    const r = await this.findRaw(tokenHash);
    if (!r) {
      return;
    }
    await this.app.datastore().table(TOKENS).updateRow({
      ROWID: r["ROWID"] as string | number,
      revoked_at: revokedAt,
    });
  }
}

// ── Consumers ───────────────────────────────────────────────────────────────
export class CatalystConsumersRepository implements ConsumersRepository {
  constructor(private readonly app: CatalystAppLike) {}

  private map(r: Row): Consumer {
    return {
      consumerId: str(r["consumer_id"]),
      crmAccountId: str(r["crm_account_id"]),
      name: str(r["name"]),
      status: str(r["status"]) as ConsumerStatus,
    };
  }
  private async queryOne(where: string): Promise<Row | null> {
    const res = await this.app
      .zcql()
      .executeZCQLQuery(`SELECT * FROM ${CONSUMERS} WHERE ${where} LIMIT 1`);
    const first = res[0];
    return first ? (first[CONSUMERS] ?? null) : null;
  }
  async getByConsumerId(consumerId: string): Promise<Consumer | null> {
    const r = await this.queryOne(`consumer_id = ${lit(consumerId)}`);
    return r ? this.map(r) : null;
  }
  async getByAccountId(accountId: string): Promise<Consumer | null> {
    const r = await this.queryOne(`crm_account_id = ${lit(accountId)}`);
    return r ? this.map(r) : null;
  }
  async create(consumer: Consumer): Promise<void> {
    await this.app.datastore().table(CONSUMERS).insertRow({
      consumer_id: consumer.consumerId,
      crm_account_id: consumer.crmAccountId,
      name: consumer.name,
      status: consumer.status,
    });
  }
  async list(): Promise<Consumer[]> {
    const res = await this.app.zcql().executeZCQLQuery(`SELECT * FROM ${CONSUMERS}`);
    return res
      .map((w) => w[CONSUMERS])
      .filter((r): r is Row => Boolean(r))
      .map((r) => this.map(r));
  }
}

// ── Opportunities (idempotencia) ──────────────────────────────────────────────
export class CatalystOpportunitiesRepository implements OpportunitiesRepository {
  constructor(private readonly app: CatalystAppLike) {}

  private map(r: Row): OpportunityRecord {
    return {
      accountId: str(r["account_id"]),
      idempotencyKey: str(r["idempotency_key"]),
      payloadFingerprint: str(r["payload_fingerprint"]),
      contactId: strOrNull(r["contact_id"]),
      opportunityId: strOrNull(r["opportunity_id"]),
      status: str(r["status"]) as OpportunityStatus,
      correlationId: str(r["correlation_id"]),
      createdAt: str(r["created_at"]),
      updatedAt: str(r["updated_at"]),
    };
  }
  private async findRaw(accountId: string, idempotencyKey: string): Promise<Row | null> {
    const sql =
      `SELECT * FROM ${OPPORTUNITIES} WHERE account_id = ${lit(accountId)} ` +
      `AND idempotency_key = ${lit(idempotencyKey)} LIMIT 1`;
    const res = await this.app.zcql().executeZCQLQuery(sql);
    const first = res[0];
    return first ? (first[OPPORTUNITIES] ?? null) : null;
  }

  async insertIfAbsent(
    record: OpportunityRecord,
  ): Promise<{ row: OpportunityRecord; created: boolean }> {
    try {
      const inserted = await this.app.datastore().table(OPPORTUNITIES).insertRow({
        account_id: record.accountId,
        idempotency_key: record.idempotencyKey,
        payload_fingerprint: record.payloadFingerprint,
        contact_id: record.contactId,
        opportunity_id: record.opportunityId,
        status: record.status,
        correlation_id: record.correlationId,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
      return { row: this.map(inserted), created: true };
    } catch (e) {
      // El UNIQUE(idempotency_key) rechaza el segundo insert concurrente → buscamos el
      // existente (query filtrada también por account_id como defensa de tenancy): esa es
      // la red FÍSICA anti-duplicación (AC-08).
      const existing = await this.findRaw(record.accountId, record.idempotencyKey);
      if (existing) {
        return { row: this.map(existing), created: false };
      }
      throw e;
    }
  }

  async findByKey(accountId: string, idempotencyKey: string): Promise<OpportunityRecord | null> {
    const raw = await this.findRaw(accountId, idempotencyKey);
    return raw ? this.map(raw) : null;
  }

  async markCreated(
    accountId: string,
    idempotencyKey: string,
    fields: { contactId: string; opportunityId: string },
  ): Promise<void> {
    const raw = await this.findRaw(accountId, idempotencyKey);
    if (!raw) {
      return;
    }
    await this.app.datastore().table(OPPORTUNITIES).updateRow({
      ROWID: raw["ROWID"] as string | number,
      status: "created",
      contact_id: fields.contactId,
      opportunity_id: fields.opportunityId,
      updated_at: new Date().toISOString(),
    });
  }

  async markError(accountId: string, idempotencyKey: string): Promise<void> {
    const raw = await this.findRaw(accountId, idempotencyKey);
    if (!raw) {
      return;
    }
    await this.app.datastore().table(OPPORTUNITIES).updateRow({
      ROWID: raw["ROWID"] as string | number,
      status: "error",
      updated_at: new Date().toISOString(),
    });
  }
}

// ── Audit ─────────────────────────────────────────────────────────────────────
export class CatalystAuditLogRepository implements AuditLogRepository {
  constructor(private readonly app: CatalystAppLike) {}

  async append(entry: AuditLogEntry): Promise<void> {
    await this.app.datastore().table(AUDIT).insertRow({
      _timestamp: entry.timestamp, // "timestamp" es palabra reservada en Catalyst → columna "_timestamp"
      correlation_id: entry.correlationId,
      consumer_id: entry.consumerId,
      account_id: entry.accountId,
      endpoint: entry.endpoint,
      outcome: entry.outcome,
      http_status: entry.httpStatus,
      latency_ms: entry.latencyMs,
      error_code: entry.errorCode,
    });
  }

  async searchByCorrelationId(correlationId: string): Promise<AuditLogEntry[]> {
    const res = await this.app
      .zcql()
      .executeZCQLQuery(
        `SELECT * FROM ${AUDIT} WHERE correlation_id = ${lit(correlationId)} ORDER BY CREATEDTIME ASC`,
      );
    return res
      .map((w) => w[AUDIT])
      .filter((r): r is Row => Boolean(r))
      .map((r) => ({
        timestamp: str(r["_timestamp"]), // columna "_timestamp" (reservada sin guion)
        correlationId: str(r["correlation_id"]),
        consumerId: str(r["consumer_id"]),
        accountId: str(r["account_id"]),
        endpoint: str(r["endpoint"]),
        outcome: str(r["outcome"]) as AuditLogEntry["outcome"],
        httpStatus: Number(r["http_status"] ?? 0),
        latencyMs: Number(r["latency_ms"] ?? 0),
        errorCode: strOrNull(r["error_code"]),
      }));
  }
}

// ── Cap (config) ───────────────────────────────────────────────────────────────
export class CatalystCapRepository implements CapRepository {
  constructor(private readonly app: CatalystAppLike) {}

  async getConfig(consumerId: string, endpoint: string): Promise<CapConfig | null> {
    const sql =
      `SELECT * FROM ${CAPS} WHERE consumer_id = ${lit(consumerId)} ` +
      `AND endpoint = ${lit(endpoint)} LIMIT 1`;
    const res = await this.app.zcql().executeZCQLQuery(sql);
    const r = res[0] ? res[0][CAPS] : null;
    if (!r) {
      return null;
    }
    return {
      consumerId: str(r["consumer_id"]),
      endpoint: str(r["endpoint"]),
      limitHour: numOrNull(r["limit_hour"]),
      limitDay: numOrNull(r["limit_day"]),
      limitWeek: numOrNull(r["limit_week"]),
    };
  }
}

/** Construye los repos DataStore-backed a partir del app de Catalyst (ya inicializado). */
export function createCatalystRepositories(app: CatalystAppLike): Repositories {
  return {
    tokens: new CatalystTokensRepository(app),
    consumers: new CatalystConsumersRepository(app),
    opportunities: new CatalystOpportunitiesRepository(app),
    audit: new CatalystAuditLogRepository(app),
    cap: new CatalystCapRepository(app),
  };
}
