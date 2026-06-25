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
 * Mapeo CRM `Deal.Stage` -> ML `Estado`. **PLACEHOLDER**: los valores exactos del picklist
 * `Stage` del CRM están pendientes de confirmar (ver docs/OPEN-QUESTIONS.md). Un Stage que
 * no mapea → no se notifica (skipped).
 */
export const STAGE_TO_ESTADO: Record<string, MlEstado> = {
  // "<Stage de coordinación en CRM>": "COORDINACIÓN",
  // "<Stage de finalizado en CRM>": "FINALIZADO",
};

export function mapStageToEstado(stage: string): MlEstado | null {
  return STAGE_TO_ESTADO[stage] ?? null;
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
    return { status: "error", message: "LinkResultado es obligatorio cuando el estado es FINALIZADO" };
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
