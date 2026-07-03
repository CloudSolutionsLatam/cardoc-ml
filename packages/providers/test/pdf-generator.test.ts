/**
 * Tests del generador de PDF (pdf-lib) contra el modelo real `InformeReport`. Verifican PDF
 * válido/re-parseable, robustez a datos de terceros (chars fuera de Latin-1, texto largo,
 * saltos de línea), score=0 válido, e informe vacío. No asserta bytes exactos.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import type { InformeReport, ReportDetalle } from "@cardoc/domain";
import { capLines, hardBreak, PdfLibReportGenerator, wrapText } from "../src/pdf-generator";

/** PNG 8x8 rojo válido (fixture para probar el embed de fotos, sin depender de una lib de imágenes). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIElEQVR4AYXBAQEAAAiAIPP/53qQMAvLQ4IECRIkSJBwElsCDgH7XhwAAAAASUVORK5CYII=",
  "base64",
);

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

  it("embebe fotos (fetch→embed, PNG original) y genera PDF válido", async () => {
    const png = new Uint8Array(TINY_PNG);
    const g = new PdfLibReportGenerator({ generatedAt: "t", fetchImage: async () => png });
    const bytes = await g.generate(report({ detalles: [detalle({ imagenes: ["a", "b", "c"] })] }));
    const doc = await PDFDocument.load(bytes);
    // 3 fotos → 2 filas; embebidas dentro de la tarjeta (cover + contenido ⇒ >= 2 páginas).
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(imagePlacements(doc).filter((im) => im.page > 0)).toHaveLength(3);
  });
});

describe("PdfLibReportGenerator — fotos 2 por fila dentro de la tarjeta", () => {
  const png = new Uint8Array(TINY_PNG); // 8x8 cuadrada → w == h al mostrarse
  const g = new PdfLibReportGenerator({ generatedAt: "t", fetchImage: async () => png });

  it("dibuja 2 fotos lado a lado (misma fila, 2 columnas a ~mitad de ancho)", async () => {
    const doc = await PDFDocument.load(
      await g.generate(report({ detalles: [detalle({ imagenes: ["a", "b"], nota: null, aiSummary: null })] })),
    );
    const imgs = imagePlacements(doc).filter((im) => im.page > 0); // excluye el logo de la portada
    expect(imgs).toHaveLength(2);
    const [left, right] = [...imgs].sort((p, q) => p.x - q.x);
    expect(left.page).toBe(right.page); // misma página
    expect(Math.abs(left.y - right.y)).toBeLessThan(0.5); // misma fila (misma y)
    expect(right.x).toBeGreaterThan(left.x + left.w * 0.9); // 2ª foto a la derecha de la 1ª (2 columnas)
    // Cada foto ocupa ~mitad del ancho de contenido (no una foto gigante a ancho completo).
    expect(left.w).toBeLessThan(300);
    expect(left.w).toBeGreaterThan(200);
  });

  it("una tarjeta con muchas fotos se pagina por segmentos (la tarjeta abarca > 1 página)", async () => {
    const doc = await PDFDocument.load(
      await g.generate(
        report({
          detalles: [detalle({ imagenes: ["a", "b", "c", "d", "e", "f"], descripcion: "detalle ".repeat(60), aiSummary: "diag ".repeat(60) })],
        }),
      ),
    );
    const imgs = imagePlacements(doc).filter((im) => im.page > 0);
    expect(imgs).toHaveLength(6); // 6 fotos = 3 filas de 2
    expect(new Set(imgs.map((im) => im.page)).size).toBeGreaterThan(1); // el bloque de fotos paginó
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

// ── Extracción estructural del PDF (sin rasterizador): operadores de una página ────────────────
/** Stream de operadores (descomprimido) de una página. */
function pageContent(doc: PDFDocument, pageIndex: number): string {
  const raw = doc.getPages()[pageIndex].node.Contents() as unknown;
  if (!raw) return "";
  const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const items = resolved instanceof PDFArray ? resolved.asArray() : [resolved];
  let ops = "";
  for (const item of items) {
    const s = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (s instanceof PDFRawStream) ops += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return ops;
}

/** Texto de una página: pdf-lib lo dibuja como hex-strings (`<4D41..> Tj`); los decodificamos. */
function pageText(doc: PDFDocument, pageIndex: number): string {
  return (pageContent(doc, pageIndex).match(/<([0-9A-Fa-f]+)>/g) ?? [])
    .map((tok) => {
      const hex = tok.slice(1, -1);
      let out = "";
      for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return out;
    })
    .join("\n");
}

/** Índice de la primera página cuyo texto contiene `marker`, o -1. */
function pageOf(doc: PDFDocument, marker: string): number {
  for (let i = 0; i < doc.getPageCount(); i++) if (pageText(doc, i).includes(marker)) return i;
  return -1;
}

/** Imágenes colocadas: pdf-lib emite `... tx ty cm` (posición) + `w 0 0 h 0 0 cm` (tamaño) antes de `Do`. */
function imagePlacements(doc: PDFDocument): Array<{ page: number; x: number; y: number; w: number; h: number }> {
  const re = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\s*1 0 0 1 0 0 cm\s*(-?[\d.]+) 0 0 (-?[\d.]+) 0 0 cm\s*1 0 0 1 0 0 cm\s*\/[\w-]+ Do/g;
  const out: Array<{ page: number; x: number; y: number; w: number; h: number }> = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const ops = pageContent(doc, i);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ops))) out.push({ page: i, x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  }
  return out;
}

