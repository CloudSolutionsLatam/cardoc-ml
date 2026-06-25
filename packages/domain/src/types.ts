/**
 * Tipos núcleo del dominio cardoc.
 *
 * Modelo agnóstico de plataforma y de proveedor: ni Catalyst ni Zoho CRM/Creator
 * aparecen acá. Es el lenguaje interno que el resto del sistema habla.
 *
 * NOTA: algunos campos de `InformeRevision` y del payload son PLACEHOLDER hasta
 * confirmar el mapeo exacto contra los forms `Informes`/`Analisis` de Zoho Creator
 * y los API names de los módulos CRM (open questions del blueprint).
 */

/** Scopes de los Bearer tokens por integración (uno por capacidad). */
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
 * Datos del Contacto. La deduplicación "crear o reutilizar" (AC-01) es por
 * `documento` (CI/RUT) — por eso es requerido.
 */
export interface ContactInput {
  /** Documento de identidad (CI/RUT). Llave de deduplicación. REQUERIDO. */
  documento: string;
  nombre: string;
  email?: string;
  telefono?: string;
  pais?: Country;
}

export interface OpportunityInput {
  /** Nombre/título de la Oportunidad. */
  nombre: string;
  /** Datos libres del vehículo/agendamiento, mapeados a campos del módulo CRM. */
  meta?: Record<string, unknown>;
}

export interface OpportunityContactInput {
  contact: ContactInput;
  opportunity: OpportunityInput;
}

/**
 * Estado fijo de la Oportunidad creada (AC-02). Se fija SIEMPRE server-side;
 * nunca se acepta del body del request.
 */
export const FIXED_OPPORTUNITY_STAGE = "Agendamiento Ready" as const;

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
