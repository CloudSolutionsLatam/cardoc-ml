import { describe, expect, it } from "vitest";
import { MockCrmClient, type CrmClient, type CrmConnection, type CrmWriteResult } from "@cardoc/providers";
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
const ctx = { accountId: "acc_ml", correlationId: "c1" }; //                       sin header → Capa 2 (CRM)
const ctxH = { accountId: "acc_ml", correlationId: "c1", idempotencyKey: "idem-908812" }; // con header → Capa 1
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
  async createContact(): Promise<CrmWriteResult> {
    this.contactCreated += 1;
    this.contactId = "C1";
    return { id: "C1", duplicate: false };
  }
  async createOpportunity(): Promise<CrmWriteResult> {
    this.oppAttempts += 1;
    if (this.oppAttempts === 1) throw new Error("CRM 503 transitorio");
    return { id: "D1", duplicate: false };
  }
}

describe("Capa 2 — sin X-Idempotency-Key (dedup en el CRM por EXTERNAL_ID / cédula)", () => {
  it("crea Contacto + Oportunidad la primera vez", async () => {
    const out = await createOpportunityContact(input, ctx, deps());
    expect(out.status).toBe("created");
  });

  it("mismo NroSolicitud → duplicate (Zoho dedupea por EXTERNAL_ID)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctx, d);
    const second = await createOpportunityContact(input, ctx, d);
    expect(second.status).toBe("duplicate");
  });

  it("reutiliza el Contacto por cédula (distinto NroSolicitud → 2da Oportunidad creada)", async () => {
    const d = deps();
    const first = await createOpportunityContact(input, ctx, d);
    const second = await createOpportunityContact({ ...input, nroSolicitud: 908813 }, ctx, d);
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (second.status === "created") expect(second.reusedContact).toBe(true);
  });
});

describe("Capa 1 — con X-Idempotency-Key (dedup en Catalyst, antes del CRM)", () => {
  it("mismo key + mismo payload → duplicate (corta sin tocar el CRM)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctxH, d);
    const second = await createOpportunityContact(input, ctxH, d);
    expect(second.status).toBe("duplicate");
  });

  it("mismo key + payload distinto → conflict (409)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctxH, d);
    const other = await createOpportunityContact({ ...input, marcaVehiculo: "Fiat" }, ctxH, d);
    expect(other.status).toBe("conflict");
  });

  it("misma key en otra Cuenta no colisiona (Capa 1 scoped por account_id)", async () => {
    const d = deps();
    await createOpportunityContact(input, ctxH, d);
    // misma idem-key, otra Cuenta, NroSolicitud distinto (para aislar la dedup del CRM):
    // si la Capa 1 NO fuera account-scoped, la key colisionaría → conflict; scoped → created.
    const otherAccount = await createOpportunityContact(
      { ...input, nroSolicitud: 908813 },
      { ...ctxH, accountId: "acc_otra" },
      d,
    );
    expect(otherAccount.status).toBe("created");
  });

  it("key nuevo pero el Deal ya existía en el CRM → duplicate (no 'created')", async () => {
    const d = deps();
    await createOpportunityContact(input, ctx, d); //  sin header: crea el Deal (NroSolicitud 908812)
    const withKey = await createOpportunityContact(input, ctxH, d); // header nuevo, mismo NroSolicitud
    expect(withKey.status).toBe("duplicate"); // Capa 2 (EXTERNAL_ID) manda aunque la clave de Capa 1 sea nueva
  });
});

describe("Recuperación de error transitorio", () => {
  it("error en la Oportunidad es reintentable y reusa el Contacto (no huérfano)", async () => {
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

describe("Idempotencia concurrente (AC-08) — dos POST simultáneos con la misma clave", () => {
  it("exactamente 1 created; el otro corta en 'in_progress' sin tocar el CRM (nunca 2 Oportunidades)", async () => {
    // Gate del plan §7. La red física es el UNIQUE(idempotency_key) del DataStore
    // (OQ-P8/CAT-Q3, consola); acá se prueba la LÓGICA: el primero siembra el row y ejecuta
    // el efecto, el segundo ve el 'pending' y devuelve in_progress SIN crear un segundo Deal.
    let oppCreates = 0; // altas reales en el CRM (createOpportunity efectivamente invocado)
    const base = new MockCrmClient();
    const crm: CrmClient = {
      findContactByCedula: (c, conn) => base.findContactByCedula(c, conn),
      createContact: (data, conn) => base.createContact(data, conn),
      createOpportunity: (data, conn) => {
        oppCreates += 1;
        return base.createOpportunity(data, conn);
      },
    };
    const d = { opportunities: new InMemoryOpportunitiesRepository(), crm, connection };
    const [a, b] = await Promise.all([
      createOpportunityContact(input, ctxH, d),
      createOpportunityContact(input, ctxH, d),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.filter((s) => s === "created")).toHaveLength(1);
    expect(statuses).toContain("in_progress");
    expect(oppCreates).toBe(1); // el efecto externo corrió una sola vez
  });
});
