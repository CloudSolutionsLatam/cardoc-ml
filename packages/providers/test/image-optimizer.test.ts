/**
 * Tests del optimizador de fotos (sharp REAL, sin mocks): reduce las grandes, deja intactas las
 * chicas, endereza por EXIF, deja pasar PNG/JPEG ilegibles y se apaga con maxPx=0 (ADR-0016).
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createSharpImageOptimizer, DEFAULT_PHOTO_MAX_PX, DEFAULT_PHOTO_QUALITY, limitConcurrency } from "../src/image-optimizer";

/** JPEG con ruido (no comprime trivial, como una foto real) y orientación EXIF opcional. */
async function jpeg(width: number, height: number, orientation?: number): Promise<Uint8Array> {
  let img = sharp({ create: { width, height, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } } });
  if (orientation) img = img.withMetadata({ orientation });
  return new Uint8Array(await img.jpeg({ quality: 95 }).toBuffer());
}

const opt = createSharpImageOptimizer({ maxPx: DEFAULT_PHOTO_MAX_PX, quality: DEFAULT_PHOTO_QUALITY });

describe("createSharpImageOptimizer", () => {
  it("sharp disponible → devuelve optimizador; maxPx=0 lo APAGA (rollback sin redeploy)", () => {
    expect(opt).not.toBeNull();
    expect(createSharpImageOptimizer({ maxPx: 0, quality: 90 })).toBeNull();
  });

  it("foto de cámara grande → lado mayor a 1920 px, proporción intacta, mucho más liviana, sin EXIF", async () => {
    const big = await jpeg(3000, 2250);
    const r = await opt!.optimize(big);
    const meta = await sharp(r.bytes).metadata();
    expect(r.reduced).toBe(true);
    expect(r.oriented).toBe(false);
    expect([meta.width, meta.height]).toEqual([1920, 1440]);
    expect(r.bytes.length).toBeLessThan(big.length / 2);
    expect(meta.exif).toBeUndefined();
  });

  it("foto que ya entra (1080x1920) y sin orientación → bytes ORIGINALES, sin re-codificar", async () => {
    const small = await jpeg(1080, 1920);
    const r = await opt!.optimize(small);
    expect(r).toEqual({ bytes: small, reduced: false, oriented: false });
    expect(r.bytes).toBe(small);
  });

  it("orientación EXIF 6 (guardada horizontal, se ve vertical) → la endereza aunque no haga falta reducir", async () => {
    const lying = await jpeg(1200, 900, 6);
    const r = await opt!.optimize(lying);
    const meta = await sharp(r.bytes).metadata();
    expect(r).toMatchObject({ reduced: false, oriented: true });
    expect([meta.width, meta.height]).toEqual([900, 1200]); // pdf-lib ignora EXIF: los píxeles ya van derechos
    expect(meta.orientation ?? 1).toBe(1);
  });

  it("grande Y acostada → reduce y endereza en un solo paso", async () => {
    const r = await opt!.optimize(await jpeg(4000, 3000, 6));
    const meta = await sharp(r.bytes).metadata();
    expect(r).toMatchObject({ reduced: true, oriented: true });
    expect([meta.width, meta.height]).toEqual([1440, 1920]);
  });

  it("PNG → pasa intacto (pdf-lib lo embebe como siempre)", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#fff" } }).png().toBuffer());
    const r = await opt!.optimize(png);
    expect(r.bytes).toBe(png);
    expect(r.reduced).toBe(false);
  });

  it("JPEG ilegible (header válido, cuerpo basura) → bytes originales, nunca lanza", async () => {
    const junk = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const r = await opt!.optimize(junk);
    expect(r).toEqual({ bytes: junk, reduced: false, oriented: false });
  });
});

describe("limitConcurrency (acota la memoria de sharp)", () => {
  it("nunca corre más de `max` tareas a la vez y todas terminan con su resultado", async () => {
    const limit = limitConcurrency(2);
    let active = 0;
    let peak = 0;
    const task = (i: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
      active--;
      return i;
    };
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => limit(task(i))));
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBe(2);
  });

  it("una tarea que falla libera su lugar (la cola sigue)", async () => {
    const limit = limitConcurrency(1);
    await expect(limit(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limit(async () => "ok")).resolves.toBe("ok");
  });
});
