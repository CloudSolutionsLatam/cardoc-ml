/**
 * Puerto `PdfGenerator` + implementación con **pdf-lib** (generación en Catalyst).
 *
 * Reconstrucción FIEL (no pixel-1:1) del informe del portal de clientes —
 * `docs/reference/pdf-backend/planning.md` §5.5. cardoc-ml es el **generador único** del PDF
 * (reemplaza el `window.print()` del portal). Motor: pdf-lib (ADR-0012), sin navegador.
 *
 * pdf-lib dibuja por coordenadas (no hay CSS/flexbox/paginación automática), así que acá viven
 * un cursor con paginación (`Layout`), wrapping de texto y tarjetas medidas. Las fotos se embeben
 * vía un `ImageFetcher` inyectable (lo provee el adapter Creator con auth de WorkDrive); sin
 * fetcher se dibuja un placeholder con el conteo (no hay red por defecto).
 */
import type { EstadoComponente, InformeReport, ReportDetalle } from "@cardoc/domain";
import { PDFDocument, StandardFonts, rgb, type Color, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";

/** Trae los bytes de una imagen (WorkDrive) o null si no se pudo. Lo inyecta el adapter Creator. */
export type ImageFetcher = (url: string) => Promise<Uint8Array | null>;

export interface PdfGeneratorOptions {
  /** Fetcher de imágenes (WorkDrive). Sin él, las fotos se dibujan como placeholder. */
  fetchImage?: ImageFetcher;
  /** Timestamp "Generado:" (el cliente lo estampa). Inyectable para tests deterministas. */
  generatedAt?: string;
}

export interface PdfGenerator {
  generate(informe: InformeReport): Promise<Uint8Array>;
}

// ── Geometría y paleta (de planning.md §5.5) ───────────────────────────────────
const A4 = { w: 595.28, h: 841.89 } as const;
const MARGIN = 42;
const CONTENT_W = A4.w - 2 * MARGIN;
const BOTTOM = 54; // margen inferior (deja lugar para el pie)

const INK = rgb(0.17, 0.17, 0.17);
const MUTED = rgb(0.6, 0.6, 0.62);
const FAINT = rgb(0.62, 0.63, 0.65);
const BRAND = rgb(0.96, 0.77, 0.0); // #F5C400
const RULE = rgb(0.9, 0.91, 0.93);
const CARD_BORDER = rgb(0.9, 0.91, 0.93);
const ESTADO_COLOR: Record<EstadoComponente, Color> = {
  aprobado: rgb(0.086, 0.639, 0.29), // #16a34a
  observacion: rgb(0.851, 0.467, 0.024), // #d97706
  critico: rgb(0.863, 0.149, 0.149), // #dc2626
};

/** ÍNDICE FIJO de la portada (verbatim planning.md §5.5 — NO deriva de los datos). */
const INDICE_PORTADA: Array<{ titulo: string; descripcion: string }> = [
  { titulo: "Resumen, Recomendaciones y Puntaje", descripcion: "Comentarios generales del técnico, recomendaciones y un puntaje general del estado del vehículo." },
  { titulo: "Chasis", descripcion: "Estructura principal del vehículo: deformaciones, daños o reparaciones que comprometan la seguridad." },
  { titulo: "Carrocería", descripcion: "Paneles y espesor de pintura para determinar si conservan el estado original de fábrica." },
  { titulo: "Interior", descripcion: "Estado y funcionamiento de los componentes del interior del vehículo." },
  { titulo: "Mecánica", descripcion: "Componentes mecánicos: estado, posibles fallas o desgastes." },
  { titulo: "Electrónica", descripcion: "Alertas e indicadores y escaneo con equipos de diagnóstico." },
  { titulo: "Prueba Dinámica", descripcion: "Prueba de conducción para evaluar el comportamiento real del vehículo." },
  { titulo: "PRO", descripcion: "Componentes del PRO, con un enfoque ampliado y más información." },
];

const LEGAL =
  "El servicio se limita a la revisión, análisis técnico e informe sobre el estado del vehículo. El mismo no constituye una garantía. " +
  "ML se deslinda de toda responsabilidad ante cualquier tipo de anomalía o desperfecto no detectado, como también por vicios ocultos. " +
  "ML no será responsable ante ninguna acción u omisión de buena fe o con culpa simple, obligándose únicamente a la realización del análisis técnico e informe contratado.";

/**
 * Tipografía Unicode (comillas/guiones/ellipsis/bullet) → ASCII. WinAnsi la soporta vía CP1252,
 * pero degradar a ASCII es más robusto y suficiente para el informe (evita el '?' del catch-all).
 */
const TYPO_TO_ASCII: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201a: "'", // ' ' ‚
  0x201c: '"', 0x201d: '"', 0x201e: '"', // " " „
  0x2013: "-", 0x2014: "-", 0x2015: "-", // – — ―
  0x2026: "...", // …
  0x2022: "-", // •
  0x00a0: " ", // nbsp
};

