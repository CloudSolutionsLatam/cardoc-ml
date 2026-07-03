/**
 * Use-case: notificar a ML un cambio de estado de la solicitud AutoCheck (OUTBOUND).
 *
 * Lo dispara el CRM (workflow on Deal.Stage change) → función Catalyst → este use-case.
 * Mapea el `Stage` del Deal (CRM) al `Estado` de ML y llama al `MlCenterClient`.
 *
 * El `nroSolicitud` es el External ID de la Oportunidad (= Nº de solicitud AutoCheck).
 */
import type { MlCenterClient, MlEstado } from "@cardoc/providers";

/**
 * Mapeo CRM `Deal.Stage` (pipeline **B2B**) -> ML `Estado`. Valores confirmados por Nestor
 * (OQ-N6, 2026-07-01) contra `settings/pipeline`; detalle en `docs/reference/crm-data-model.md`.
 * Flujo B2B: `Nueva Solicitud` → `Agendado B2B` → `Completado` → `Cerrado` | `Cancelado`.
 *
 * Cuatro stages notifican a ML; solo `Cancelado` NO mapea → `skipped` (no es error):
 *  - `Nueva Solicitud`: estado inicial → `PENDIENTE` (pedido de Nestor 2026-07-03; ML acepta el
 *    estado inicial que le re-notificamos).
 *  - `Cancelado`: terminal; ML no tiene un estado de cancelación en el contrato AutoCheck.
 *
 * ✅ Confirmado (OQ-N6.a, Nestor 2026-07-03): el workflow del CRM dispara sobre `Deals.Stage`
 * (no sobre `Informes_Revision.Estado`), así que las claves de este mapa —los valores de Stage
 * del pipeline B2B— son las correctas.
 */
export const STAGE_TO_ESTADO: Record<string, MlEstado> = {
  "Nueva Solicitud": "PENDIENTE",
  "Agendado B2B": "COORDINACIÓN",
  Completado: "FINALIZADO",
  Cerrado: "FINALIZADO",
};

/** Resuelve el `Estado` de ML para un `Stage` del CRM, o `null` si el Stage no notifica.
 *  Se hace `trim()` defensivo: el string llega por webhook y un espacio colado no debe romper el match. */
export function mapStageToEstado(stage: string): MlEstado | null {
  return STAGE_TO_ESTADO[stage.trim()] ?? null;
}

export interface NotifyEstadoInput {
  /** External ID de la Oportunidad = Nº de solicitud AutoCheck. */
  nroSolicitud: number;
  /** Valor del `Stage` del Deal en CRM. */
  stage: string;
  /** URL del resultado/informe — requerido si el Stage mapea a FINALIZADO. */
  linkResultado?: string;
  observaciones?: string;
}

export type NotifyEstadoOutcome =
  | { status: "sent"; estado: MlEstado }
  | { status: "skipped"; reason: string }
  /** Falla de VALIDACIÓN del invariante de dominio (p.ej. FINALIZADO sin LinkResultado). ML
   *  NO se llama; el transporte debe traducirlo a 4xx, no a 502 (no es culpa del upstream). */
  | { status: "invalid"; message: string }
  /** Falla REAL del cliente ML (el POST a AutoCheck falló). El transporte lo traduce a 502. */
  | { status: "error"; message: string };

export async function notifyEstadoChange(
  input: NotifyEstadoInput,
  deps: { mlCenter: MlCenterClient },
): Promise<NotifyEstadoOutcome> {
  const estado = mapStageToEstado(input.stage);
  if (!estado) {
    return { status: "skipped", reason: `Stage '${input.stage}' no mapea a un Estado de ML` };
  }
  if (estado === "FINALIZADO" && !input.linkResultado) {
    // Validación de dominio, NO falla de ML: ML no se contacta. → 'invalid' (4xx), no 'error' (502).
    return { status: "invalid", message: "LinkResultado es obligatorio cuando el estado es FINALIZADO" };
  }
  try {
    await deps.mlCenter.updateEstado({
      nroSolicitud: input.nroSolicitud,
      estado,
      linkResultado: input.linkResultado,
      observaciones: input.observaciones,
    });
    return { status: "sent", estado };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
