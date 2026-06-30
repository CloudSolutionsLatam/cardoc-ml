import { describe, expect, it } from "vitest";
import { MockCrmClient, type CrmConnection } from "@cardoc/providers";
import { InMemoryOpportunitiesRepository } from "@cardoc/persistence";
import { createOpportunityContact } from "../src/create-opportunity-contact";

const connection: CrmConnection = { accessToken: "dev", apiDomain: "https://example.test" };
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
});
