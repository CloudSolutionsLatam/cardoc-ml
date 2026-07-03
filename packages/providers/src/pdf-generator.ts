/**
 * Puerto `PdfGenerator` + implementación con **pdf-lib** (generación en Catalyst).
 *
 * Reconstrucción FIEL (no pixel-1:1) del informe del portal de clientes —
 * `docs/reference/pdf-backend/planning.md` §5.5 (plantilla + CSS, fuente de verdad visual) y su
 * Anexo A (logo). cardoc-ml es el **generador único** del PDF (reemplaza el `window.print()` del
 * portal). Motor: pdf-lib (ADR-0012), sin navegador.
 *
 * pdf-lib dibuja por coordenadas (no hay CSS/flexbox/paginación automática), así que acá viven
 * un cursor con paginación (`Layout`), wrapping de texto y tarjetas medidas. El CSS del portal
 * está a escala 794px = A4; acá los tamaños van directo en puntos (~px × 0.75).
 *
 * Las fotos son EVIDENCIA: se embeben en su calidad/resolución ORIGINAL (bytes sin recomprimir) y
 * se muestran a 2 POR FILA dentro de la tarjeta del componente, como el portal (§5.5). El tamaño
 * MOSTRADO es menor que el original, pero el PDF conserva el detalle (zoom). La salida sigue la
 * maqueta: título de sección con filete inferior, tarjeta redondeada con filete lateral de color
 * por estado (border-left) y grilla de fotos 2/fila encerrada en la tarjeta.
 *
 * Las fotos se embeben vía un `ImageFetcher` inyectable (lo provee el adapter Creator con auth de
 * WorkDrive); sin fetcher se anota el conteo como nota (no hay red por defecto).
 */