describe("PdfLibReportGenerator — keep-with-next (título + primer componente)", () => {
  it("el título de sección arranca en la MISMA página que su primer componente (no huérfano al pie)", async () => {
    // Bloque largo → tarjetas ALTAS. La sección 1 baja el cursor y el primer componente de la
    // sección 2 (desc + nota + diagnóstico, casi media página) no entra junto al título al pie.
    const big = "Diagnostico detallado del componente con mucho texto de relleno. ".repeat(40);
    const detalles: ReportDetalle[] = [
      detalle({ id: 1, seccionId: 1, tituloJerarquico: "SECCIONUNOCOMP relleno", descripcion: big, aiSummary: null, nota: null, imagenes: [] }),
      detalle({ id: 2, seccionId: 2, tituloJerarquico: "COMPONENTEUNO alto", descripcion: big, aiSummary: big, nota: "Nota extensa del inspector con varias lineas de detalle tecnico. ".repeat(8), imagenes: [] }),
    ];
    const bytes = await gen.generate(
      report({
        resumenTranscripcion: null,
        recomendaciones: null,
        score: null,
        secciones: [
          { id: 1, titulo: "SECCIONUNO", completada: true, activa: true },
          { id: 2, titulo: "SECCIONDOS", completada: true, activa: true },
        ],
        detalles,
      }),
    );
    const doc = await PDFDocument.load(bytes);
    const pTitulo = pageOf(doc, "SECCIONDOS");
    const pComp = pageOf(doc, "COMPONENTEUNO");
    expect(pTitulo).toBeGreaterThanOrEqual(0);
    expect(pComp).toBe(pTitulo); // keep-with-next: título y primer componente en la misma página
    expect(pTitulo).toBeGreaterThan(pageOf(doc, "SECCIONUNO")); // hubo salto real: se ejercita el caso huérfano
  });

  it("el título de Puntaje/Resumen no queda huérfano de su bloque (keep-with-next también en summary/score)", async () => {
    // Un resumen largo empuja el título "Puntaje Técnico" cerca del pie de página.
    const resumenLargo = `palabra `.repeat(300);
    const bytes = await gen.generate(
      report({
        resumenTranscripcion: resumenLargo,
        recomendaciones: null,
        score: 8,
        score_comentario: "PUNTAJEMARCA comentario del puntaje técnico.",
        secciones: [],
        detalles: [],
      }),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1); // el resumen largo pagina: se ejercita el caso huérfano
    // "Puntaje T" (título completo) evita el falso match con el índice de portada ("...y Puntaje").
    const pTitulo = pageOf(doc, "Puntaje T");
    const pBody = pageOf(doc, "PUNTAJEMARCA");
    expect(pTitulo).toBeGreaterThanOrEqual(0);
    expect(pBody).toBe(pTitulo); // título y bloque del puntaje en la misma página
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
