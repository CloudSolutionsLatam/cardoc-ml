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
