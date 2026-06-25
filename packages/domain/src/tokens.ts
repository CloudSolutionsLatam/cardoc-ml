/**
 * Hashing de tokens de API.
 *
 * Solo el HASH del token se persiste en `api_tokens`; el token plano nunca toca el
 * DataStore ni los logs. El middleware de auth hashea el Bearer entrante y resuelve
 * el consumidor + Cuenta + scopes por el hash. Rotación = insertar nuevo + revocar.
 *
 * Node.js puro: sin dependencias, sin Catalyst.
 */
import { createHash, randomBytes } from "node:crypto";

/** sha256 hex del token (trim defensivo de bordes). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/** Genera un token de API aleatorio (≥ 256 bits, base64url). Solo se muestra una vez. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}
