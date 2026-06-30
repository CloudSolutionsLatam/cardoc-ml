/**
 * Schemas de validación (Zod).
 *
 * `opportunityContactSchema` valida el payload PascalCase de ML/AutoCheck (`.strict()`
 * → un campo desconocido es error → 400) y lo transforma a la forma camelCase del
 * dominio (`OpportunityContactInput`). La query de informes usa `.strict()` para que
 * un parámetro fuera de la allowlist sea 422 (refuerza la tenancy).
 */
import { z } from "zod";
import type { OpportunityContactInput } from "./types";

export const countrySchema = z.enum(["UY", "AR", "US"]);
export const estadoInformeSchema = z.enum(["en_progreso", "completado", "cerrado"]);

// ── POST /v1/opportunity-contact (payload inbound de ML/AutoCheck) ────────────

const optStr = (max: number) => z.string().max(max).optional();

export const opportunityContactSchema = z
  .object({
    NroCedula: z.coerce.number().int().positive(),
    NroSolicitud: z.coerce.number().int().positive(),
    Nombres: z.string().min(1).max(100),
    Apellidos: z.string().min(1).max(100),
    CelularCliente: optStr(30),
    Tenant: optStr(100),
    Sucursal: optStr(100),
    DepartamentoSucursal: optStr(100),
    CiudadSucursal: optStr(100),
    DireccionSucursal: optStr(200),
    MarcaVehiculo: optStr(100),
    ModeloVehiculo: optStr(100),
    AnioVehiculo: z.coerce.number().int().optional(),
    MatriculaVehiculo: optStr(30),
  })
  .strict()
  .transform(
    (v): OpportunityContactInput => ({
      nroCedula: v.NroCedula,
      nroSolicitud: v.NroSolicitud,
      nombres: v.Nombres,
      apellidos: v.Apellidos,
      celularCliente: v.CelularCliente,
      tenant: v.Tenant,
      sucursal: v.Sucursal,
      departamentoSucursal: v.DepartamentoSucursal,
      ciudadSucursal: v.CiudadSucursal,
      direccionSucursal: v.DireccionSucursal,
      marcaVehiculo: v.MarcaVehiculo,
      modeloVehiculo: v.ModeloVehiculo,
      anioVehiculo: v.AnioVehiculo,
      matriculaVehiculo: v.MatriculaVehiculo,
    }),
  );

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
