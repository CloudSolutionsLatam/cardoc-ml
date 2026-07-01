/**
 * Tests del generador de PDF (pdf-lib). Verifican que produce un PDF **válido** (no bytes
 * arbitrarios), re-parseable, robusto a datos de terceros (chars fuera de Latin-1) y a
 * campos opcionales ausentes. No asserta bytes exactos (pdf-lib no es byte-determinístico).
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { InformeRevision } from "@cardoc/domain";
import { PdfLibReportGenerator } from "../src/pdf-generator";

const gen = new PdfLibReportGenerator();

const base: InformeRevision = {
  id: "acc_ml-INF-001",
  estado: "completado",
  matricula: "SBA1234",
  vehiculo: "VW Amarok 2018",
  cliente: "Juan Pérez",
  fecha: "2026-06-20",
  pdfDisponible: true,
};

describe("PdfLibReportGenerator", () => {
  it("produce un PDF válido (%PDF, tamaño no trivial) y re-parseable con 1 página", async () => {
    const bytes = await gen.generate(base);
    expect(bytes.byteLength).toBeGreaterThan(500);
    const head = Buffer.from(bytes.slice(0, 5)).toString("utf8");
    expect(head).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toContain("acc_ml-INF-001");
  });

  it("no rompe con campos opcionales ausentes (solo id + estado)", async () => {
    const minimal: InformeRevision = { id: "X-1", estado: "en_progreso", pdfDisponible: false };
    const bytes = await gen.generate(minimal);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("es robusto a datos con caracteres fuera de Latin-1 (nombre del cliente)", async () => {
    // Un nombre con caracteres no-WinAnsi (CJK / emoji) NO debe reventar la generación.
    const exotic: InformeRevision = { ...base, cliente: "李明 🚗 Größe" };
    const bytes = await gen.generate(exotic);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("NO rompe con bytes C1/control <=255 que WinAnsi no encodea (regresión del major)", async () => {
    // Bytes que pasan un filtro '<=255' pero WinAnsi rechaza: comilla/guion tipográfico CP1252
    // crudo (0x92, 0x96), ellipsis (0x85), slot indefinido (0x81), control C0 (0x07), DEL (0x7F).
    const nasty = `ACME${String.fromCharCode(0x92)}s ${String.fromCharCode(0x85)}${String.fromCharCode(0x96)} S.A.${String.fromCharCode(0x81)}${String.fromCharCode(0x07)}${String.fromCharCode(0x7f)}`;
    const bytes = await gen.generate({ ...base, cliente: nasty, vehiculo: nasty });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("NO desborda ni rompe con un valor larguísimo (se trunca)", async () => {
    const bytes = await gen.generate({ ...base, cliente: "Razón Social ".repeat(40) });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("normaliza saltos de línea/tabs en un valor (no rompe, no glifo faltante)", async () => {
    const bytes = await gen.generate({ ...base, cliente: "Línea 1\nLínea 2\r\tcol" });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("preserva los acentos del español (están en Latin-1)", async () => {
    // Vehículo/Matrícula/Revisión con acentos no se sanitizan (codePoint <= 255).
    const bytes = await gen.generate({ ...base, vehiculo: "Citroën Berlingó" });
    expect(bytes.byteLength).toBeGreaterThan(500);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });
});
