import { describe, expect, it } from "vitest";
import { MockCrmClient, type CrmConnection } from "@cardoc/providers";
import { InMemoryOpportunitiesRepository } from "@cardoc/persistence";
import { createOpportunityContact } from "../src/create-opportunity-contact";

const connection: CrmConnection = { accessToken: "dev", apiDomain: "https://example.test" };
const input = {
  contact: { documento: "1.234.567-8", nombre: "Ana Pérez" },
  opportunity: { nombre: "Revisión VW Amarok" },
};

function deps() {
  return { opportunities: new InMemoryOpportunitiesRepository(), crm: new MockCrmClient(), connection };
}

describe("createOpportunityContact (idempotencia, AC-08)", () => {
  it("crea Contacto + Oportunidad la primera vez", async () => {
    const d = deps();
    const out = await createOpportunityContact(input, { accountId: "acc_1", correlationId: "c1", idempotencyKey: "k1" }, d);
    expect(out.status).toBe("created");
  });

  it("misma clave + mismo payload no duplica (duplicate)", async () => {
    const d = deps();
    const ctx = { accountId: "acc_1", correlationId: "c1", idempotencyKey: "k1" };
    await createOpportunityContact(input, ctx, d);
    const second = await createOpportunityContact(input, ctx, d);
    expect(second.status).toBe("duplicate");
  });

  it("misma clave + payload distinto → conflict (409)", async () => {
    const d = deps();
    const ctx = { accountId: "acc_1", correlationId: "c1", idempotencyKey: "k1" };
    await createOpportunityContact(input, ctx, d);
    const other = await createOpportunityContact(
      { ...input, opportunity: { nombre: "Otra cosa" } },
      ctx,
      d,
    );
    expect(other.status).toBe("conflict");
  });

  it("la misma clave en otra Cuenta sí crea (idempotencia por tenant)", async () => {
    const d = deps();
    await createOpportunityContact(input, { accountId: "acc_1", correlationId: "c1", idempotencyKey: "k1" }, d);
    const otherAccount = await createOpportunityContact(input, { accountId: "acc_2", correlationId: "c2", idempotencyKey: "k1" }, d);
    expect(otherAccount.status).toBe("created");
  });
});
