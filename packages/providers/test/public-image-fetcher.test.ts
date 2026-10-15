/**
 * Tests del fetcher de fotos públicas con vista previa de WorkDrive (ADR-0016): las fotos pesadas
 * se piden reducidas (sin bajar el original), con vuelta al original si la vista previa falla.
 */
import { describe, expect, it } from "vitest";
import { createPublicImageFetcher, DEFAULT_WD_PREVIEW_ABOVE_BYTES, toWorkDrivePreviewUrl } from "../src/creator-client";

const WD = "https://files-accl.zohoexternal.com/public/workdrive-external/download/abc123XYZ";
const PREVIEW = "https://previewengine-accl.zohoexternal.com/image/WD/abc123XYZ?width=1920&height=1920";
const JPEG_SMALL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const JPEG_PREVIEW = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

/** Respuesta con cuerpo en stream (para verificar que el original pesado se CANCELA sin bajarlo). */
function streamResponse(bytes: Uint8Array, declaredLength: number, status = 200): { res: Response; canceled: () => boolean } {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
    cancel() {
      canceled = true;
    },
  });
  return { res: new Response(body, { status, headers: { "content-length": String(declaredLength) } }), canceled: () => canceled };
}

/** fetch falso: responde según la URL y registra las llamadas. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`URL inesperada: ${url}`);
    return route();
  }) as typeof fetch;
  return { fn, calls };
}

describe("toWorkDrivePreviewUrl", () => {
  it("link público de descarga de WorkDrive → URL de vista previa con el mismo id", () => {
    expect(toWorkDrivePreviewUrl(WD)).toBe(PREVIEW);
  });
  it("cualquier otra URL → null (no se inventa una vista previa)", () => {
    expect(toWorkDrivePreviewUrl("https://example.com/foto.jpg")).toBeNull();
    expect(toWorkDrivePreviewUrl("https://files-accl.zohoexternal.com/otra/ruta/abc")).toBeNull();
    expect(toWorkDrivePreviewUrl("no es una url")).toBeNull();
  });
});

describe("createPublicImageFetcher — vista previa de WorkDrive para fotos pesadas", () => {
  it("foto liviana → original tal cual, sin pedir vista previa", async () => {
    const { fn, calls } = fakeFetch({ [WD]: () => streamResponse(JPEG_SMALL, 400_000).res });
    const bytes = await createPublicImageFetcher(fn)(WD);
    expect(bytes).toEqual(JPEG_SMALL);
    expect(calls).toEqual([WD]);
  });

  it("foto pesada → cancela el original (no lo baja) y devuelve la vista previa", async () => {
    const original = streamResponse(new Uint8Array(10), DEFAULT_WD_PREVIEW_ABOVE_BYTES + 1);
    const { fn, calls } = fakeFetch({
      [WD]: () => original.res,
      [PREVIEW]: () => new Response(JPEG_PREVIEW, { status: 200 }),
    });
    const bytes = await createPublicImageFetcher(fn)(WD);
    expect(bytes).toEqual(JPEG_PREVIEW);
    expect(calls).toEqual([WD, PREVIEW]);
    expect(original.canceled()).toBe(true);
  });

  it("vista previa caída (401 / no-imagen) → vuelve al original", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch({
      [WD]: () => streamResponse(JPEG_SMALL, ++n === 1 ? 3_000_000 : JPEG_SMALL.length).res,
      [PREVIEW]: () => new Response("{}", { status: 401 }),
    });
    const bytes = await createPublicImageFetcher(fn)(WD);
    expect(bytes).toEqual(JPEG_SMALL);
    expect(calls).toEqual([WD, PREVIEW, WD]);
  });

  it("foto pesada que NO es de WorkDrive → original (no hay vista previa posible)", async () => {
    const other = "https://example.com/foto.jpg";
    const { fn, calls } = fakeFetch({ [other]: () => streamResponse(JPEG_SMALL, 5_000_000).res });
    expect(await createPublicImageFetcher(fn)(other)).toEqual(JPEG_SMALL);
    expect(calls).toEqual([other]);
  });

  it("previewAboveBytes=null (CARDOC_PDF_WD_PREVIEW=0) → siempre original", async () => {
    const { fn, calls } = fakeFetch({ [WD]: () => streamResponse(JPEG_SMALL, 5_000_000).res });
    expect(await createPublicImageFetcher(fn, { previewAboveBytes: null })(WD)).toEqual(JPEG_SMALL);
    expect(calls).toEqual([WD]);
  });

  it("original con error HTTP → null (sin foto, no rompe)", async () => {
    const { fn } = fakeFetch({ [WD]: () => new Response("x", { status: 404 }) });
    expect(await createPublicImageFetcher(fn)(WD)).toBeNull();
  });
});
