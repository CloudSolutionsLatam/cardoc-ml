/**
 * Generación del `token` de sesión que la Custom API de Creator espera (mini-JWT propio de ML).
 *
 * La función Deluge del portal lo genera así (confirmado por Nestor):
 *   jwt = { "id": <client_id>, "iat": <now>, "exp": <now + 7 días> }   // tiempos en unix epoch **ms**
 *   token = zoho.encryption.aesEncode("<key>", jwt.toString())
 *
 * `zoho.encryption.aesEncode` (variante 256) = **AES-256-CBC / PKCS7**, clave = el string en UTF-8
 * **NUL-padded a 32 bytes** (o truncado), salida **Base64** de `IV(16 random) ‖ ciphertext` (IV
 * prepended). Verificado empíricamente contra los test vectors oficiales de Zoho y, punta a punta,
 * contra el endpoint real (`code:3000`). ⚠️ VERIFICADO que `unixEpoch` es **milisegundos** (un token
 * con `exp` en segundos se lee como expirado).
 *
 * La `key` (equivalente al `passkey` del Deluge) acuña tokens válidos → es un **secreto fuerte**:
 * vive SOLO en Environment Variables (`CREATOR_TOKEN_KEY`), nunca en el repo.
 */
import crypto from "node:crypto";

/** Deriva la clave AES: bytes UTF-8 del passkey, NUL-padded (o truncados) a `size` bytes. */
function deriveKey(passkey: string, size = 32): Buffer {
  const b = Buffer.from(passkey, "utf8");
  return b.length >= size ? b.subarray(0, size) : Buffer.concat([b, Buffer.alloc(size - b.length)]);
}

/** Reproduce `zoho.encryption.aesEncode(passkey, data)` (256): AES-256-CBC, IV random prepended, Base64. */
export function zohoAesEncode(passkey: string, data: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", deriveKey(passkey), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(data, "utf8")), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

/** Reproduce `zoho.encryption.aesDecode(passkey, token)` (IV prepended). Para tests/round-trip. */
export function zohoAesDecode(passkey: string, token: string): string {
  const raw = Buffer.from(token, "base64");
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", deriveKey(passkey), iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Días de vigencia del token, igual que el Deluge (`addDay(7)`). */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatorTokenOptions {
  /** Vida del token en ms (default 7 días). */
  ttlMs?: number;
  /** Reloj inyectable (tests). Devuelve epoch ms. */
  now?: () => number;
}

/**
 * Devuelve una función que **acuña** un `token` fresco cada vez (crypto local, sin red): arma
 * `{id, iat, exp}` (ms) y lo AES-encripta con la key. Se genera por request (barato); `exp` a 7 días.
 */
export function createCreatorTokenSigner(
  key: string,
  clientId: string,
  opts: CreatorTokenOptions = {},
): () => string {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const clock = opts.now ?? Date.now;
  return () => {
    const iat = clock();
    const payload = JSON.stringify({ id: clientId, iat, exp: iat + ttl });
    return zohoAesEncode(key, payload);
  };
}
