/**
 * Tests de los use-cases de Informes: listInformes + streamReportPdf.
 *
 * El foco de seguridad es la TENANCY (AC-10): el `accountId` sale del token y se pasa
 * como primer argumento; un recurso de otra Cuenta debe ser INDISTINGUIBLE de inexistente
 * (→ ReportNotFoundError, que la función traduce a 404, nunca 403). El `MockReportsSource`
 * modela ids `${accountId}-INF-NNN`, así que pedir un id de otra Cuenta no matchea.
 */
import { describe, expect, it } from "vitest";
import { MockReportsSource, ReportNotFoundError } from "@cardoc/providers";
import type { ListInformesQuery } from "@cardoc/domain";
import { listInformes } from "../src/list-informes";
import { streamReportPdf } from "../src/stream-pdf";

const reports = new MockReportsSource();
const deps = { reports };
const q = (over: Partial<ListInformesQuery> = {}): ListInformesQuery => ({ limit: 20, ...over });

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe("listInformes — filtrado y scope por Cuenta", () => {
  it("devuelve informes de la Cuenta del token (ids scoped a esa Cuenta)", async () => {
    const page = await listInformes("acc_A", q(), deps);
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((r) => r.id.startsWith("acc_A-"))).toBe(true);
  });

  it("aplica el filtro de estado (allowlist)", async () => {
    const page = await listInformes("acc_A", q({ estado: "completado" }), deps);
    expect(page.data.every((r) => r.estado === "completado")).toBe(true);
  });

  it("aplica el filtro de matrícula", async () => {
    const page = await listInformes("acc_A", q({ matricula: "ABC1234" }), deps);
    expect(page.data.every((r) => r.matricula === "ABC1234")).toBe(true);
  });

  it("respeta el limit", async () => {
    const page = await listInformes("acc_A", q({ limit: 1 }), deps);
    expect(page.data).toHaveLength(1);
    expect(page.page.limit).toBe(1);
  });
});

describe("streamReportPdf — stream + tenancy (gate A→B = not-found)", () => {
  it("streamea el PDF de un informe propio (application/pdf, cuerpo %PDF)", async () => {
    const pdf = await streamReportPdf("acc_A", "acc_A-INF-001", deps);
    expect(pdf.contentType).toBe("application/pdf");
    // D4 (mail Cardoc 2026-07-02): nomenclatura NombreCliente_IDInterno_Fecha.pdf (el "_" del id se sanea a "-").
    expect(pdf.filename).toBe("Cliente-Demo_acc-A-INF-001_2026-06-20.pdf");
    const body = await drain(pdf.stream);
    expect(body.toString("utf8").startsWith("%PDF")).toBe(true);
  });

  it("un informe de OTRA Cuenta → ReportNotFoundError (cross-tenant = 404, no 403)", async () => {
    // Token de acc_A pidiendo un recurso cuyo id pertenece a acc_B: la resolución va
    // filtrada por acc_A → no matchea → not-found. No se revela que el recurso exista.
    await expect(streamReportPdf("acc_A", "acc_B-INF-001", deps)).rejects.toBeInstanceOf(
      ReportNotFoundError,
    );
  });

  it("un id inexistente en la propia Cuenta → ReportNotFoundError (mismo trato que el ajeno)", async () => {
    await expect(streamReportPdf("acc_A", "acc_A-INF-999", deps)).rejects.toBeInstanceOf(
      ReportNotFoundError,
    );
  });
});
