/**
 * Idempotencia del POST /v1/opportunity-contact (AC-08).
 *
 * DECISIÓN (Nestor 2026-06-25): la clave de idempotencia (Capa 1) es el HEADER
 * `X-Idempotency-Key` que manda el consumidor (NO el `NroSolicitud`). La unicidad física es
 * `UNIQUE(idempotency_key)` single-column en el DataStore (la UI de Catalyst no permite UNIQUE
 * compuesto; `account_id` se filtra en la query como defensa de tenancy).
 *
 * `payloadFingerprint` se persiste junto a la clave para detectar el caso
 * "misma clave, payload distinto" → 409 IDEMPOTENCY_CONFLICT (semántica Stripe).
 *
 * Node.js puro: sin dependencias, sin Catalyst.
 */
import { createHash } from "node:crypto";

/** Serialización canónica y estable (claves ordenadas) — mismo objeto ⇒ misma cadena. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** Fingerprint determinístico del payload, para detectar conflicto de idempotencia. */
export function payloadFingerprint(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}
