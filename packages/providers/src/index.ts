/**
 * @cardoc/providers — puertos + adapters de los sistemas externos.
 *
 * Regla de arquitectura: NINGUNA llamada HTTP a Zoho CRM / Creator / WorkDrive fuera
 * de este package (verificado por el lint de imports — no `fetch` afuera).
 */
export * from "./errors";
export * from "./crm-client";
export * from "./reports-source";
export * from "./report-transform";
export * from "./portal-type";
export * from "./creator-client";
export * from "./creator-token";
export * from "./pdf-generator";
export * from "./mlcenter-client";