import type { EstadoComponente, InformeReport, ReportDetalle } from "@cardoc/domain";
import {
  PDFDocument,
  StandardFonts,
  LineCapStyle,
  rgb,
  type Color,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { ML_LOGO_PNG_BASE64 } from "./ml-logo";

/** Trae los bytes de una imagen (WorkDrive) o null si no se pudo. Lo inyecta el adapter Creator. */
export type ImageFetcher = (url: string) => Promise<Uint8Array | null>;

export interface PdfGeneratorOptions {
  /** Fetcher de imágenes (WorkDrive). Sin él, las fotos se anotan como nota (conteo). */
  fetchImage?: ImageFetcher;
  /** Timestamp "Generado:" (el cliente lo estampa). Inyectable para tests deterministas. */
  generatedAt?: string;
}

export interface PdfGenerator {
  generate(informe: InformeReport): Promise<Uint8Array>;
}

/** Una fila de la grilla de fotos (2 por fila): sus imágenes con tamaño mostrado y el alto de fila. */
interface PhotoRow {
  items: Array<{ img: PDFImage; w: number; h: number }>;
  h: number;
}

/**
 * Layout ya MEDIDO de una tarjeta de componente: todo lo que `drawComponentCard` necesita para
 * pintar sin recomputar. Se calcula una vez por componente (`computeComponentCard`). `textCardH` es
 * el alto del bloque de TEXTO encerrado (con padding) — lo usa el lookahead keep-with-next del
 * `sectionTitle` para no dejar el título huérfano; las FILAS de fotos paginan aparte dentro de la
 * misma tarjeta (que se dibuja por segmentos si es más alta que una hoja).
 */
interface ComponentLayout {
  d: ReportDetalle;
  titleLines: string[];
  descLines: string[];
  notaLines: string[];
  diagLines: string[];
  notes: string[];
  rows: PhotoRow[];
  textContentH: number;
  textCardH: number;
}

/** Bloque atómico de una tarjeta al paginar: el bloque de texto, o una fila de fotos (con su gap). */
type CardBlock = { h: number; lead: number; kind: "text" | "row"; row?: PhotoRow };

// ── Geometría (de planning.md §5.5: 794px = A4, padding lateral 48px) ───────────
const A4 = { w: 595.28, h: 841.89 } as const;
const MARGIN = 36; // 48px × 0.75 → margen/padding lateral del documento
const CONTENT_W = A4.w - 2 * MARGIN;
const BOTTOM = 48; // margen inferior
const SECTION_TITLE_H = 46; // alto que consume sectionTitle: 14 (gap) + 20 (texto) + 12 (filete)
// ── Tarjeta de componente (de §5.5: .pdf-component padding 14/16px, border-radius 6px, fotos 2/fila) ──
const CARD_PAD_X = 12; // 16px × 0.75 — padding lateral de la tarjeta
const CARD_PAD_Y = 12; // padding vertical de la tarjeta
const CARD_RADIUS = 4.5; // border-radius 6px × 0.75
const PHOTO_COL_GAP = 6; // gap 8px entre las 2 columnas de fotos
const PHOTO_ROW_GAP = 6; // gap 8px entre filas de fotos
const GAP_TEXT_PHOTOS = 8; // margin-top 10px del bloque de fotos respecto del texto
const MAX_PHOTO_H = 420; // tope de alto por foto (una foto vertical no puede superar la hoja)
const PHOTO_W = (CONTENT_W - 2 * CARD_PAD_X - PHOTO_COL_GAP) / 2; // ancho de cada foto: 2 por fila
const MAX_PHOTOS = 6; // tope de fotos por componente (portal: .slice(0,6))
const IMAGE_CONCURRENCY = 8; // descargas de fotos en paralelo (tope; la red es el cuello de botella)
// Las fotos son EVIDENCIA de inspección (motores, detalles finos): se embeben en su calidad/resolución
// ORIGINAL, sin recomprimir (bajar calidad arruinaría el detalle; las fuentes ya son ~1080px). El peso
// del PDF (302 fotos → ~126 MB) es inherente; la usabilidad se resuelve con caché/portal, no degradando.

// ── Paleta de marca Portal ML (hex verbatim del CSS de §5.5) ────────────────────
const INK = rgb(0.173, 0.173, 0.173); // #2c2c2c — texto base / valores
const SECTION_INK = rgb(0.102, 0.102, 0.102); // #1a1a1a — títulos de sección e índice
const LABEL = rgb(0.6, 0.6, 0.6); // #999 — labels de campo
const DATE = rgb(0.533, 0.533, 0.533); // #888 — fecha de portada
const DESC = rgb(0.267, 0.267, 0.267); // #444 — cuerpo de componente
const TOC_DESC = rgb(0.4, 0.4, 0.4); // #666 — descripciones del índice / año
const LEGAL_INK = rgb(0.604, 0.627, 0.651); // #9aa0a6 — descargo legal
const FOOTER_MAIN = rgb(0.667, 0.667, 0.667); // #aaa
const FOOTER_FAINT = rgb(0.733, 0.733, 0.733); // #bbb
const BRAND = rgb(0.961, 0.769, 0.0); // #F5C400 — amarillo de marca
const BORDER = rgb(0.898, 0.906, 0.922); // #e5e7eb — bordes de tarjeta
const FIELD_RULE = rgb(0.933, 0.941, 0.949); // #eef0f2 — filete entre campos
const WHITE = rgb(1, 1, 1);
const RECO_BORDER = rgb(0.965, 0.659, 0.447); // #F6A872
const RECO_BG = rgb(1, 0.98, 0.961); // #fffaf5
const SCORE_BG = rgb(1, 0.992, 0.949); // #fffdf2
const SUMMARY_BG = rgb(0.976, 0.976, 0.976); // #f9f9f9
const SUMMARY_BORDER = rgb(0.82, 0.835, 0.859); // #d1d5db

const ESTADO_COLOR: Record<EstadoComponente, Color> = {
  aprobado: rgb(0.086, 0.639, 0.29), // #16a34a
  observacion: rgb(0.851, 0.467, 0.024), // #d97706
  critico: rgb(0.863, 0.149, 0.149), // #dc2626
};

/** ÍNDICE FIJO de la portada (verbatim planning.md §5.5 — NO deriva de los datos, pedido de ML). */
const INDICE_PORTADA: Array<{ titulo: string; descripcion: string }> = [
  {
    titulo: "Resumen, Recomendaciones y Puntaje",
    descripcion:
      "En esta sección podrá visualizar los comentarios generales del técnico, junto con unas recomendaciones para seguir con el funcionamiento del vehículo y un puntaje general del estado del mismo.",
  },
  {
    titulo: "Chasis",
    descripcion:
      "El chasis es la estructura principal del vehículo. Evaluamos que no presente deformaciones, daños o reparaciones que puedan comprometer la seguridad de los ocupantes.",
  },
  {
    titulo: "Carrocería",
    descripcion:
      "Revisamos los paneles de carrocería y medimos el espesor de pintura para determinar si las piezas conservan su estado original de fábrica o si han sido reparadas y/o repintadas.",
  },
  {
    titulo: "Interior",
    descripcion:
      "Evaluamos el estado y funcionamiento de los componentes del interior del vehículo, verificando su nivel de conservación y operatividad.",
  },
  {
    titulo: "Mecánica",
    descripcion:
      "Evaluamos los componentes que conforman la mecánica del vehículo, verificando su estado y detectando posibles fallas o desgastes.",
  },
  {
    titulo: "Electrónica",
    descripcion:
      "Analizamos las alertas e indicadores presentes en el vehículo y realizamos un escaneo con equipos de diagnóstico para detectar posibles fallas electrónicas.",
  },
  {
    titulo: "Prueba Dinámica",
    descripcion:
      "Realizamos una prueba de conducción para evaluar el comportamiento real del vehículo y detectar posibles fallas o anomalías en funcionamiento que no pueden apreciarse con el vehículo detenido.",
  },
  {
    titulo: "PRO",
    descripcion:
      "En esta sección se agregan los componentes del PRO, que le dan un enfoque aún más ampliado y con más información al resto del informe.",
  },
];

/** Descargo legal de ML al pie de la portada (verbatim planning.md §5.5). */
const LEGAL =
  "El servicio se limita a la revisión, análisis técnico e informe sobre el estado del vehículo. El mismo no constituye una garantía. " +
  "ML se deslinda de toda responsabilidad ante cualquier tipo de anomalía o desperfecto no detectado, como también por vicios ocultos. " +
  "ML no será responsable ante ninguna acción u omisión de buena fe o con culpa simple, ni estará sujeto a ningún tipo de responsabilidad implícita, " +
  "obligándose únicamente a la realización del análisis técnico e informe contratado.";

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

/**
 * Path SVG (coords y-down, origen en la esquina superior-izquierda) de un rectángulo con esquinas
 * redondeadas de radio `r`. Reproduce el `border-radius` de las tarjetas del portal (§5.5), que
 * `drawRectangle` de pdf-lib no soporta. Se dibuja con `page.drawSvgPath` (que ancla en (x,y) y
 * escala y por -1, así que positivo-y baja en la página).
 */
export function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M ${rr} 0`, `L ${w - rr} 0`, `Q ${w} 0 ${w} ${rr}`,
    `L ${w} ${h - rr}`, `Q ${w} ${h} ${w - rr} ${h}`,
    `L ${rr} ${h}`, `Q 0 ${h} 0 ${h - rr}`,
    `L 0 ${rr}`, `Q 0 0 ${rr} 0`, "Z",
  ].join(" ");
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
  /** Dibuja texto centrado en `[x0, x0+width]` (una sola línea). */
  textCentered(t: string, x0: number, width: number, y: number, size: number, font: PDFFont, color: Color): void {
    const tw = font.widthOfTextAtSize(winAnsiSafe(t), size);
    this.text(t, x0 + (width - tw) / 2, y, size, font, color);
  }
  /** Dibuja un párrafo wrappeado desde el cursor; avanza `y`. */
  paragraph(t: string, size: number, font: PDFFont, color: Color, lineGap = 4, x = MARGIN, width = CONTENT_W): void {
    for (const line of wrapText(t, font, size, width)) {
      this.ensure(size + lineGap);
      this.text(line, x, this.y - size, size, font, color);
      this.y -= size + lineGap;
    }
  }
  /** Rectángulo con esquinas redondeadas (relleno y/o borde), anclado por su esquina superior-izquierda `(x, top)`. */
  roundedRect(
    x: number,
    top: number,
    w: number,
    h: number,
    r: number,
    opts: { color?: Color; borderColor?: Color; borderWidth?: number },
  ): void {
    this.page.drawSvgPath(roundedRectPath(w, h, r), { x, y: top, ...opts });
  }
}

export class PdfLibReportGenerator implements PdfGenerator {
  constructor(private readonly opts: PdfGeneratorOptions = {}) {}

  async generate(informe: InformeReport): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(winAnsiSafe(`Informe de Revisión ${informe.reportCode}`));
    doc.setProducer("cardoc");
    doc.setCreator("cardoc (AutoCheck)");
    const reg = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    // Logo de marca Portal ML (Anexo A). Si el embed falla, la portada cae a un wordmark de texto.
    let logo: PDFImage | undefined;
    try {
      logo = await doc.embedPng(ML_LOGO_PNG_BASE64);
    } catch {
      logo = undefined;
    }
    const L = new Layout(doc, reg, bold);
    const generadoEn = this.opts.generatedAt ?? "";

    this.cover(L, informe, generadoEn, logo);
    if (informe.resumenTranscripcion) this.summaryBlock(L, "Resumen del Técnico", informe.resumenTranscripcion);
    if (informe.recomendaciones) this.summaryBlock(L, "Recomendaciones del Inspector", informe.recomendaciones, "reco");
    if (informe.score != null) this.score(L, informe.score, informe.score_comentario);

    // Pre-descarga TODAS las fotos en PARALELO antes de renderizar (evita el fetch secuencial de a una).
    const images = await this.prefetchImages(doc, informe.detalles);
    for (const seccion of informe.secciones) {
      const detalles = informe.detalles.filter((d) => d.seccionId === seccion.id);
      if (!detalles.length) continue;
      // Medir TODO el bloque de texto de cada tarjeta una sola vez; el título arrastra a su primer
      // componente (keep-with-next) para no quedar huérfano al pie.
      const layouts = detalles.map((d) => this.computeComponentCard(L, d, images));
      this.sectionTitle(L, seccion.titulo, (layouts[0]?.textCardH ?? 0) + 8);
      for (const layout of layouts) this.drawComponentCard(L, layout);
    }

    this.footer(L, informe.reportCode, generadoEn);
    return doc.save();
  }

  // ── Portada ──
  private cover(L: Layout, informe: InformeReport, generadoEn: string, logo?: PDFImage): void {
    // Cabecera: logo a la IZQUIERDA (height 56px→42pt, width auto), código/fecha CENTRADOS (§5.5).
    const headerTop = L.y;
    const logoH = 42;
    if (logo) {
      const { width, height } = logo.size();
      const w = (logoH / height) * width;
      L.page.drawImage(logo, { x: MARGIN, y: headerTop - logoH, width: w, height: logoH });
    } else {
      L.text("Portal ML", MARGIN, headerTop - 20, 18, L.bold, INK);
    }
    const code = winAnsiSafe(informe.reportCode || "—");
    L.textCentered(code, MARGIN, CONTENT_W, headerTop - 16, 12, L.bold, INK);
    if (generadoEn) {
      L.textCentered(`Generado: ${generadoEn}`, MARGIN, CONTENT_W, headerTop - 30, 9, L.reg, DATE);
    }
    L.y = headerTop - logoH - 12;
    // Filete amarillo de marca bajo la cabecera (border-bottom 3px #F5C400).
    L.page.drawRectangle({ x: MARGIN, y: L.y, width: CONTENT_W, height: 2.5, color: BRAND });
    L.y -= 22;

    // Título del vehículo (26px/800) + año (18px/400, atenuado).
    const v = informe.vehiculo;
    const name = winAnsiSafe(`${v.marca} ${v.modelo}`.trim());
    L.text(name, MARGIN, L.y - 20, 20, L.bold, INK);
    if (v.año) {
      const nameW = L.bold.widthOfTextAtSize(name, 20);
      L.text(winAnsiSafe(String(v.año)), MARGIN + nameW + 7, L.y - 18, 13, L.reg, TOC_DESC);
    }
    L.y -= 36;

    this.coverCard(L, "Datos del Vehículo", [
      { label: "Matrícula", value: v.placa },
      { label: "Kilometraje", value: v.kilometraje },
      { label: "Motor", value: v.motor },
      { label: "Transmisión", value: v.transmision },
    ]);
    this.coverCard(L, "Cliente", [
      { label: "Nombre", value: informe.cliente.nombre, wide: true },
      { label: "Teléfono", value: informe.cliente.telefono },
    ]);
    this.coverCard(L, "Inspección", [
      { label: "Inspector", value: informe.inspector.nombre },
      { label: "Agencia", value: informe.inspector.cargo },
      { label: "Fecha inspección", value: informe.fechaInspeccion },
    ]);

    this.indice(L);

    // Descargo legal (border-top #eef0f2 + texto 9px #9aa0a6).
    L.y -= 6;
    L.ensure(14);
    L.page.drawLine({ start: { x: MARGIN, y: L.y }, end: { x: A4.w - MARGIN, y: L.y }, thickness: 0.8, color: FIELD_RULE });
    L.y -= 10;
    L.paragraph(LEGAL, 7, L.reg, LEGAL_INK, 3);
  }

  /** Ícono check-circle de marca (ring amarillo + tilde), reproducido del SVG de §5.5. */
  private checkIcon(L: Layout, cx: number, cy: number, size: number): void {
    L.page.drawCircle({ x: cx, y: cy, size: (size / 2) * 0.9, borderColor: BRAND, borderWidth: 1.1 });
    // Path del portal `M6 10.5 l2.5 2.5 L14 7.3` en viewBox 20 (y-down) → mapeado a PDF (y-up).
    const s = size / 20;
    const pt = (sx: number, sy: number) => ({ x: cx + (sx - 10) * s, y: cy - (sy - 10) * s });
    const p1 = pt(6, 10.5);
    const p2 = pt(8.5, 13);
    const p3 = pt(14, 7.3);
    L.page.drawLine({ start: p1, end: p2, thickness: 1.3, color: BRAND, lineCap: LineCapStyle.Round });
    L.page.drawLine({ start: p2, end: p3, thickness: 1.3, color: BRAND, lineCap: LineCapStyle.Round });
  }

  /**
   * Tarjeta de datos de portada (Vehículo / Cliente / Inspección): head con check-circle + título
   * uppercase, y una FILA de campos en columnas separadas por filete vertical (como §5.5).
   */
  private coverCard(L: Layout, title: string, fields: Array<{ label: string; value: string; wide?: boolean }>): void {
    const padX = 12;
    const padTop = 11;
    const padBot = 12;
    const headH = 13; // línea del head (ícono + título)
    const gapHeadFields = 9;
    const labelSize = 7.5;
    const valueSize = 10.5;
    const fieldsH = labelSize + 3 + valueSize + 2; // label + gap + valor
    const h = padTop + headH + gapHeadFields + fieldsH + padBot;
    L.ensure(h + 10);
    const top = L.y;

    L.roundedRect(MARGIN, top, CONTENT_W, h, 6, { color: WHITE, borderColor: BORDER, borderWidth: 1 });

    // Head: ícono check + título (12px/800 uppercase).
    const iconSize = 12;
    this.checkIcon(L, MARGIN + padX + iconSize / 2, top - padTop - iconSize / 2, iconSize);
    L.text(title.toUpperCase(), MARGIN + padX + iconSize + 7, top - padTop - iconSize + 2, 9, L.bold, INK);

    // Fila de campos: ancho por peso flex (wide = 2, normal = 1), filete a la izquierda salvo el primero.
    const rowTop = top - padTop - headH - gapHeadFields;
    const innerW = CONTENT_W - 2 * padX;
    const totalWeight = fields.reduce((s, f) => s + (f.wide ? 2 : 1), 0);
    let fx = MARGIN + padX;
    fields.forEach((f, i) => {
      const w = innerW * ((f.wide ? 2 : 1) / totalWeight);
      if (i > 0) {
        L.page.drawLine({ start: { x: fx, y: rowTop }, end: { x: fx, y: rowTop - fieldsH }, thickness: 0.8, color: FIELD_RULE });
      }
      const cellPad = i > 0 ? 12 : 0;
      const tx = fx + cellPad;
      L.text(f.label.toUpperCase(), tx, rowTop - labelSize, labelSize, L.reg, LABEL);
      const value = f.value || "—";
      L.text(this.fit(value, L.bold, valueSize, w - cellPad - 4), tx, rowTop - labelSize - 3 - valueSize, valueSize, L.bold, INK);
      fx += w;
    });

    L.y = top - h - 10;
  }

  /** ÍNDICE fijo, a 2 COLUMNAS con orden vertical (mitad izquierda / mitad derecha), como §5.5. */
  private indice(L: Layout): void {
    const barH = 24; // padding 8+8px + texto 15px ≈ 25px → pt (barra robusta del portal)
    const gap = 21; // 28px × 0.75
    const colW = (CONTENT_W - gap) / 2;
    const numBox = 24; // círculo 22px + gap 10px → pt (separación circulito→texto)
    const textW = colW - numBox;
    const titleSize = 10;
    const descSize = 8;
    const titleLh = 12;
    const descLh = 10.5;
    const itemGap = 9; // .pdf-toc__col gap: 12px → pt

    const items = INDICE_PORTADA.map((it, i) => ({ ...it, n: i + 1 }));
    const mid = Math.ceil(items.length / 2);
    const cols = [items.slice(0, mid), items.slice(mid)];

    // Alto de un item (título wrappeado + descripción wrappeada + gap).
    const itemHeight = (it: { titulo: string; descripcion: string }): number => {
      const tl = wrapText(it.titulo, L.bold, titleSize, textW).length;
      const dl = wrapText(it.descripcion, L.reg, descSize, textW).length;
      return tl * titleLh + 2 + dl * descLh + itemGap;
    };
    const colHeights = cols.map((c) => c.reduce((sum, it) => sum + itemHeight(it), 0));
    const bodyH = Math.max(...colHeights);

    // Reservar el bloque completo para no cortar una columna a mitad (el índice es fijo y corto).
    L.ensure(barH + 14 + bodyH);

    // Barra amarilla "ÍNDICE" (border-radius 4px→3pt, texto centrado en vertical).
    const barTop = L.y;
    L.roundedRect(MARGIN, barTop, CONTENT_W, barH, 3, { color: BRAND });
    L.text("ÍNDICE", MARGIN + 12, barTop - barH + 8, 11, L.bold, SECTION_INK);
    const topY = barTop - barH - 11; // margin-bottom 14px → pt

    cols.forEach((col, ci) => {
      const colX = MARGIN + ci * (colW + gap);
      let cy = topY;
      for (const it of col) {
        // Circulito numerado (amarillo).
        const cr = 8;
        const numCx = colX + cr;
        const numCy = cy - cr;
        L.page.drawCircle({ x: numCx, y: numCy, size: cr, color: BRAND });
        const nStr = String(it.n);
        L.text(nStr, numCx - L.bold.widthOfTextAtSize(nStr, 9) / 2, numCy - 3, 9, L.bold, SECTION_INK);
        // Título (13px/700).
        const tx = colX + numBox;
        let ty = cy;
        for (const ln of wrapText(it.titulo, L.bold, titleSize, textW)) {
          L.text(ln, tx, ty - titleSize, titleSize, L.bold, SECTION_INK);
          ty -= titleLh;
        }
        // Descripción (10.5px #666).
        ty -= 2;
        for (const ln of wrapText(it.descripcion, L.reg, descSize, textW)) {
          L.text(ln, tx, ty - descSize, descSize, L.reg, TOC_DESC);
          ty -= descLh;
        }
        cy = ty - itemGap;
      }
    });

    L.y = topY - bodyH;
  }

  // ── Bloques de resumen / recomendaciones / puntaje ──
  private summaryBlock(L: Layout, title: string, body: string, variant: "default" | "reco" = "default"): void {
    const lines = wrapText(body, L.reg, 10.5, CONTENT_W - 28);
    const h = 18 + lines.length * 15;
    this.sectionTitle(L, title, h); // keep-with-next: el título no se separa de su bloque
    L.ensure(h);
    const top = L.y;
    const bg = variant === "reco" ? RECO_BG : SUMMARY_BG;
    const bar = variant === "reco" ? RECO_BORDER : SUMMARY_BORDER;
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: CONTENT_W, height: h, color: bg });
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: 3, height: h, color: bar });
    let ly = top - 15;
    for (const line of lines) {
      L.text(line, MARGIN + 14, ly, 10.5, L.reg, INK);
      ly -= 15;
    }
    L.y = top - h - 14;
  }

  private score(L: Layout, score: number, comentario: string): void {
    const lines = comentario ? wrapText(comentario, L.reg, 10.5, CONTENT_W - 28) : [];
    const h = 42 + lines.length * 15;
    this.sectionTitle(L, "Puntaje Técnico", h); // keep-with-next: el título no se separa del puntaje
    L.ensure(h);
    const top = L.y;
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: CONTENT_W, height: h, color: SCORE_BG });
    L.page.drawRectangle({ x: MARGIN, y: top - h, width: 3, height: h, color: BRAND });
    L.text(`${score}`, MARGIN + 14, top - 30, 22, L.bold, INK);
    L.text("/10", MARGIN + 14 + L.bold.widthOfTextAtSize(`${score}`, 22) + 3, top - 30, 12, L.bold, LABEL);
    let ly = top - 46;
    for (const line of lines) {
      L.text(line, MARGIN + 14, ly, 10.5, L.reg, INK);
      ly -= 15;
    }
    L.y = top - h - 14;
  }

  // ── Secciones + tarjetas de componente ──
  /**
   * Título de sección (14pt/800 + filete inferior 2px). `keepWithNext` = alto del bloque que va
   * inmediatamente debajo (p. ej. `layout.h + 8` de la primera tarjeta): si título y bloque no
   * entran JUNTOS en lo que resta de página, saltamos ANTES del título para no dejarlo huérfano al
   * pie (keep-with-next). Sin `keepWithNext` solo garantiza que el título entre.
   */
  private sectionTitle(L: Layout, titulo: string, keepWithNext = 0): void {
    if (L.y - (SECTION_TITLE_H + keepWithNext) < BOTTOM) L.newPage();
    L.y -= 14;
    L.text(winAnsiSafe(titulo), MARGIN, L.y - 14, 14, L.bold, SECTION_INK);
    L.y -= 20;
    // Border-bottom 2px #1a1a1a.
    L.page.drawLine({ start: { x: MARGIN, y: L.y }, end: { x: A4.w - MARGIN, y: L.y }, thickness: 2, color: SECTION_INK });
    L.y -= 12;
  }

  /**
   * MIDE una tarjeta de componente: wrappea/capa las líneas de texto, arma las `notes` (fotos no
   * disponibles / audio-video) y la grilla de fotos 2/fila (proporción natural). No dibuja. Devuelve
   * `textCardH` (alto del bloque de texto encerrado) para el lookahead keep-with-next.
   */
  private computeComponentCard(L: Layout, d: ReportDetalle, images: Map<string, PDFImage>): ComponentLayout {
    const innerW = CONTENT_W - 2 * CARD_PAD_X;
    const titleLines = capLines(wrapText(d.tituloJerarquico, L.bold, 11, innerW), 4);
    const descLines = d.descripcion ? capLines(wrapText(d.descripcion, L.reg, 10.5, innerW), 14) : [];
    const notaLines = d.nota ? capLines(wrapText(d.nota, L.reg, 10.5, innerW - 92), 4) : [];
    const diagLines = d.aiSummary ? capLines(wrapText(d.aiSummary, L.reg, 10.5, innerW), 14) : [];
    const photos = d.imagenes.slice(0, MAX_PHOTOS);
    const loaded = photos.map((u) => images.get(u)).filter((x): x is PDFImage => x !== undefined);
    const hasMedia = d.audioData.length > 0 || d.videoData.length > 0;

    const notes: string[] = [];
    if (loaded.length === 0 && photos.length) notes.push(`${photos.length} foto(s) no disponibles`);
    if (hasMedia) {
      const parts: string[] = [];
      if (d.audioData.length) parts.push(`${d.audioData.length} audio(s)`);
      if (d.videoData.length) parts.push(`${d.videoData.length} video(s)`);
      notes.push(`${parts.join(" - ")} — disponible(s) en la versión digital`);
    }

    // Alto del CONTENIDO de texto (sin padding de tarjeta): título + descripción + nota + diagnóstico + notas.
    let textContentH = titleLines.length * 15;
    textContentH += descLines.length * 14;
    if (notaLines.length) textContentH += 6 + notaLines.length * 13;
    if (diagLines.length) textContentH += 4 + diagLines.length * 14;
    if (notes.length) textContentH += 4 + 11;

    // Grilla de fotos 2/fila: cada foto a mitad de ancho, proporción natural (tope de alto por foto).
    const rows: PhotoRow[] = [];
    for (let i = 0; i < loaded.length; i += 2) {
      const items = loaded.slice(i, i + 2).map((img) => {
        const { width, height } = img.size();
        let w = PHOTO_W;
        let h = height * (PHOTO_W / width);
        if (h > MAX_PHOTO_H) {
          w *= MAX_PHOTO_H / h;
          h = MAX_PHOTO_H;
        }
        return { img, w, h };
      });
      rows.push({ items, h: Math.max(...items.map((it) => it.h)) });
    }

    return { d, titleLines, descLines, notaLines, diagLines, notes, rows, textContentH, textCardH: 2 * CARD_PAD_Y + textContentH };
  }

  /**
   * Dibuja una tarjeta ya medida: texto + grilla de fotos 2/fila, encerrados por un borde redondeado
   * con filete lateral de color por estado. Si la tarjeta es más alta que la hoja, se pagina por
   * SEGMENTOS (el bloque de texto y cada fila de fotos son atómicos), y el borde se redondea solo en
   * el arranque (arriba) y el cierre (abajo) del recorrido, como haría el navegador con `break-inside`.
   */
  private drawComponentCard(L: Layout, layout: ComponentLayout): void {
    const color = ESTADO_COLOR[layout.d.estado];

    const blocks: CardBlock[] = [{ h: layout.textContentH, lead: 0, kind: "text" }];
    layout.rows.forEach((row, j) => {
      const lead = j === 0 ? GAP_TEXT_PHOTOS : PHOTO_ROW_GAP;
      blocks.push({ h: lead + row.h, lead, kind: "row", row });
    });

    // Si el bloque de texto no entra en lo que resta de página, saltar ANTES de abrir la tarjeta
    // (keep-with-next ya lo garantiza tras un título de sección; esto cubre cualquier otro caso).
    if (L.y - (2 * CARD_PAD_Y + layout.textContentH) < BOTTOM) L.newPage();

    let bi = 0;
    let segTop = L.y;
    let segBottom = segTop;
    while (bi < blocks.length) {
      const contentTop = segTop - CARD_PAD_Y;
      let y = contentTop;
      const first = bi;
      // Llenar el segmento con los bloques que entren (siempre al menos uno).
      while (bi < blocks.length) {
        const b = blocks[bi] as CardBlock;
        const nextBottom = y - b.h;
        if (bi > first && nextBottom - CARD_PAD_Y < BOTTOM) break;
        y = nextBottom;
        bi += 1;
      }
      segBottom = y - CARD_PAD_Y;
      const segH = segTop - segBottom;
      const isFirst = first === 0;
      const isLast = bi === blocks.length;

      // Fondo + borde redondeado (según arranque/cierre) + filete lateral de estado.
      L.page.drawSvgPath(this.cardSegmentPath(CONTENT_W, segH, CARD_RADIUS, isFirst, isLast), {
        x: MARGIN,
        y: segTop,
        color: WHITE,
        borderColor: BORDER,
        borderWidth: 0.8,
      });
      const topInset = isFirst ? CARD_RADIUS : 0;
      const botInset = isLast ? CARD_RADIUS : 0;
      if (segH - topInset - botInset > 0) {
        L.page.drawRectangle({ x: MARGIN + 0.4, y: segBottom + botInset, width: 3, height: segH - topInset - botInset, color });
      }

      // Contenido del segmento.
      let dy = contentTop;
      for (let k = first; k < bi; k += 1) {
        const b = blocks[k] as CardBlock;
        if (b.kind === "text") this.drawCardText(L, dy, layout);
        else if (b.row) this.drawPhotoRow(L, dy - b.lead, b.row);
        dy -= b.h;
      }

      if (bi < blocks.length) {
        L.newPage();
        segTop = L.y;
      }
    }
    L.y = segBottom - 8;
  }

  /** Dibuja el bloque de texto de la tarjeta (título jerárquico + descripción + nota + diagnóstico + notas). */
  private drawCardText(L: Layout, contentTop: number, layout: ComponentLayout): void {
    const { titleLines, descLines, notaLines, diagLines, notes } = layout;
    const x = MARGIN + CARD_PAD_X;
    let cy = contentTop;
    for (const line of titleLines) {
      L.text(line, x, cy - 11, 11, L.bold, INK);
      cy -= 15;
    }
    for (const line of descLines) {
      L.text(line, x, cy - 10.5, 10.5, L.reg, DESC);
      cy -= 14;
    }
    if (notaLines.length) {
      cy -= 6;
      L.text("Nota del inspector:", x, cy - 10.5, 10.5, L.bold, DESC);
      const notaX = x + L.bold.widthOfTextAtSize("Nota del inspector: ", 10.5);
      // Primera línea corre a la derecha del label; el resto vuelve al margen del cuerpo.
      notaLines.forEach((line, i) => {
        L.text(line, i === 0 ? notaX : x, cy - 10.5, 10.5, L.reg, DESC);
        cy -= 13;
      });
    }
    if (diagLines.length) {
      cy -= 4;
      for (const line of diagLines) {
        L.text(line, x, cy - 10.5, 10.5, L.reg, DESC);
        cy -= 14;
      }
    }
    if (notes.length) {
      cy -= 4;
      L.text(this.fit(notes.join("   |   "), L.reg, 8.5, CONTENT_W - 2 * CARD_PAD_X), x, cy - 8.5, 8.5, L.reg, LABEL);
    }
  }

  /** Dibuja una fila de fotos (hasta 2), alineadas al tope, cada una con su borde fino (§5.5). */
  private drawPhotoRow(L: Layout, rowTop: number, row: PhotoRow): void {
    let px = MARGIN + CARD_PAD_X;
    for (const it of row.items) {
      L.page.drawImage(it.img, { x: px, y: rowTop - it.h, width: it.w, height: it.h });
      L.page.drawRectangle({ x: px, y: rowTop - it.h, width: it.w, height: it.h, borderColor: BORDER, borderWidth: 0.8 });
      px += PHOTO_W + PHOTO_COL_GAP; // avanza por columna completa (aunque una foto se haya achicado)
    }
  }

  /**
   * Path (coords y-down, ancla superior-izquierda) del rectángulo de un SEGMENTO de tarjeta: redondea
   * solo las esquinas superiores si `roundTop` y las inferiores si `roundBottom`. Con ambos true
   * equivale a una tarjeta redondeada completa (caso de una sola página).
   */
  private cardSegmentPath(w: number, h: number, r: number, roundTop: boolean, roundBottom: boolean): string {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    const rt = roundTop ? rr : 0;
    const rb = roundBottom ? rr : 0;
    return [
      `M ${rt} 0`,
      `L ${w - rt} 0`,
      rt ? `Q ${w} 0 ${w} ${rt}` : `L ${w} 0`,
      `L ${w} ${h - rb}`,
      rb ? `Q ${w} ${h} ${w - rb} ${h}` : `L ${w} ${h}`,
      `L ${rb} ${h}`,
      rb ? `Q 0 ${h} 0 ${h - rb}` : `L 0 ${h}`,
      `L 0 ${rt}`,
      rt ? `Q 0 0 ${rt} 0` : `L 0 0`,
      "Z",
    ].join(" ");
  }

  /**
   * Pre-descarga TODAS las fotos del informe en PARALELO (tope `IMAGE_CONCURRENCY`) y las embebe,
   * devolviendo un mapa `url → PDFImage`. La red es el cuello de botella: bajarlas concurrentemente
   * (en vez de una por una) recorta la latencia de ~suma a ~suma/concurrencia. Nunca rompe: una
   * foto que falla se omite (el informe se genera igual). Sin `fetchImage` → vacío.
   */
  private async prefetchImages(doc: PDFDocument, detalles: ReportDetalle[]): Promise<Map<string, PDFImage>> {
    const map = new Map<string, PDFImage>();
    const fetchImage = this.opts.fetchImage;
    if (!fetchImage) return map;
    const urls = [...new Set(detalles.flatMap((d) => d.imagenes.slice(0, MAX_PHOTOS)))];
    if (!urls.length) return map;

    // 1) Descarga concurrente con tope: workers que consumen la lista de URLs (bytes ORIGINALES).
    const bytesByUrl = new Map<string, Uint8Array>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < urls.length) {
        const url = urls[next++] as string;
        try {
          const bytes = await fetchImage(url);
          if (bytes && bytes.length >= 4) bytesByUrl.set(url, bytes);
        } catch {
          // WorkDrive caído / imagen ilegible → se omite
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, urls.length) }, worker));

    // 2) Embed secuencial (CPU rápido; no muta el doc de pdf-lib en paralelo).
    for (const [url, bytes] of bytesByUrl) {
      try {
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        map.set(url, isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes));
      } catch {
        // imagen corrupta → se omite
      }
    }
    return map;
  }

  /** Pie: código/generado a los lados, aviso centrado, y descargo con filete punteado (§5.5). */
  private footer(L: Layout, reportCode: string, generadoEn: string): void {
    L.ensure(56);
    L.y -= 14;
    L.page.drawLine({ start: { x: MARGIN, y: L.y }, end: { x: A4.w - MARGIN, y: L.y }, thickness: 0.8, color: BORDER });
    L.y -= 14;
    // Fila: código (izq) · generado (der). El aviso va centrado en su propia línea (evita solape).
    L.text(winAnsiSafe(reportCode || ""), MARGIN, L.y, 8, L.reg, FOOTER_MAIN);
    const gen = winAnsiSafe(generadoEn || "");
    L.text(gen, A4.w - MARGIN - L.reg.widthOfTextAtSize(gen, 8), L.y, 8, L.reg, FOOTER_MAIN);
    L.y -= 11;
    L.textCentered("Documento informativo. No sustituye revisión técnica presencial.", MARGIN, CONTENT_W, L.y, 8, L.reg, FOOTER_MAIN);
    L.y -= 12;
    L.page.drawLine({
      start: { x: MARGIN, y: L.y },
      end: { x: A4.w - MARGIN, y: L.y },
      thickness: 0.6,
      color: BORDER,
      dashArray: [2, 2],
    });
    L.y -= 10;
    L.textCentered(
      "Los análisis de componentes de este informe son asistidos por inteligencia artificial y validados por inspectores certificados.",
      MARGIN,
      CONTENT_W,
      L.y,
      7.5,
      L.reg,
      FOOTER_FAINT,
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
