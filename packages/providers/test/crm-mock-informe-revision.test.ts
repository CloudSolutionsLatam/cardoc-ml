/** MockCrmClient — correlación NroSolicitud externo → id de Análisis (variante D3b). */
import { describe, expect, it } from "vitest";
import { MockCrmClient, type CrmConnection } from "../src/crm-client";

const conn: CrmConnection = { apiDomain: "https://x", getAccessToken: async () => "tok" };

describe("MockCrmClient.findAnalisisIdByNroSolicitud", () => {
  it("null si no se sembró la correlación", async () => {
    const crm = new MockCrmClient();
    expect(await crm.findAnalisisIdByNroSolicitud("1001", conn)).toBeNull();
  });

  it("devuelve el id de Análisis sembrado", async () => {
    const crm = new MockCrmClient();
    crm.seedInformeRevision("1001", "acc_dev-INF-001");
    expect(await crm.findAnalisisIdByNroSolicitud("1001", conn)).toBe("acc_dev-INF-001");
  });
});
