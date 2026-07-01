/**
 * Puerto `PdfGenerator` + implementación con **pdf-lib** (generación en Catalyst).
 *
 * Decisión ADR-0012 (OQ-N1): el PDF del informe se genera **en Catalyst** con una librería
 * JS pura (pdf-lib) — sin binario pesado (Chromium) ni upstream extra (Zoho Writer). La
 * generación es la parte "difícil y pesada" del flujo del PDF; queda detrás de este puerto
 * para poder swappear el motor (p.ej. a Zoho Writer Merge) sin tocar el resto.
 *
 * ⚙️ **Layout PROVISIONAL** (2026-07-01): renderiza los campos disponibles de `InformeRevision`.
 * El diseño real de AutoCheck (secciones, ítems de inspección, logo) se itera después; los
 * datos reales salen del form `Analisis`/`Informes` de Creator cuando se cablee el read (E-03).
 * pdf-lib no hace HTTP — vive en providers por cohesión con el `ReportsSource` que lo usa.
 */
import type { InformeRevision } from "@cardoc/domain";
import { PDFDocument, StandardFonts, rgb, type Color, type PDFFont, type PDFPage } from "pdf-lib";

export interface PdfGenerator {
  /** Renderiza el informe a bytes PDF (`application/pdf`). No hace I/O de red. */
  generate(informe: InformeRevision): Promise<Uint8Array>;
}

const A4 = { w: 595.28, h: 841.89 } as const; // A4 en puntos (72 dpi)
const MARGIN = 56;
const INK = rgb(0.13, 0.14, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.15, 0.39, 0.92);
const RULE = rgb(0.85, 0.87, 0.9);

/**
 * pdf-lib StandardFonts usan **WinAnsiEncoding (CP1252)**, que **NO es Latin-1**: los controles
 * C0 (0x00-0x1F), DEL (0x7F) y **todo el rango C1 (0x80-0x9F)** NO son encodables y harían
 * `throw` en `drawText`/`save`. Ese rango es alcanzable en prod: texto de Word/Excel trae comillas
 * y guiones tipográficos como bytes CP1252 crudos (0x85, 0x91-0x97) que caen en 0x80-0x9F. Además
 * se normaliza el whitespace (drawText no interpreta `\n`). Encodable = ASCII imprimible + Latin-1
 * alto (0xA0-0xFF, incluye acentos del español); el resto → '?'. */
function winAnsiSafe(text: string): string {
  return [...String(text)]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return " "; // tab/nl/cr → espacio
      if (cp < 0x20 || cp === 0x7f) return ""; // otros controles C0 + DEL → se descartan
      if (cp >= 0x80 && cp <= 0x9f) return "?"; // C1: no encodable en WinAnsi
      if (cp > 0xff) return "?"; // fuera de Latin-1 (CJK, emoji, tipografía Unicode)
      return ch; // 0x20-0x7E y 0xA0-0xFF → WinAnsi OK
    })
    .join("");
}

/** Trunca (con "...") para que el texto no desborde `maxWidth` (drawText no hace wrap/clip). */
function fitWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  let t = winAnsiSafe(text);
  if (font.widthOfTextAtSize(t, size) <= maxWidth) {
    return t;
  }
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}...`;
}

const ESTADO_LABEL: Record<InformeRevision["estado"], string> = {
  en_progreso: "En progreso",
  completado: "Completado",
  cerrado: "Cerrado",
};

export class PdfLibReportGenerator implements PdfGenerator {
  async generate(informe: InformeRevision): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(winAnsiSafe(`Informe de Revisión ${informe.id}`));
    doc.setProducer("cardoc");
    doc.setCreator("cardoc (AutoCheck)");

    const page = doc.addPage([A4.w, A4.h]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    // ── Encabezado ──
    let y = A4.h - MARGIN;
    this.draw(page, "AutoCheck", MARGIN, y - 4, 22, bold, ACCENT);
    this.draw(page, "Informe de Revisión de Vehículo", MARGIN, y - 26, 12, font, MUTED);
    y -= 48;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 1, color: RULE });
    y -= 32;

    // ── Campos (label/value) ──
    const rows: Array<[string, string | undefined]> = [
      ["Nº de informe", informe.id],
      ["Estado", ESTADO_LABEL[informe.estado]],
      ["Matrícula", informe.matricula],
      ["Vehículo", informe.vehiculo],
      ["Cliente", informe.cliente],
      ["Fecha", informe.fecha],
    ];
    for (const [label, value] of rows) {
      this.drawRow(page, font, bold, label, value ?? "—", y);
      y -= 30;
    }

    // ── Pie ──
    page.drawLine({
      start: { x: MARGIN, y: MARGIN + 24 },
      end: { x: A4.w - MARGIN, y: MARGIN + 24 },
      thickness: 1,
      color: RULE,
    });
    this.draw(
      page,
      "Documento generado por cardoc · layout provisional (E-03, pendiente diseño final)",
      MARGIN,
      MARGIN + 8,
      8,
      font,
      MUTED,
    );

    return doc.save();
  }

  private drawRow(page: PDFPage, font: PDFFont, bold: PDFFont, label: string, value: string, y: number): void {
    const maxWidth = A4.w - 2 * MARGIN; // ancho útil de la página
    this.draw(page, label.toUpperCase(), MARGIN, y, 8, bold, MUTED);
    this.draw(page, fitWidth(value, font, 13, maxWidth), MARGIN, y - 15, 13, font, INK);
  }

  /** Dibuja texto ya sanitizado (WinAnsi) con red de seguridad: si aún así el encode falla,
   *  cae a ASCII puro — la generación NUNCA debe tirar (sería un 500 permanente para ese informe). */
  private draw(page: PDFPage, text: string, x: number, y: number, size: number, font: PDFFont, color: Color): void {
    const safe = winAnsiSafe(text);
    try {
      page.drawText(safe, { x, y, size, font, color });
    } catch {
      page.drawText(safe.replace(/[^\x20-\x7E]/g, "?"), { x, y, size, font, color });
    }
  }
}
