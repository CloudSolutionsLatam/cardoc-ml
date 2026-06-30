import { describe, expect, it } from "vitest";
import { MockCrmClient, type CrmClient, type CrmConnection } from "@cardoc/providers";
import { InMemoryOpportunitiesRepository } from "@cardoc/persistence";
import { createOpportunityContact } from "../src/create-opportunity-contact";

const connection: CrmConnection = { apiDomain: "https://example.test", getAccessToken: async () => "dev" };
const input = {
  nroCedula: 45321890,
  nroSolicitud: 908812,
  nombres: "Juan Carlos",
  apellidos: "Pérez Rodríguez",
  celularCliente: "099123456",
  marcaVehiculo: "Chevrolet",
  modeloVehiculo: "Onix",
  anioVehiculo: 2022,
  matriculaVehiculo: "SBA1234",
};
const ctx = { accountId: "acc_ml", correlationId: "c1" };
function deps() {
  return { opportunities: new InMemoryOpportunitiesRepository(), crm: new MockCrmClient(), connection };
}

/** CRM que falla `createOpportunity` la 1ª vez (fallo transitorio) y luego funciona. */
class FlakyCrm implements CrmClient {
  contactCreated = 0;
  oppAttempts = 0;
  private contactId: string | null = null;
  async findContactByCedula() {
    return this.contactId ? { id: this.contactId } : null;
  }
  async findDealByExternalId() {
    return null;
  }
  async createContact() {
    this.contactCreated += 1;
    this.contactId = "C1";
    return { id: "C1" };
  }
  async createOpportunity() {
    this.oppAttempts += 1;
    if (this.oppAttempts === 1) throw new Error("CRM 503 transitorio");
    return { id: "D1" };
  }
}

describe("createOpportunityContact (idempotencia por NroSolicitud, dedup por cédula)", () => {
  it("crea Contacto + Oportunidad la primera vez", async () => {
    const out = await createOpportunityContact(input, ctx, deps());
    expect(out.status).toBe("created");
  });

  it("mismo NroSolicitud + mismo payload → duplicate (no re-crea)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctx, d);
    const second = await createOpportunityContact(input, ctx, d);
    expect(second.status).toBe("duplicate");
  });

  it("mismo NroSolicitud + payload distinto → conflict (409)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctx, d);
    const other = await createOpportunityContact({ ...input, marcaVehiculo: "Fiat" }, ctx, d);
    expect(other.status).toBe("conflict");
  });

  it("reutiliza el Contacto por cédula (misma cédula, distinto NroSolicitud → 2da Oportunidad)", async () => {
    const d = deps();
    const first = await createOpportunityContact(input, ctx, d);
    const second = await createOpportunityContact({ ...input, nroSolicitud: 908813 }, ctx, d);
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (second.status === "created") {
      expect(second.reusedContact).toBe(true);
    }
  });

  it("mismo NroSolicitud en otra Cuenta sí crea (idempotencia por tenant)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctx, d);
    const otherAccount = await createOpportunityContact(input, { accountId: "acc_otra", correlationId: "c2" }, d);
    expect(otherAccount.status).toBe("created");
  });

  it("error transitorio en la Oportunidad es REINTENTABLE y reusa el Contacto (no huérfano)", async () => {
    const crm = new FlakyCrm();
    const d = { opportunities: new InMemoryOpportunitiesRepository(), crm, connection };
    const first = await createOpportunityContact(input, ctx, d);
    expect(first.status).toBe("error");
    const second = await createOpportunityContact(input, ctx, d);
    expect(second.status).toBe("created");
    expect(crm.contactCreated).toBe(1); // el Contacto NO se recreó (dedup por cédula)
    if (second.status === "created") expect(second.reusedContact).toBe(true);
  });
});
