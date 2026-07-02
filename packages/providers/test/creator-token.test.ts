/**
 * Tests del token de sesión de Creator. Lockean la byte-compatibilidad EXACTA con
 * `zoho.encryption.aesEncode`/`aesDecode` (256): incluye el test vector OFICIAL de la doc de Zoho,
 * el round-trip, y la estructura del mini-JWT que la Custom API espera.
 */
import { describe, expect, it } from "vitest";
import { createCreatorTokenSigner, zohoAesDecode, zohoAesEncode } from "../src/creator-token";

describe("zohoAes* — compatibilidad con zoho.encryption.aes*", () => {
  it("decodifica el test vector OFICIAL de Zoho (passkey → 'This is a secret')", () => {
    // Vector de la doc oficial (aesDecode('passkey', <b64>) === 'This is a secret').
    const vector = "yf/u6N0HjKWXFFHIEKzG23+CM+BoL4RBPNb4mc0G3hw5q6xPe9KSpUd62Z5sjjSE";
    expect(zohoAesDecode("passkey", vector)).toBe("This is a secret");
  });

  it("round-trip: decode(encode(x)) === x (IV random prepended)", () => {
    const data = '{"id":"cardoc","iat":1751000000000,"exp":1751604800000}';
    expect(zohoAesDecode("passkey", zohoAesEncode("passkey", data))).toBe(data);
  });

  it("dos encode del mismo dato difieren (IV aleatorio) pero decodifican igual", () => {
    const a = zohoAesEncode("k", "hola");
    const b = zohoAesEncode("k", "hola");
    expect(a).not.toBe(b);
    expect(zohoAesDecode("k", a)).toBe("hola");
    expect(zohoAesDecode("k", b)).toBe("hola");
  });

  it("clave >32 bytes se trunca; <32 se NUL-padea (round-trip estable en ambos)", () => {
    const long = "x".repeat(40);
    expect(zohoAesDecode(long, zohoAesEncode(long, "z"))).toBe("z");
  });
});

describe("createCreatorTokenSigner", () => {
  it("acuña un token que decodifica a {id, iat, exp} con exp = iat + 7 días (ms)", () => {
    const now = 1_751_000_000_000;
    const sign = createCreatorTokenSigner("passkey", "cardoc", { now: () => now });
    const payload = JSON.parse(zohoAesDecode("passkey", sign()));
    expect(payload.id).toBe("cardoc");
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + 7 * 24 * 60 * 60 * 1000);
  });

  it("exp queda en el futuro con el reloj real", () => {
    const payload = JSON.parse(zohoAesDecode("passkey", createCreatorTokenSigner("passkey", "cardoc")()));
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it("respeta ttl y clientId personalizados", () => {
    const now = 1_000_000;
    const sign = createCreatorTokenSigner("k", "otro-cliente", { now: () => now, ttlMs: 60_000 });
    const payload = JSON.parse(zohoAesDecode("k", sign()));
    expect(payload.id).toBe("otro-cliente");
    expect(payload.exp).toBe(now + 60_000);
  });
});
