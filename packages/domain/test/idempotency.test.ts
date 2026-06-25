import { describe, expect, it } from "vitest";
import { hashToken, payloadFingerprint } from "../src/index";

describe("payloadFingerprint", () => {
  it("es determinístico e insensible al orden de las claves", () => {
    const a = payloadFingerprint({ contact: { documento: "1.234.567-8", nombre: "Ana" }, opportunity: { nombre: "Rev" } });
    const b = payloadFingerprint({ opportunity: { nombre: "Rev" }, contact: { nombre: "Ana", documento: "1.234.567-8" } });
    expect(a).toBe(b);
  });

  it("cambia si el payload cambia (detección de conflicto de idempotencia)", () => {
    const a = payloadFingerprint({ contact: { documento: "1", nombre: "Ana" } });
    const b = payloadFingerprint({ contact: { documento: "2", nombre: "Ana" } });
    expect(a).not.toBe(b);
  });
});

describe("hashToken", () => {
  it("hashea de forma estable y no devuelve el token plano", () => {
    expect(hashToken("test-token")).toBe(hashToken(" test-token "));
    expect(hashToken("test-token")).not.toBe("test-token");
  });
});
