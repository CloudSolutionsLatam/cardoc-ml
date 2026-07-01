/**
 * Tests del generador de PDF (pdf-lib) contra el modelo real `InformeReport`. Verifican PDF
 * válido/re-parseable, robustez a datos de terceros (chars fuera de Latin-1, texto largo,
 * saltos de línea), score=0 válido, e informe vacío. No asserta bytes exactos.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { InformeReport, ReportDetalle } from "@cardoc/domain";
import { capLines, hardBreak, PdfLibReportGenerator, wrapText } from "../src/pdf-generator";

const gen = new PdfLibReportGenerator({ generatedAt: "01/07/2026 10:00" });

function detalle(over: Partial<ReportDetalle> = {}): ReportDetalle {
  return {
    id: 1,
    componenteId: "c1",
    seccionId: 1,
    titulo: "Componente",
    subtitulo: "",
    tituloJerarquico: "Chasis - Frente - Larguero",
    estado: "critico",
    descripcion: "Fuga de aceite en la tapa de válvulas.",
    imagenes: [],
    audioData: [],
    videoData: [],
    pdfData: [],
    nota: "Revisar en el próximo service.",
    aiSummary: "Fuga activa; requiere reemplazo de junta.",
    ...over,
  };
}

function report(over: Partial<InformeReport> = {}): InformeReport {
  return {
    id: "#R-12345",
    reportCode: "#R-12345",
    recomendaciones: "Service de mantenimiento en 1.000 km.",
    vehiculo: { marca: "VW", modelo: "Amarok", año: "2018", placa: "SBA1234", kilometraje: "90000 km", motor: "2.0 TDI", transmision: "Automática", imagen: "" },
    cliente: { nombre: "Juan Pérez", telefono: "099 123 456" },
    fechaInspeccion: "20/06/2026",
    inspector: { nombre: "Ana Inspectora", cargo: "Inspector @ AutoCheck", telefono: "", avatar: "", iniciales: "AI" },
    resumenAudio: null,
    resumenTranscripcion: "El vehículo está en buen estado general con observaciones menores.",
    score: 8,
    score_comentario: "Buen estado, observaciones no críticas.",
    secciones: [{ id: 1, titulo: "Chasis", completada: true, activa: true }],
    detalles: [detalle()],
    ...over,
  };
}

describe("PdfLibReportGenerator — informe completo", () => {
  it("produce un PDF válido, re-parseable, con >=1 página y título con el reportCode", async () => {
    const bytes = await gen.generate(report());
    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toContain("#R-12345");
  });

  it("score = 0 renderiza (no oculta la sección)", async () => {
    const bytes = await gen.generate(report({ score: 0 }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("informe vacío (sin secciones, sin score/recomendaciones/transcripción) igual genera portada", async () => {
    const bytes = await gen.generate(
      report({ recomendaciones: null, resumenTranscripcion: null, score: null, secciones: [], detalles: [] }),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("muchos componentes → pagina en varias hojas (sin cortar/crash)", async () => {
    const detalles = Array.from({ length: 30 }, (_, i) => detalle({ id: i + 1, tituloJerarquico: `Chasis - Comp ${i + 1}` }));
    const bytes = await gen.generate(report({ detalles }));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

describe("PdfLibReportGenerator — robustez a datos de terceros", () => {
  it("NO rompe con bytes C1/control <=255 que WinAnsi no encodea", async () => {
    const nasty = `ACME${String.fromCharCode(0x92)} ${String.fromCharCode(0x85)}${String.fromCharCode(0x81)}${String.fromCharCode(0x07)}`;
    const bytes = await gen.generate(report({ cliente: { nombre: nasty, telefono: nasty } }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("NO desborda ni rompe con texto larguísimo (wrap + paginación)", async () => {
    const long = "Diagnóstico extenso. ".repeat(200);
    const bytes = await gen.generate(report({ detalles: [detalle({ aiSummary: long, descripcion: long })] }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("normaliza saltos de línea/tabs (no rompe, no glifo faltante)", async () => {
    const bytes = await gen.generate(report({ recomendaciones: "Línea 1\nLínea 2\r\tcol" }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("fotos sin fetcher no rompen (placeholder); con fetcher que falla, se omiten", async () => {
    const withPhotos = report({ detalles: [detalle({ imagenes: ["wd://f1", "wd://f2"] })] });
    // sin fetcher (default):
    await expect(PDFDocument.load(await gen.generate(withPhotos))).resolves.toBeDefined();
    // con fetcher que devuelve null / tira:
    const g2 = new PdfLibReportGenerator({ fetchImage: async () => null });
    await expect(PDFDocument.load(await g2.generate(withPhotos))).resolves.toBeDefined();
    const g3 = new PdfLibReportGenerator({
      fetchImage: async () => {
        throw new Error("workdrive 500");
      },
    });
    await expect(PDFDocument.load(await g3.generate(withPhotos))).resolves.toBeDefined();
  });
});

describe("helpers de layout (wrap / hard-break / cap)", () => {
  it("wrapText: ninguna línea supera maxWidth, incluso con una palabra larguísima sin espacios", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const maxW = 120;
    const longWord = "https://workdrive.zoho/download/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?tk=xxxxxxxx";
    const lines = wrapText(`prefijo ${longWord} sufijo`, font, 10, maxW);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(maxW + 0.5);
    expect(lines.length).toBeGreaterThan(1); // la palabra larga se partió (hard-break)
  });

  it("hardBreak: palabra corta intacta; palabra ancha → fragmentos que entran en maxWidth", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(hardBreak("corto", font, 10, 200)).toEqual(["corto"]);
    const chunks = hardBreak("x".repeat(300), font, 10, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(font.widthOfTextAtSize(c, 10)).toBeLessThanOrEqual(100 + 0.5);
  });

  it("capLines: respeta si entra; trunca a max con '...' si excede", () => {
    expect(capLines(["a", "b"], 5)).toEqual(["a", "b"]);
    const capped = capLines(["a", "b", "c", "d"], 2);
    expect(capped).toHaveLength(2);
    expect(capped[1].endsWith("...")).toBe(true);
  });
});
