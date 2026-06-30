/**
 * Tipos núcleo del dominio cardoc.
 *
 * Modelo agnóstico de plataforma y de proveedor: ni Catalyst ni Zoho CRM/Creator
 * aparecen acá. Es el lenguaje interno que el resto del sistema habla.
 */

/** Scopes de los tokens por integración (uno por capacidad). */
export type Scope = "opportunities:create" | "reports:read" | "reports:pdf";

export const ALL_SCOPES: readonly Scope[] = [
  "opportunities:create",
  "reports:read",
  "reports:pdf",
] as const;

/** Países de las jurisdicciones operadas (corp: UY/AR/Wyoming). */
export type Country = "UY" | "AR" | "US";

// ── POST /v1/opportunity-contact ─────────────────────────────────────────────

/**
 * Payload inbound que manda ML (MLCenter/AutoCheck) para generar la Oportunidad.
 * Forma normalizada (camelCase); `opportunityContactSchema` valida los nombres
 * PascalCase que ML envía y mapea a esta forma.
 *
 * - `nroCedula`: llave de **deduplicación** del Contacto (ML no manda email).
 * - `nroSolicitud`: Nº de solicitud AutoCheck (único) = **External ID** de la
 *   Oportunidad y **clave de idempotencia**.
 * - `tenant`: identificador de empresa que manda ML; **informativo** — la Cuenta
 *   es siempre la Cuenta "ML" resuelta del token, no este campo.
 */
export interface OpportunityContactInput {
  nroCedula: number;
  nroSolicitud: number;
  nombres: string;
  apellidos: string;
  celularCliente?: string;
  tenant?: string;
  sucursal?: string;
  departamentoSucursal?: string;
  ciudadSucursal?: string;
  direccionSucursal?: string;
  marcaVehiculo?: string;
  modeloVehiculo?: string;
  anioVehiculo?: number;
  matriculaVehiculo?: string;
}

/**
 * Estado fijo de la Oportunidad (Deal.Stage) al crearla. Se fija SIEMPRE
 * server-side; nunca se acepta del body del request.
 *
 * Valor de picklist confirmado por Nestor (2026-06-30), provisional ("por ahora").
 * Es la única fuente de verdad: cambiarlo acá lo propaga a toda la API.
 */
export const FIXED_OPPORTUNITY_STAGE = "Nueva Solicitud" as const;

// ── GET /v1/informes ─────────────────────────────────────────────────────────

export type EstadoInforme = "en_progreso" | "completado" | "cerrado";

/**
 * Informe de Revisión normalizado que devuelve el GET. PLACEHOLDER: los campos
 * reales se ajustan al form `Informes`/`Analisis` de Zoho Creator.
 */
export interface InformeRevision {
  id: string;
  estado: EstadoInforme;
  matricula?: string;
  vehiculo?: string;
  cliente?: string;
  fecha?: string;
  /** true si el PDF ya está disponible (Analisis.pdf_url lleno); informativo para el consumidor. */
  pdfDisponible: boolean;
}

/** Filtros CONTROLADOS (allowlist) de GET /v1/informes. Un param fuera de esta lista → 422. */
export interface ListInformesQuery {
  estado?: EstadoInforme;
  desde?: string;
  hasta?: string;
  matricula?: string;
  /** Cursor opaco de paginación (no expone offset ni IDs internos). */
  cursor?: string;
  limit: number;
}

/** Página de resultados con cursor opaco. */
export interface Page<T> {
  data: T[];
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
}
