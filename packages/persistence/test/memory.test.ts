/**
 * Tests de los repositorios in-memory (fakes).
 *
 * No prueban el DataStore real (eso es E-02/consola, OQ-P8) sino los INVARIANTES de
 * runtime que el resto del sistema da por ciertos: segregación por Cuenta (tenancy,
 * AC-06/AC-10), idempotencia anti-duplicación (AC-08) y auditoría append-only (AC-09).
 * Si un fake rompe uno de estos, la lógica que corre sobre él (use-cases, smoke local)
 * pasaría en verde ocultando un bug — por eso se cubren acá.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryAuditLogRepository,
  InMemoryCapRepository,
  InMemoryConsumersRepository,
  InMemoryOpportunitiesRepository,
  InMemoryTokensRepository,
} from "../src/memory";
import type { ApiToken, AuditLogEntry, OpportunityRecord } from "../src/entities";

// ── Builders ──────────────────────────────────────────────────────────────────

function record(over: Partial<OpportunityRecord> = {}): OpportunityRecord {
  return {
    accountId: "acc_A",
    idempotencyKey: "idem-1",
    payloadFingerprint: "fp-1",
    contactId: null,
    opportunityId: null,
    status: "pending",
    correlationId: "corr-1",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}

function token(over: Partial<ApiToken> = {}): ApiToken {
  return {
    tokenHash: "hash-A",
    consumerId: "consumer_A",
    accountId: "acc_A",
    scopes: ["opportunities:create"],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  };
}

function audit(over: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: "2026-06-30T00:00:00.000Z",
    correlationId: "corr-1",
    consumerId: "consumer_A",
    accountId: "acc_A",
    endpoint: "opportunity-contact",
    outcome: "success",
    httpStatus: 201,
    latencyMs: 12,
    errorCode: null,
    ...over,
  };
}

// ── Oportunidades: tenancy + idempotencia (AC-08 / AC-10) ───────────────────────

describe("InMemoryOpportunitiesRepository — tenancy + idempotencia", () => {
  it("insertIfAbsent crea la primera vez y dedupea el replay (misma Cuenta + misma clave)", async () => {
    const repo = new InMemoryOpportunitiesRepository();
    const first = await repo.insertIfAbsent(record());
    const second = await repo.insertIfAbsent(record({ payloadFingerprint: "fp-2" }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // Devuelve el row ORIGINAL sembrado, no el segundo intento (el fingerprint del 1º manda).
    expect(second.row.payloadFingerprint).toBe("fp-1");
  });

  it("la MISMA clave en dos Cuentas distintas NO colisiona (la clave es account-scoped)", async () => {
    const repo = new InMemoryOpportunitiesRepository();
    const a = await repo.insertIfAbsent(record({ accountId: "acc_A", idempotencyKey: "k" }));
    const b = await repo.insertIfAbsent(record({ accountId: "acc_B", idempotencyKey: "k" }));
    // Si el fake no compusiera con account_id, el 2º sería un "duplicado" espurio de otra Cuenta.
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });

  it("inserts CONCURRENTES con la misma clave → exactamente UNO crea (nunca dos)", async () => {
    // Gate «idempotencia concurrente» (AC-08) a nivel lógico. La red física es el
    // UNIQUE(idempotency_key) del DataStore (OQ-P8/CAT-Q3, consola) — acá se prueba que
    // el fake NO deja pasar dos altas, que es lo que la lógica del use-case asume.
    const repo = new InMemoryOpportunitiesRepository();
    const results = await Promise.all([
      repo.insertIfAbsent(record()),
      repo.insertIfAbsent(record()),
      repo.insertIfAbsent(record()),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("findByKey aísla por Cuenta: la Cuenta ajena no ve el row", async () => {
    const repo = new InMemoryOpportunitiesRepository();
    await repo.insertIfAbsent(record({ accountId: "acc_A", idempotencyKey: "k" }));
    expect(await repo.findByKey("acc_A", "k")).not.toBeNull();
    expect(await repo.findByKey("acc_B", "k")).toBeNull(); // cross-tenant read = nada
  });

  it("markCreated pasa el row a 'created' con los IDs de CRM", async () => {
    const repo = new InMemoryOpportunitiesRepository();
    await repo.insertIfAbsent(record());
    await repo.markCreated("acc_A", "idem-1", { contactId: "C1", opportunityId: "D1" });
    const row = await repo.findByKey("acc_A", "idem-1");
    expect(row?.status).toBe("created");
    expect(row?.contactId).toBe("C1");
    expect(row?.opportunityId).toBe("D1");
  });

  it("markError pasa el row a 'error' (intento fallido, reintentable)", async () => {
    const repo = new InMemoryOpportunitiesRepository();
    await repo.insertIfAbsent(record());
    await repo.markError("acc_A", "idem-1");
    expect((await repo.findByKey("acc_A", "idem-1"))?.status).toBe("error");
  });

  it("markCreated/markError sobre un row inexistente es no-op (no crea ni rompe)", async () => {
    const repo = new InMemoryOpportunitiesRepository();
    await repo.markCreated("acc_A", "fantasma", { contactId: "C", opportunityId: "D" });
    await repo.markError("acc_A", "fantasma");
    expect(await repo.findByKey("acc_A", "fantasma")).toBeNull();
  });
});

// ── Tokens: resolución por hash, vigencia, revocación ───────────────────────────

describe("InMemoryTokensRepository", () => {
  it("resolveByHash devuelve el token sembrado y null para un hash desconocido", async () => {
    const repo = new InMemoryTokensRepository();
    repo.seed(token());
    expect(await repo.resolveByHash("hash-A")).not.toBeNull();
    expect(await repo.resolveByHash("hash-inexistente")).toBeNull();
  });

  it("revoke setea revokedAt (la VIGENCIA la decide el middleware, no el repo)", async () => {
    const repo = new InMemoryTokensRepository();
    repo.seed(token());
    await repo.revoke("hash-A", "2026-07-01T00:00:00.000Z");
    // El repo sigue devolviendo la fila: quién la rechaza por revocada es authMiddleware.
    expect((await repo.resolveByHash("hash-A"))?.revokedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("touchLastUsed registra el último uso", async () => {
    const repo = new InMemoryTokensRepository();
    repo.seed(token({ lastUsedAt: null }));
    await repo.touchLastUsed("hash-A");
    expect((await repo.resolveByHash("hash-A"))?.lastUsedAt).not.toBeNull();
  });

  it("listByConsumer filtra por consumerId", async () => {
    const repo = new InMemoryTokensRepository();
    repo.seed(token({ tokenHash: "h1", consumerId: "consumer_A" }));
    repo.seed(token({ tokenHash: "h2", consumerId: "consumer_A" }));
    repo.seed(token({ tokenHash: "h3", consumerId: "consumer_B" }));
    expect(await repo.listByConsumer("consumer_A")).toHaveLength(2);
    expect(await repo.listByConsumer("consumer_B")).toHaveLength(1);
  });
});

// ── Consumers: lookup directo y reverso por Cuenta (ancla de tenancy) ───────────

describe("InMemoryConsumersRepository", () => {
  it("getByConsumerId y getByAccountId resuelven el mismo consumidor", async () => {
    const repo = new InMemoryConsumersRepository();
    repo.seed({ consumerId: "consumer_A", crmAccountId: "acc_A", name: "Automotora A", status: "active" });
    expect((await repo.getByConsumerId("consumer_A"))?.crmAccountId).toBe("acc_A");
    // El reverse-lookup por Cuenta es lo que ancla la tenancy (Cuenta → consumidor).
    expect((await repo.getByAccountId("acc_A"))?.consumerId).toBe("consumer_A");
  });

  it("devuelve null cuando no hay match", async () => {
    const repo = new InMemoryConsumersRepository();
    expect(await repo.getByConsumerId("nadie")).toBeNull();
    expect(await repo.getByAccountId("acc_inexistente")).toBeNull();
  });
});

// ── Auditoría: append-only (AC-09) ──────────────────────────────────────────────

describe("InMemoryAuditLogRepository — append-only", () => {
  it("append acumula y searchByCorrelationId filtra", async () => {
    const repo = new InMemoryAuditLogRepository();
    await repo.append(audit({ correlationId: "c1" }));
    await repo.append(audit({ correlationId: "c1" }));
    await repo.append(audit({ correlationId: "c2" }));
    expect(repo.entries).toHaveLength(3);
    expect(await repo.searchByCorrelationId("c1")).toHaveLength(2);
    expect(await repo.searchByCorrelationId("c2")).toHaveLength(1);
  });

  it("no expone ninguna operación de UPDATE/DELETE (solo append/search)", () => {
    const repo = new InMemoryAuditLogRepository();
    // Contrato append-only: si alguien agrega un update/delete, este test lo delata.
    const ops = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    expect(ops).toContain("append");
    expect(ops).not.toContain("update");
    expect(ops).not.toContain("delete");
    expect(ops).not.toContain("remove");
  });
});

// ── Cap: config por consumidor+endpoint ─────────────────────────────────────────

describe("InMemoryCapRepository", () => {
  it("getConfig devuelve la config sembrada por (consumerId, endpoint) o null", async () => {
    const repo = new InMemoryCapRepository();
    repo.seed({ consumerId: "consumer_A", endpoint: "opportunity-contact", limitHour: 10, limitDay: 100, limitWeek: 500 });
    expect((await repo.getConfig("consumer_A", "opportunity-contact"))?.limitHour).toBe(10);
    // Otro endpoint del mismo consumidor no hereda la config → null (cae a defaults de env).
    expect(await repo.getConfig("consumer_A", "informes-pdf")).toBeNull();
    expect(await repo.getConfig("consumer_B", "opportunity-contact")).toBeNull();
  });
});
