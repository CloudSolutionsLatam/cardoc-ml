/**
 * Puerto `ImageOptimizer` + implementación con **sharp** (libvips): normaliza las fotos ANTES de
 * embeberlas en el PDF (ADR-0016).
 *
 * Por qué: el peso del PDF es ~100% fotos y depende de cómo se capturaron. Las tomadas con la cámara
 * nativa del teléfono llegan a 12 MP (4000×3000, ~2.8 MB c/u) → un informe de 122 fotos pesa 336 MB
 * y el gateway de Catalyst no lo entrega (corta >~120 MB). Reducidas a 1920 px por el lado mayor
 * quedan en ~0.4 MB c/u (−85%). Las ORIGINALES no se tocan: siguen en WorkDrive como evidencia; el
 * PDF lleva la versión de lectura.
 *
 * Qué hace con cada foto JPEG:
 *   - lado mayor > `maxPx`            → reduce a `maxPx` (proporción intacta) y re-codifica a `quality`.
 *   - orientación EXIF ≠ normal       → la endereza. pdf-lib IGNORA el EXIF, así que sin esto la
 *                                        foto sale acostada en el PDF (el portal sí la endereza).
 *   - ninguna de las dos              → bytes ORIGINALES, sin re-codificar (cero pérdida, cero CPU).
 * PNG y otros formatos pasan intactos. Cualquier error → bytes originales (nunca rompe la generación).
 *
 * sharp trae binarios nativos: se carga PEREZOSO y si no está disponible (p.ej. binario de otra
 * plataforma en el deploy) la factory devuelve `null` y el PDF se genera como antes, sin reducir.
 */
import type SharpNS from "sharp";

/** Resultado de optimizar una foto: los bytes a embeber y qué se le hizo. */
export interface OptimizedImage {
  bytes: Uint8Array;
  /** Se redujo la resolución (lado mayor > tope). */
  reduced: boolean;
  /** Se enderezó según la orientación EXIF. */
  oriented: boolean;
}

export interface ImageOptimizer {
  /** Devuelve los bytes a embeber. Nunca lanza: ante cualquier falla, los bytes originales. */
  optimize(bytes: Uint8Array): Promise<OptimizedImage>;
}

export interface SharpImageOptimizerOptions {
  /** Tope del lado mayor en px. `0` (o negativo) desactiva la optimización. */
  maxPx: number;
  /** Calidad JPEG de la re-codificación (1-100). */
  quality: number;
  /** Fotos re-codificándose a la vez (default `DEFAULT_PHOTO_CONCURRENCY`). Acota el pico de memoria. */
  maxConcurrent?: number;
}

/** 1920 px a 2 fotos por fila (~8.6 cm de ancho en A4) ≈ 550 DPI: casi 2× calidad de imprenta. */
export const DEFAULT_PHOTO_MAX_PX = 1920;
/** q90: medido sobre 2117957 → 336 MB de fotos quedan en ~50 MB. */
export const DEFAULT_PHOTO_QUALITY = 90;
/**
 * Re-codificar una foto de 12 MP ocupa ~65-75 MB mientras dura: libvips la decodifica COMPLETA
 * (solo decodifica a menor escala si el destino es <= ~1000 px). Sin tope corrían hasta 4 a la vez
 * (pool de libuv) → +245 MB → en Catalyst (512 MB) el proceso moría sin log y el gateway devolvía
 * `200` vacío (dev 2026-10-15). 2 = las CPUs que da Catalyst: más paralelismo no acelera, solo gasta.
 */
export const DEFAULT_PHOTO_CONCURRENCY = 2;

/**
 * Semáforo mínimo: como mucho `max` tareas a la vez, el resto espera en orden. Al terminar, el lugar
 * se TRANSFIERE al siguiente en cola (no se libera y re-toma), así nunca se cuela una tarea de más.
 */
export function limitConcurrency(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

type SharpFn = typeof SharpNS;
let sharpModule: SharpFn | null | undefined;

/**
 * Carga sharp una sola vez por proceso. `cache(false)`: en serverless la caché de libvips solo
 * retiene memoria (cada foto se procesa una vez). `concurrency(1)`: 1 hilo de libvips por foto; el
 * paralelismo lo dan las fotos simultáneas (pool de libuv) — evita que libvips abra un hilo por
 * cada CPU del HOST (que en Catalyst no son todas nuestras) y dispare la memoria (tope 512 MB).
 */
function loadSharp(): SharpFn | null {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // require PEREZOSO (no `import`): si el binario nativo no carga, la función igual arranca.
    const mod = require("sharp") as SharpFn;
    mod.cache(false);
    mod.concurrency(1);
    sharpModule = mod;
  } catch (e) {
    const motivo = String((e as Error).message ?? e).split("\n")[0]; // sharp trae instrucciones multilínea
    console.warn(`[pdf] sharp no disponible (${motivo}) — las fotos se embeben sin reducir`);
    sharpModule = null;
  }
  return sharpModule;
}

const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

/**
 * Factory del optimizador con sharp. Devuelve `null` si está desactivado (`maxPx <= 0`) o si sharp
 * no carga en esta plataforma — en ambos casos el generador embebe las fotos tal cual (como antes).
 */
export function createSharpImageOptimizer(opts: SharpImageOptimizerOptions): ImageOptimizer | null {
  if (!(opts.maxPx > 0)) return null;
  const sharp = loadSharp();
  if (!sharp) return null;
  const { maxPx, quality } = opts;
  const limit = limitConcurrency(opts.maxConcurrent && opts.maxConcurrent > 0 ? opts.maxConcurrent : DEFAULT_PHOTO_CONCURRENCY);

  return {
    async optimize(bytes) {
      const original: OptimizedImage = { bytes, reduced: false, oriented: false };
      if (!isJpeg(bytes)) return original;
      try {
        // Solo el header (~15 ms): decide sin decodificar los píxeles.
        const meta = await sharp(bytes).metadata();
        const reduced = Math.max(meta.width ?? 0, meta.height ?? 0) > maxPx;
        const oriented = (meta.orientation ?? 1) > 1;
        if (!reduced && !oriented) return original;
        // La re-codificación es lo que pesa en memoria: pasa por el semáforo (el header no).
        const out = await limit(() =>
          sharp(bytes, { failOn: "none" })
            .autoOrient()
            .resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true })
            // Conserva el perfil ICC en vez de convertir a sRGB: −25% de CPU y mismos colores que hoy
            // (el PDF dibuja el JPEG como DeviceRGB e ignora el perfil embebido).
            .keepIccProfile()
            .jpeg({ quality })
            .toBuffer(),
        );
        return { bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), reduced, oriented };
      } catch {
        return original; // JPEG ilegible para libvips → se embebe el original (pdf-lib decide)
      }
    },
  };
}
