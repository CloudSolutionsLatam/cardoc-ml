/**
 * Errores tipados de los adapters. La función los traduce al sobre de error único
 * (código opaco) — NUNCA se filtra al consumidor la URL/ruta/fileId interno.
 */

/** Falla del sistema upstream (CRM / Creator / WorkDrive). Se traduce a 502 UPSTREAM_ERROR. */
export class UpstreamError extends Error {
  constructor(
    /** Etiqueta OPACA del upstream ("crm" | "creator" | "workdrive"). Nunca una URL interna. */
    public readonly upstream: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Mensaje legible de algo lanzado/rechazado, para logs. El SDK de Catalyst (`zcatalyst-sdk-node`)
 * rechaza sus llamadas HTTP no-2xx (refresh del token, Cache) con un OBJETO PLANO
 * `{statusCode, code, message}`, no un `Error` → `String(e)` daba "[object Object]".
 * Solo se leen esos 3 campos (nunca el objeto entero: podría traer la config de la request con secretos).
 */
export function describeThrown(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [
      o["statusCode"] != null ? `HTTP ${String(o["statusCode"])}` : "",
      o["code"] != null ? String(o["code"]) : "",
      o["message"] != null ? String(o["message"]) : "",
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" ").slice(0, 300) : "objeto sin statusCode/code/message";
  }
  return String(e);
}

/** Adapter no implementado (scaffolding stub). */
export class NotImplementedError extends Error {
  constructor(adapter: string, op: string) {
    super(`${adapter}.${op}() no implementado todavía (scaffolding stub).`);
    this.name = "NotImplementedError";
  }
}

/** El informe no existe (o no pertenece a la Cuenta del token). Se traduce a 404 NOT_FOUND. */
export class ReportNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`informe ${id} no encontrado`);
    this.name = "ReportNotFoundError";
  }
}

/** El informe existe pero su PDF no está disponible ni se pudo generar. → 404 PDF_NOT_AVAILABLE. */
export class PdfNotAvailableError extends Error {
  constructor(public readonly id: string) {
    super(`PDF del informe ${id} no disponible`);
    this.name = "PdfNotAvailableError";
  }
}