/** WinAnsi (CP1252) != Latin-1: los controles C0/C1/DEL no encodean y romperían el render. */
function winAnsiSafe(text: string): string {
  return [...String(text)]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return " ";
      if (cp < 0x20 || cp === 0x7f) return "";
      if (cp >= 0x80 && cp <= 0x9f) return "?"; // controles C1: no encodables
      const ascii = TYPO_TO_ASCII[cp];
      if (ascii !== undefined) return ascii;
      if (cp > 0xff) return "?"; // resto fuera de Latin-1 (CJK, emoji)
      return ch; // 0x20-0x7E y 0xA0-0xFF → WinAnsi OK
    })
    .join("");
}

/** Parte una palabra más ancha que `maxWidth` en fragmentos por carácter (overflow-wrap). */
export function hardBreak(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of word) {
    if (!chunk || font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) chunk += ch;
    else {
      chunks.push(chunk);
      chunk = ch;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Parte `text` en líneas que no superan `maxWidth`; una palabra sola muy larga se corta (hard-break). */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of winAnsiSafe(text).split(/\s+/).filter(Boolean)) {
    for (const w of hardBreak(word, font, size, maxWidth)) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = w;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Limita `lines` a `max`, marcando truncamiento con "..." en la última (evita tarjetas más altas que la página). */
export function capLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1]?.replace(/\s+\S*$/, "") ?? ""}...`;
  return kept;
}

/** Cursor de layout con paginación: dibuja de arriba hacia abajo y agrega páginas al llenarse. */
class Layout {
  page: PDFPage;
  y: number;
  constructor(
    readonly doc: PDFDocument,
    readonly reg: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.page = doc.addPage([A4.w, A4.h]);
    this.y = A4.h - MARGIN;
  }
  /** Asegura `h` puntos de alto libres; si no entran, salta de página. */
  ensure(h: number): void {
    if (this.y - h < BOTTOM) this.newPage();
  }
  newPage(): void {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - MARGIN;
  }
  /** Dibuja texto (sanitizado, con red try/catch) y NO mueve el cursor. */
  text(t: string, x: number, y: number, size: number, font: PDFFont, color: Color): void {
    const safe = winAnsiSafe(t);
    try {
      this.page.drawText(safe, { x, y, size, font, color });
    } catch {
      this.page.drawText(safe.replace(/[^\x20-\x7e]/g, "?"), { x, y, size, font, color });
    }
  }
  /** Dibuja un párrafo wrappeado desde el cursor; avanza `y`. */
  paragraph(t: string, size: number, font: PDFFont, color: Color, lineGap = 4, x = MARGIN, width = CONTENT_W): void {
    for (const line of wrapText(t, font, size, width)) {
      this.ensure(size + lineGap);
      this.text(line, x, this.y - size, size, font, color);
      this.y -= size + lineGap;
    }
  }
}

const ESTADO_LABEL: Record<EstadoComponente, string> = {
  aprobado: "Aprobado",
  observacion: "Observación",
  critico: "Crítico",
};

export class PdfLibReportGenerator implements PdfGenerator {
  constructor(private readonly opts: PdfGeneratorOptions = {}) {}

  async generate(informe: InformeReport): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(winAnsiSafe(`Informe de Revisión ${informe.reportCode}`));
    doc.setProducer("cardoc");
    doc.setCreator("cardoc (AutoCheck)");
    const reg = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const L = new Layout(doc, reg, bold);
    const generadoEn = this.opts.generatedAt ?? "";

    this.cover(L, informe, generadoEn);
    if (informe.resumenTranscripcion) this.summaryBlock(L, "Resumen del Técnico", informe.resumenTranscripcion);
    if (informe.recomendaciones) this.summaryBlock(L, "Recomendaciones del Inspector", informe.recomendaciones);
    if (informe.score != null) this.score(L, informe.score, informe.score_comentario);

    for (const seccion of informe.secciones) {
      const detalles = informe.detalles.filter((d) => d.seccionId === seccion.id);
      if (!detalles.length) continue;
      this.sectionTitle(L, seccion.titulo);
      for (const d of detalles) await this.componentCard(L, d);
    }

    this.footer(L, informe.reportCode, generadoEn);
    return doc.save();
  }

  // ── Portada ──
  private cover(L: Layout, informe: InformeReport, generadoEn: string): void {
    L.text("AutoCheck", MARGIN, L.y - 18, 22, L.bold, rgb(0.15, 0.39, 0.92));
    L.text("Informe de Revisión de Vehículo", MARGIN, L.y - 34, 11, L.reg, MUTED);
    const codeText = winAnsiSafe(informe.reportCode || "—");
    L.text(codeText, A4.w - MARGIN - L.bold.widthOfTextAtSize(codeText, 13), L.y - 18, 13, L.bold, INK);
    if (generadoEn) {
      const g = winAnsiSafe(`Generado: ${generadoEn}`);
      L.text(g, A4.w - MARGIN - L.reg.widthOfTextAtSize(g, 9), L.y - 32, 9, L.reg, MUTED);
    }
    L.y -= 46;
    L.page.drawRectangle({ x: MARGIN, y: L.y, width: CONTENT_W, height: 2.5, color: BRAND });
    L.y -= 22;

    const v = informe.vehiculo;
    L.text(winAnsiSafe(`${v.marca} ${v.modelo} ${v.año}`.trim()), MARGIN, L.y - 18, 20, L.bold, INK);
    L.y -= 34;

    this.card(L, "Datos del Vehículo", [
      ["Matrícula", v.placa || "—"],
      ["Kilometraje", v.kilometraje || "—"],
      ["Motor", v.motor || "—"],
      ["Transmisión", v.transmision || "—"],
    ]);
    this.card(L, "Cliente", [
      ["Nombre", informe.cliente.nombre || "—"],
      ["Teléfono", informe.cliente.telefono || "—"],
    ]);
    this.card(L, "Inspección", [
      ["Inspector", informe.inspector.nombre || "—"],
      ["Agencia", informe.inspector.cargo || "—"],
      ["Fecha inspección", informe.fechaInspeccion || "—"],
    ]);

    this.indice(L);

    L.y -= 6;
    L.page.drawLine({ start: { x: MARGIN, y: L.y }, end: { x: A4.w - MARGIN, y: L.y }, thickness: 0.6, color: RULE });
    L.y -= 10;
    L.paragraph(LEGAL, 7.5, L.reg, FAINT, 3);
  }

  /** Tarjeta con filas label/valor (una fila por par; valor truncado al ancho). */
  private card(L: Layout, title: string, rows: Array<[string, string]>): void {
    const pad = 12;
    const rowH = 26;
    const h = 26 + rows.length * rowH + pad;
    L.ensure(h + 12);
    const top = L.y;
    L.page.drawRectangle({
      x: MARGIN,
      y: top - h,
      width: CONTENT_W,
      height: h,
      borderColor: CARD_BORDER,
      borderWidth: 1,
      color: rgb(1, 1, 1),
    });
    L.page.drawRectangle({ x: MARGIN, y: top - 22, width: 3, height: 10, color: BRAND });
    L.text(title.toUpperCase(), MARGIN + pad, top - 20, 10, L.bold, INK);
    let ry = top - 34;
    for (const [label, value] of rows) {
      L.text(label.toUpperCase(), MARGIN + pad, ry, 7.5, L.bold, MUTED);
      const maxW = CONTENT_W - 2 * pad;
      L.text(this.fit(value, L.reg, 11, maxW), MARGIN + pad, ry - 12, 11, L.reg, INK);
      ry -= rowH;
    }
    L.y = top - h - 12;
  }

  private indice(L: Layout): void {
    L.ensure(30);
    L.page.drawRectangle({ x: MARGIN, y: L.y - 18, width: CONTENT_W, height: 18, color: BRAND });
    L.text("ÍNDICE", MARGIN + 10, L.y - 14, 11, L.bold, rgb(0.1, 0.1, 0.1));
    L.y -= 30;
    // Una columna (fiel al contenido; el portal usa 2 col, acá priorizamos legibilidad + paginación).
    INDICE_PORTADA.forEach((it, i) => {
      L.ensure(30);
      const n = `${i + 1}`;
      L.page.drawCircle({ x: MARGIN + 8, y: L.y - 6, size: 8, color: BRAND });
      L.text(n, MARGIN + 8 - L.bold.widthOfTextAtSize(n, 8) / 2, L.y - 9, 8, L.bold, rgb(0.1, 0.1, 0.1));
      L.text(winAnsiSafe(it.titulo), MARGIN + 24, L.y - 9, 10.5, L.bold, INK);
      L.y -= 15;
      L.paragraph(it.descripcion, 8, L.reg, MUTED, 2.5, MARGIN + 24, CONTENT_W - 24);
      L.y -= 5;
    });
  }

  // ── Bloques de resumen / recomendaciones / puntaje ──
  private summaryBlock(L: Layout, title: string, body: string): void {
    this.sectionTitle(L, title);
    const lines = wrapText(body, L.reg, 11, CONTENT_W - 24);
    const h = 16 + lines.length * 15;
    L.ensure(h);
    const top = L.y;
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: CONTENT_W, height: h, color: rgb(0.976, 0.976, 0.976) });
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: 3, height: h, color: rgb(0.82, 0.83, 0.85) });
    let ly = top - 14;
    for (const line of lines) {
      L.text(line, MARGIN + 14, ly, 11, L.reg, INK);
      ly -= 15;
    }
    L.y = top - h - 14;
  }

  private score(L: Layout, score: number, comentario: string): void {
    this.sectionTitle(L, "Puntaje Técnico");
    const lines = comentario ? wrapText(comentario, L.reg, 11, CONTENT_W - 24) : [];
    const h = 40 + lines.length * 15;
    L.ensure(h);
    const top = L.y;
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: CONTENT_W, height: h, color: rgb(1, 0.992, 0.949) });
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: 3, height: h, color: BRAND });
    L.text(`${score}`, MARGIN + 14, top - 30, 26, L.bold, INK);
    L.text("/10", MARGIN + 14 + L.bold.widthOfTextAtSize(`${score}`, 26) + 3, top - 30, 13, L.bold, MUTED);
    let ly = top - 44;
    for (const line of lines) {
      L.text(line, MARGIN + 14, ly, 11, L.reg, INK);
      ly -= 15;
    }
    L.y = top - h - 14;
  }

  // ── Secciones + tarjetas de componente ──
  private sectionTitle(L: Layout, titulo: string): void {
    L.ensure(34);
    L.y -= 14;
    L.text(winAnsiSafe(titulo), MARGIN, L.y - 14, 15, L.bold, rgb(0.1, 0.1, 0.1));
    L.y -= 18;
    L.page.drawLine({ start: { x: MARGIN, y: L.y }, end: { x: A4.w - MARGIN, y: L.y }, thickness: 1.5, color: rgb(0.1, 0.1, 0.1) });
    L.y -= 12;
  }

  private async componentCard(L: Layout, d: ReportDetalle): Promise<void> {
    const innerW = CONTENT_W - 20;
    // Medir el alto para no cortar la tarjeta entre páginas (break-inside: avoid).
    // Cap por bloque: acota el alto máximo de la tarjeta MUY por debajo de una página (evita que
    // una tarjeta con texto libre gigante —sin tope upstream— se derrame sobre el pie / fuera de hoja).
    const titleLines = capLines(wrapText(d.tituloJerarquico, L.bold, 11, innerW - 70), 4);
    const descLines = d.descripcion ? capLines(wrapText(d.descripcion, L.reg, 10, innerW), 14) : [];
    const notaLines = d.nota ? capLines(wrapText(`Nota del inspector: ${d.nota}`, L.reg, 9.5, innerW), 4) : [];
    const diagLines = d.aiSummary ? capLines(wrapText(d.aiSummary, L.reg, 10, innerW), 14) : [];
    const photos = d.imagenes.slice(0, 6);
    const images = await this.loadImages(L, photos);
    const photoRows = images.length ? Math.ceil(images.length / 3) : 0;
    const hasMedia = d.audioData.length > 0 || d.videoData.length > 0;

    const h =
      10 + Math.max(16, titleLines.length * 14) +
      descLines.length * 13 +
      (notaLines.length ? 6 + notaLines.length * 12 : 0) +
      (diagLines.length ? 4 + diagLines.length * 13 : 0) +
      photoRows * 66 +
      (hasMedia ? 16 : 0) +
      12;

    L.ensure(h + 8);
    const top = L.y;
    const color = ESTADO_COLOR[d.estado];
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: CONTENT_W, height: h, borderColor: CARD_BORDER, borderWidth: 0.8, color: rgb(1, 1, 1) });
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: 3.5, height: h, color });

    let cy = top - 16;
    const x = MARGIN + 12;
    // Título + chip de estado.
    for (const line of titleLines) {
      L.text(line, x, cy, 11, L.bold, INK);
      cy -= 14;
    }
    const chip = ESTADO_LABEL[d.estado].toUpperCase();
    L.text(chip, A4.w - MARGIN - 12 - L.bold.widthOfTextAtSize(chip, 8), top - 15, 8, L.bold, color);

    for (const line of descLines) {
      L.text(line, x, cy, 10, L.reg, rgb(0.3, 0.3, 0.32));
      cy -= 13;
    }
    if (notaLines.length) {
      cy -= 6;
      for (const line of notaLines) {
        L.text(line, x, cy, 9.5, L.reg, rgb(0.42, 0.45, 0.5));
        cy -= 12;
      }
    }
    if (diagLines.length) {
      cy -= 4;
      for (const line of diagLines) {
        L.text(line, x, cy, 10, L.reg, INK);
        cy -= 13;
      }
    }
    // Fotos (grilla de 3 por fila) o placeholder.
    if (images.length) {
      cy -= 4;
      const gap = 6;
      const cellW = (innerW - 2 * gap) / 3;
      images.forEach((img, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const px = x + col * (cellW + gap);
        const py = cy - row * 66 - 60;
        const { width, height } = img.size();
        const s = Math.min(cellW / width, 58 / height);
        L.page.drawImage(img, { x: px, y: py, width: width * s, height: height * s });
      });
      cy -= photoRows * 66;
    } else if (photos.length) {
      L.text(`${photos.length} foto(s) — no embebidas (WorkDrive pendiente)`, x, cy - 4, 8.5, L.reg, MUTED);
      cy -= 14;
    }
    if (hasMedia) {
      const parts: string[] = [];
      if (d.audioData.length) parts.push(`${d.audioData.length} audio(s)`);
      if (d.videoData.length) parts.push(`${d.videoData.length} video(s)`);
      L.text(`${parts.join(" · ")} — disponible(s) en la versión digital`, x, cy - 4, 8.5, L.reg, MUTED);
    }
    L.y = top - h - 8;
  }

  /** Intenta traer+embeber las fotos; degrada a [] si no hay fetcher o falla (nunca rompe). */
  private async loadImages(L: Layout, urls: string[]): Promise<PDFImage[]> {
    const fetchImage = this.opts.fetchImage;
    if (!fetchImage) return [];
    const doc = L.doc;
    const out: PDFImage[] = [];
    for (const url of urls) {
      try {
        const bytes = await fetchImage(url);
        if (!bytes || bytes.length < 4) continue;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        out.push(img);
      } catch {
        // imagen ilegible/insegura → se omite, el informe igual se genera
      }
    }
    return out;
  }

  private footer(L: Layout, reportCode: string, generadoEn: string): void {
    const y = BOTTOM - 18;
    L.page.drawLine({ start: { x: MARGIN, y: y + 16 }, end: { x: A4.w - MARGIN, y: y + 16 }, thickness: 0.6, color: RULE });
    L.text(winAnsiSafe(reportCode || ""), MARGIN, y + 4, 8, L.reg, MUTED);
    const right = winAnsiSafe(generadoEn || "");
    L.text(right, A4.w - MARGIN - L.reg.widthOfTextAtSize(right, 8), y + 4, 8, L.reg, MUTED);
    L.text(
      "Documento informativo. Análisis asistidos por IA y validados por inspectores certificados.",
      MARGIN,
      y - 6,
      7,
      L.reg,
      FAINT,
    );
  }

  /** Trunca con "..." para no desbordar `maxWidth`. */
  private fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
    let t = winAnsiSafe(text);
    if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) t = t.slice(0, -1);
    return `${t}...`;
  }
}
