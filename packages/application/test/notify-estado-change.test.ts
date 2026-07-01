/**
 * Tests del use-case OUTBOUND a ML (notifyEstadoChange) y del mapeo Stage→Estado.
 *
 * Se prueba el mapeo B2B **real** (OQ-N6, confirmado 2026-07-01) — no un placeholder mutado:
 * si alguien rompe `STAGE_TO_ESTADO`, estos tests fallan. El invariante clave del negocio es
 * que FINALIZADO exige `LinkResultado` y que los stages no-notificables no llaman a ML.
 */
import { describe, expect, it } from "vitest";
import { MockMlCenterClient, type MlCenterClient, type UpdateEstadoInput } from "@cardoc/providers";
import { mapStageToEstado, notifyEstadoChange, STAGE_TO_ESTADO } from "../src/notify-estado-change";

/** Cliente ML que siempre falla — para el camino de error upstream. */
class FailingMlClient implements MlCenterClient {
  async updateEstado(_input: UpdateEstadoInput): Promise<{ nroSolicitud: number; estado: string }> {
    throw new Error("ML 503");
  }
}

// ── Mapeo Stage → Estado (pipeline B2B) ─────────────────────────────────────────

describe("mapStageToEstado — pipeline B2B (OQ-N6)", () => {
  it("Agendado B2B → COORDINACIÓN", () => {
    expect(mapStageToEstado("Agendado B2B")).toBe("COORDINACIÓN");
  });
  it("Completado → FINALIZADO", () => {
    expect(mapStageToEstado("Completado")).toBe("FINALIZADO");
  });
  it("Cerrado → FINALIZADO", () => {
    expect(mapStageToEstado("Cerrado")).toBe("FINALIZADO");
  });
  it("Nueva Solicitud → null (inicial, no se notifica)", () => {
    expect(mapStageToEstado("Nueva Solicitud")).toBeNull();
  });
  it("Cancelado → null (terminal, ML no tiene cancelación)", () => {
    expect(mapStageToEstado("Cancelado")).toBeNull();
  });
  it("Stage desconocido → null", () => {
    expect(mapStageToEstado("Frobnicate")).toBeNull();
  });
  it("tolera espacios alrededor (trim defensivo del webhook)", () => {
    expect(mapStageToEstado("  Agendado B2B  ")).toBe("COORDINACIÓN");
  });
  it("es case-sensitive (los picklist de Zoho son exactos; no adivina)", () => {
    expect(mapStageToEstado("agendado b2b")).toBeNull();
  });

  it("de los 5 stages B2B conocidos, exactamente 3 notifican; el mapa no tiene claves de más/menos", () => {
    // Guarda de REGRESIÓN sobre el mapa (no de descubrimiento): B2B_STAGES es la foto de
    // settings/pipeline al 30/06 congelada acá. OJO: NO detecta un stage NUEVO agregado en Zoho
    // (esa lista vive en la consola, no en el código) — eso se revisa manualmente contra el
    // pipeline. Lo que sí atrapa: que alguien agregue/saque/renombre una clave de STAGE_TO_ESTADO.
    const B2B_STAGES = ["Nueva Solicitud", "Agendado B2B", "Completado", "Cerrado", "Cancelado"];
    const NOTIFICABLES = B2B_STAGES.filter((s) => mapStageToEstado(s) !== null);
    expect(NOTIFICABLES.sort()).toEqual(["Agendado B2B", "Cerrado", "Completado"]);
    expect(Object.keys(STAGE_TO_ESTADO).sort()).toEqual(["Agendado B2B", "Cerrado", "Completado"]);
  });
});

// ── Use-case notifyEstadoChange ─────────────────────────────────────────────────

describe("notifyEstadoChange (outbound a ML)", () => {
  it("skip en los stages no-notificables ('Nueva Solicitud' y 'Cancelado') — no llama a ML", async () => {
    for (const stage of ["Nueva Solicitud", "Cancelado"]) {
      const ml = new MockMlCenterClient();
      const out = await notifyEstadoChange({ nroSolicitud: 908812, stage }, { mlCenter: ml });
      expect(out.status).toBe("skipped");
      expect(ml.calls).toHaveLength(0);
    }
  });

  it("envía COORDINACIÓN en 'Agendado B2B'", async () => {
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 908812, stage: "Agendado B2B" }, { mlCenter: ml });
    expect(out).toEqual({ status: "sent", estado: "COORDINACIÓN" });
    expect(ml.calls[0]).toMatchObject({ nroSolicitud: 908812, estado: "COORDINACIÓN" });
  });

  it("'invalid' (no 'error') si FINALIZADO sin LinkResultado — NO llama a ML", async () => {
    // Es validación de dominio, no falla de ML → la ruta lo traduce a 422, no a 502.
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 1, stage: "Completado" }, { mlCenter: ml });
    expect(out.status).toBe("invalid");
    expect(ml.calls).toHaveLength(0);
  });

  it("envía FINALIZADO con LinkResultado (tanto 'Completado' como 'Cerrado')", async () => {
    for (const stage of ["Completado", "Cerrado"]) {
      const ml = new MockMlCenterClient();
      const out = await notifyEstadoChange(
        { nroSolicitud: 1, stage, linkResultado: "https://x/r.pdf", observaciones: "listo" },
        { mlCenter: ml },
      );
      expect(out).toEqual({ status: "sent", estado: "FINALIZADO" });
      // Propaga linkResultado + observaciones al cliente ML.
      expect(ml.calls[0]).toMatchObject({
        estado: "FINALIZADO",
        linkResultado: "https://x/r.pdf",
        observaciones: "listo",
      });
    }
  });

  it("outcome 'error' (no throw) si el cliente ML falla, propagando el mensaje upstream", async () => {
    const out = await notifyEstadoChange({ nroSolicitud: 1, stage: "Agendado B2B" }, { mlCenter: new FailingMlClient() });
    expect(out).toMatchObject({ status: "error", message: expect.stringContaining("503") });
  });
});
