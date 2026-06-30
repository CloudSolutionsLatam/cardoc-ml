import { describe, expect, it } from "vitest";
import { ZohoCrmClient, composeNotaAgenda, type CrmConnection } from "../src/crm-client";

const conn: CrmConnection = {
  apiDomain: "https://www.zohoapis.com",
  getAccessToken: async () => "tok-123",
};

interface Call {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

/** `fetch` falso: registra cada llamada y responde según `responder`. */
function fake(responder: (url: string) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Call["init"] });
    return responder(String(url));
  }) as typeof fetch;
  return { fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const bodyOf = (c: Call) => JSON.parse(c.init?.body ?? "{}") as { data: Array<Record<string, unknown>> };

describe("ZohoCrmClient.findContactByCedula", () => {
  it("arma el search por Cedula con el token y devuelve el id", async () => {
    const { fetchFn, calls } = fake(() => json({ data: [{ id: "C1" }] }));
    const out = await new ZohoCrmClient({ fetchFn }).findContactByCedula(45321890, conn);
    expect(out).toEqual({ id: "C1" });
    expect(calls[0]?.url).toContain("/crm/v2/Contacts/search?criteria=");
    expect(decodeURIComponent(calls[0]!.url)).toContain("(Cedula:equals:45321890)");
    expect(calls[0]?.init?.headers?.["Authorization"]).toBe("Zoho-oauthtoken tok-123");
  });

  it("204 (sin coincidencias) → null", async () => {
    const { fetchFn } = fake(() => new Response(null, { status: 204 }));
    const out = await new ZohoCrmClient({ fetchFn }).findContactByCedula(1, conn);
    expect(out).toBeNull();
  });
});

describe("ZohoCrmClient.createContact", () => {
  const data = { nroCedula: 45321890, nombres: "Juan", apellidos: "Pérez", celular: "099", accountId: "ACC-ML" };

  it("postea a Contacts con los api_names reales y devuelve el id", async () => {
    const { fetchFn, calls } = fake(() => json({ data: [{ code: "SUCCESS", details: { id: "C9" } }] }, 201));
    const out = await new ZohoCrmClient({ fetchFn }).createContact(data, conn);
    expect(out).toEqual({ id: "C9" });
    expect(calls[0]?.url).toBe("https://www.zohoapis.com/crm/v2/Contacts");
    const rec = bodyOf(calls[0]!).data[0]!;
    expect(rec["Last_Name"]).toBe("Pérez");
    expect(rec["First_Name"]).toBe("Juan");
    expect(rec["Cedula"]).toBe(45321890);
    expect(rec["Mobile"]).toBe("099");
    expect(rec["Account_Name"]).toEqual({ id: "ACC-ML" });
  });

  it("código != SUCCESS (HTTP 200) → UpstreamError", async () => {
    const { fetchFn } = fake(() => json({ data: [{ code: "INVALID_DATA", message: "bad" }] }, 200));
    await expect(new ZohoCrmClient({ fetchFn }).createContact(data, conn)).rejects.toThrow(/INVALID_DATA/);
  });

  it("HTTP 400 sin body por-registro → UpstreamError con HTTP status", async () => {
    const { fetchFn } = fake(() => json({ code: "INVALID_REQUEST" }, 400));
    await expect(new ZohoCrmClient({ fetchFn }).createContact(data, conn)).rejects.toThrow(/HTTP 400/);
  });

  it("HTTP 400 con error por-registro → UpstreamError surfacea el code/message", async () => {
    const { fetchFn } = fake(() =>
      json({ data: [{ code: "MANDATORY_NOT_FOUND", status: "error", message: "required field missing" }] }, 400),
    );
    await expect(new ZohoCrmClient({ fetchFn }).createContact(data, conn)).rejects.toThrow(/MANDATORY_NOT_FOUND/);
  });
});

describe("ZohoCrmClient.findDealByExternalId", () => {
  it("busca Deals por EXTERNAL_ID y devuelve el id", async () => {
    const { fetchFn, calls } = fake(() => json({ data: [{ id: "D5" }] }));
    const out = await new ZohoCrmClient({ fetchFn }).findDealByExternalId(908812, conn);
    expect(out).toEqual({ id: "D5" });
    expect(decodeURIComponent(calls[0]!.url)).toContain("/crm/v2/Deals/search");
    expect(decodeURIComponent(calls[0]!.url)).toContain("(EXTERNAL_ID:equals:908812)");
  });

  it("204 → null", async () => {
    const { fetchFn } = fake(() => new Response(null, { status: 204 }));
    expect(await new ZohoCrmClient({ fetchFn }).findDealByExternalId(1, conn)).toBeNull();
  });
});

describe("ZohoCrmClient.createOpportunity", () => {
  it("postea a Deals con Pipeline B2B, Stage, Contact, EXTERNAL_ID (string) y nota_agenda", async () => {
    const { fetchFn, calls } = fake(() => json({ data: [{ code: "SUCCESS", details: { id: "D7" } }] }, 201));
    const out = await new ZohoCrmClient({ fetchFn }).createOpportunity(
      {
        nroSolicitud: 908812,
        contactId: "C9",
        stage: "Nueva Solicitud",
        marca: "Chevrolet",
        modelo: "Onix",
        anio: 2022,
        matricula: "SBA1234",
        sucursal: "Centro",
      },
      conn,
    );
    expect(out).toEqual({ id: "D7" });
    expect(calls[0]?.url).toBe("https://www.zohoapis.com/crm/v2/Deals");
    const rec = bodyOf(calls[0]!).data[0]!;
    expect(rec["Pipeline"]).toBe("B2B");
    expect(rec["Stage"]).toBe("Nueva Solicitud");
    expect(rec["Contact_Name"]).toEqual({ id: "C9" });
    expect(rec["EXTERNAL_ID"]).toBe("908812"); // string, no number (BIGINT)
    expect(String(rec["nota_agenda"])).toContain("Chevrolet Onix 2022");
    expect(String(rec["nota_agenda"])).toContain("SBA1234");
  });
});

describe("composeNotaAgenda", () => {
  it("compone vehículo + matrícula + sucursal y omite lo vacío", () => {
    const nota = composeNotaAgenda({
      nroSolicitud: 1,
      contactId: "c",
      stage: "Nueva Solicitud",
      marca: "Fiat",
      modelo: "Cronos",
      matricula: "ABC1234",
    });
    expect(nota).toContain("Vehículo: Fiat Cronos");
    expect(nota).toContain("Matrícula: ABC1234");
    expect(nota).not.toContain("Sucursal:");
  });

  it("sin datos → cadena vacía", () => {
    expect(composeNotaAgenda({ nroSolicitud: 1, contactId: "c", stage: "X" })).toBe("");
  });
});
