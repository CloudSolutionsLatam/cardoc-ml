/**
 * Defensa-en-profundidad del contrato `portalType` — port de `portal-type-filter.js` del portal
 * (planning.md §5.3). El portal ML solo debe ver registros del flujo ML. La línea **primaria** es
 * el filtro server-side de la Custom API (`Analisis.portalType`); esto es la línea **secundaria**.
 *
 * R2: rechazar registros con `portalType` distinto. R3: tolerar registros SIN el campo
 * (back-compat con backend que aún no lo envía).
 */

/** Discriminador de portal de cardoc-ml. La API ML solo expone análisis marcados como flujo ML. */
export const PORTAL_TYPE = "ml" as const;

/**
 * ¿El registro de detalle debe rechazarse por no pertenecer al portal esperado?
 * - `portalType` presente y != esperado → rechazar (R2).
 * - `portalType` ausente → permitir (R3, back-compat).
 * - registro null/undefined → permitir (la capa superior maneja vacíos).
 */
export function shouldRejectDetailByPortalType(
  record: { portalType?: string } | null | undefined,
  expectedType: string,
): boolean {
  if (record === null || record === undefined) return false;
  if (record.portalType === undefined) return false;
  return record.portalType !== expectedType;
}
