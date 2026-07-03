/**
 * Tests del pipeline de `ZohoCreatorReportsSource.openPdf` con un `fetchReportDetail` FAKE
 * (sin red): valida el manejo del envelope, la defensa portalType (§5.3), el paso por el
 * transform y la generación del PDF. El HTTP real (creator-client) es config-driven y se
 * confirma aparte; acá se prueba la LÓGICA del adapter.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  createReportDetailFetcher,
  NotImplementedError,
  ReportNotFoundError,
  UpstreamError,
  ZohoCreatorReportsSource,
  shouldRejectDetailByPortalType,
  type CreatorConnection,
  type CreatorEnvelope,
  type ReportDetailFetcher,
} from "../src/index";

const sampleResult = {
  code: "#R-12345",
  score: 8,
  recomendaciones: "Service en 1.000 km.",
  vehicle: { marca: "VW", modelo: "Amarok", año: "2018", matricula: "SBA1234", kms: 90000, motor: "2.0", transmision: "AT" },
  inspector: { name: "Ana Inspectora", fecha: "20/06/2026" },
  inspection_agency: { name: "AutoCheck" },
  cliente: { nombre: "Juan Pérez", telefono: "099 123 456" },
  modulos: [
    { name: "Chasis", sub_modulos: [{ name: "Frente", components: [{ name: "Larguero", status: { name: "bueno" }, evidences: [] }] }] },
  ],
};

function source(envelope: CreatorEnvelope): ZohoCreatorReportsSource {
  const fetchReportDetail: ReportDetailFetcher = async () => envelope;
  return new ZohoCreatorReportsSource({ fetchReportDetail });
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe("ZohoCreatorReportsSource.openPdf", () => {
  it("envelope OK (code 3000) → genera y streamea un PDF válido", async () => {
    const pdf = await source({ code: 3000, result: { ...sampleResult, portalType: "ml" } }).openPdf("acc_ml", "#R-12345");
    expect(pdf.contentType).toBe("application/pdf");
    const body = await drain(pdf.stream);
    expect(body.toString("utf8").slice(0, 5)).toBe("%PDF-");
    await expect(PDFDocument.load(body)).resolves.toBeDefined();
  });

  it("nombre del PDF: sin inspector.fecha usa la fecha de generación como fallback", async () => {
    const fetchReportDetail: ReportDetailFetcher = async () => ({
      code: 3000,
      result: { ...sampleResult, inspector: { name: "Ana" }, portalType: "ml" }, // sin `fecha`
    });
    const src = new ZohoCreatorReportsSource({ fetchReportDetail, generatedAt: "01/07/2026, 09:56 a. m." });
    const pdf = await src.openPdf("acc_ml", "4837888000004307360");
    expect(pdf.filename).toContain("_2026-07-01.pdf"); // fecha de generación, no "sin-fecha"
  });

  it("result sin portalType (back-compat R3) → se permite", async () => {
    const pdf = await source({ code: 3000, result: sampleResult }).openPdf("acc_ml", "#R-1");
    expect((await drain(pdf.stream)).toString("utf8").slice(0, 5)).toBe("%PDF-");
  });

  it("portalType ajeno ('cardoc') → ReportNotFoundError (no revela existencia, §5.3/R2)", async () => {
    await expect(
      source({ code: 3000, result: { ...sampleResult, portalType: "cardoc" } }).openPdf("acc_ml", "#R-1"),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
  });

  it("code != 3000 → UpstreamError(creator)", async () => {
    await expect(source({ code: 500 }).openPdf("acc_ml", "#R-1")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("result vacío → UpstreamError(creator)", async () => {
    await expect(source({ code: 3000, result: null }).openPdf("acc_ml", "#R-1")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("token de Creator vencido (result.status 401 UNAUTHORIZED) → UpstreamError, NO 404", async () => {
    const err = await source({ code: 3000, result: { status: 401, error: "UNAUTHORIZED" } })
      .openPdf("acc_ml", "#R-1")
      .catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(ReportNotFoundError);
  });

  it("result de error no-401 (status>=400, p.ej. 403) → UpstreamError (no un PDF vacío con 200)", async () => {
    await expect(
      source({ code: 3000, result: { status: 403, error: "FORBIDDEN" } }).openPdf("acc_ml", "#R-1"),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("envelope null (fetcher devolvió null) → UpstreamError, no TypeError crudo", async () => {
    const src = new ZohoCreatorReportsSource({ fetchReportDetail: async () => null as unknown as CreatorEnvelope });
    await expect(src.openPdf("acc_ml", "#R-1")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("listByAccount / findById siguen sin implementar (ADR-0015: listado descartado)", async () => {
    const src = source({ code: 3000, result: sampleResult });
    await expect(src.listByAccount("acc_ml", { limit: 20 })).rejects.toBeInstanceOf(NotImplementedError);
    await expect(src.findById("acc_ml", "x")).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe("createReportDetailFetcher — manejo robusto del HTTP", () => {
  const conn: CreatorConnection = {
    reportDetailUrl: "https://creator.example/api/detail?publickey=pk",
    getAccessToken: async () => "tok",
  };
  const fakeRes = (init: { ok: boolean; status: number; json: () => Promise<unknown> }) =>
    init as unknown as Response;

  it("envelope OK → devuelve el objeto parseado", async () => {
    const fetcher = createReportDetailFetcher(conn, async () => fakeRes({ ok: true, status: 200, json: async () => ({ code: 3000, result: {} }) }));
    expect((await fetcher("#R-1", "ml")).code).toBe(3000);
  });

  it("HTTP no-ok → UpstreamError con el status", async () => {
    const fetcher = createReportDetailFetcher(conn, async () => fakeRes({ ok: false, status: 503, json: async () => ({}) }));
    await expect(fetcher("#R-1", "ml")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("body no-JSON (200 con HTML) → UpstreamError, no SyntaxError crudo", async () => {
    const fetcher = createReportDetailFetcher(conn, async () =>
      fakeRes({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
    );
    await expect(fetcher("#R-1", "ml")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("body literal null (200) → UpstreamError", async () => {
    const fetcher = createReportDetailFetcher(conn, async () => fakeRes({ ok: true, status: 200, json: async () => null }));
    await expect(fetcher("#R-1", "ml")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rechazo de red (fetch tira) → UpstreamError, no Error crudo", async () => {
    const fetcher = createReportDetailFetcher(conn, async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetcher("#R-1", "ml")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("modo publickey: preserva la key de la URL de consola y agrega id + portalType (sin Authorization)", async () => {
    const base = "https://www.zohoapis.com/creator/custom/acme/GET_INSPECTION_REPORT_DETAIL?publickey=PK123";
    let called = "";
    let hadAuth = true;
    const fetcher = createReportDetailFetcher(
      { reportDetailUrl: base, getAccessToken: async () => "t" },
      async (u, init) => {
        called = String(u);
        hadAuth = Boolean((init?.headers as Record<string, string>)?.["Authorization"]);
        return fakeRes({ ok: true, status: 200, json: async () => ({ code: 3000, result: {} }) });
      },
    );
    await fetcher("#R-9", "ml");
    expect(called).toContain("/creator/custom/acme/GET_INSPECTION_REPORT_DETAIL");
    expect(called).toContain("id=%23R-9"); // '#' url-encoded
    expect(called).toContain("portalType=ml");
    expect(called).toContain("publickey=PK123"); // la key de la consola se preserva
    expect(hadAuth).toBe(false); // publickey NO manda header OAuth
  });

  it("modo oauth: agrega Authorization: Zoho-oauthtoken con el token del self-client", async () => {
    let authHeader = "";
    const fetcher = createReportDetailFetcher(
      { reportDetailUrl: "https://www.zohoapis.com/creator/custom/acme/GET_INSPECTION_REPORT_DETAIL", authMode: "oauth", getAccessToken: async () => "TKN-999" },
      async (_u, init) => {
        authHeader = ((init?.headers as Record<string, string>) ?? {})["Authorization"] ?? "";
        return fakeRes({ ok: true, status: 200, json: async () => ({ code: 3000, result: {} }) });
      },
    );
    await fetcher("#R-9", "ml");
    expect(authHeader).toBe("Zoho-oauthtoken TKN-999");
  });

  it("mintToken presente → agrega el query param token", async () => {
    let called = "";
    const fetcher = createReportDetailFetcher(
      { reportDetailUrl: "https://x/creator/custom/cardoc/API?publickey=pk", mintToken: () => "TKN-abc", getAccessToken: async () => "t" },
      async (u) => {
        called = String(u);
        return fakeRes({ ok: true, status: 200, json: async () => ({ code: 3000, result: {} }) });
      },
    );
    await fetcher("#R-1", "ml");
    expect(called).toContain("token=TKN-abc");
  });

  it("reportDetailUrl ausente/ inválida → UpstreamError (no URL crudo)", async () => {
    const fetcher = createReportDetailFetcher(
      { reportDetailUrl: "", getAccessToken: async () => "t" },
      async () => fakeRes({ ok: true, status: 200, json: async () => ({}) }),
    );
    await expect(fetcher("#R-1", "ml")).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("shouldRejectDetailByPortalType (§5.3)", () => {
  it("R2: portalType distinto → rechaza", () => {
    expect(shouldRejectDetailByPortalType({ portalType: "cardoc" }, "ml")).toBe(true);
  });
  it("R2: portalType igual → permite", () => {
    expect(shouldRejectDetailByPortalType({ portalType: "ml" }, "ml")).toBe(false);
  });
  it("R3: sin portalType → permite (back-compat)", () => {
    expect(shouldRejectDetailByPortalType({}, "ml")).toBe(false);
  });
  it("null/undefined → permite", () => {
    expect(shouldRejectDetailByPortalType(null, "ml")).toBe(false);
    expect(shouldRejectDetailByPortalType(undefined, "ml")).toBe(false);
  });
});
