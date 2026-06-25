/**
 * Schemas de validación (Zod).
 *
 * La validación de FORMA vive acá. `.strict()` en la query de informes hace que un
 * parámetro fuera de la allowlist sea un error → la ruta lo traduce a 422 UNPROCESSABLE
 * (refuerza la tenancy: el consumidor no puede colar un filtro de Cuenta).
 */
import { z } from "zod";

export const countrySchema = z.enum(["UY", "AR", "US"]);
export const estadoInformeSchema = z.enum(["en_progreso", "completado", "cerrado"]);

// ── POST /v1/opportunity-contact ─────────────────────────────────────────────

export const contactInputSchema = z.object({
  documento: z.string().min(1, "documento (CI/RUT) requerido para deduplicar el Contacto"),
  nombre: z.string().min(1),
  email: z.string().email().optional(),
  telefono: z.string().optional(),
  pais: countrySchema.optional(),
});

export const opportunityInputSchema = z.object({
  nombre: z.string().min(1),
  meta: z.record(z.unknown()).optional(),
});

export const opportunityContactSchema = z
  .object({
    contact: contactInputSchema,
    opportunity: opportunityInputSchema,
  })
  .strict();

export type OpportunityContactBody = z.infer<typeof opportunityContactSchema>;

// ── GET /v1/informes ─────────────────────────────────────────────────────────

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

/** Filtros CONTROLADOS. `.strict()` → cualquier param desconocido falla (→ 422). */
export const listInformesQuerySchema = z
  .object({
    estado: estadoInformeSchema.optional(),
    desde: z.string().optional(),
    hasta: z.string().optional(),
    matricula: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(LIMIT_MAX).optional().default(LIMIT_DEFAULT),
  })
  .strict();

export type ListInformesQueryInput = z.infer<typeof listInformesQuerySchema>;

// ── POST /v1/internal/deal-estado (CRM → Catalyst, integración OUTBOUND con ML) ──

export const dealEstadoSchema = z
  .object({
    /** Nº de solicitud AutoCheck = External ID de la Oportunidad. */
    nroSolicitud: z.coerce.number().int().positive(),
    /** Valor del Stage del Deal en CRM (se mapea a Estado de ML). */
    stage: z.string().min(1),
    linkResultado: z.string().url().optional(),
    observaciones: z.string().max(500).optional(),
  })
  .strict();

export type DealEstadoInput = z.infer<typeof dealEstadoSchema>;
