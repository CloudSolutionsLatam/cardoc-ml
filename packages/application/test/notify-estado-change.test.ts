/**
 * Tests del use-case OUTBOUND a ML (notifyEstadoChange) y del mapeo Stage→Estado.
 *
 * Se prueba el mapeo B2B **real** (OQ-N6, confirmado 2026-07-01) — no un placeholder mutado:
 * si alguien rompe `STAGE_TO_ESTADO`, estos tests fallan. El invariante clave del negocio es
 * que FINALIZADO exige `LinkResultado` y que los stages no-notificables no llaman a ML.
 */
import { describe, expect, it } from "vitest";
import { MockMlCenterClient, UpstreamError, type MlCenterClient, type UpdateEstadoInput } from "@cardoc/providers";
import { mapStageToEstado, notifyEstadoChange, STAGE_TO_ESTADO } from "../src/notify-estado-change";

/** Técnico + empresa obligatorios (v1.1) — los aporta el CRM; se reusan en los inputs de prueba. */
const WHO = { nombreTecnico: "Juan García", empresa: "Inspecciones XYZ" };

/** Cliente ML que siempre falla con un status dado — para los caminos de error/clasificación. */
class FailingMlClient implements MlCenterClient {
  constructor(private readonly httpStatus = 503) {}
  async updateEstado(_input: UpdateEstadoInput): Promise<{ nroSolicitud: number; estado: string }> {
    // 400 = rechazo de cliente (no reintentable) → el use-case lo mapea a 'invalid'; 5xx → 'error'.
    throw new UpstreamError("mlcenter", this.httpStatus, `ML ${this.httpStatus}`);
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
  it("Nueva Solicitud → PENDIENTE (inicial)", () => {
    expect(mapStageToEstado("Nueva Solicitud")).toBe("PENDIENTE");
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

  it("de los 5 stages B2B conocidos, 4 notifican (solo 'Cancelado' no); el mapa no tiene claves de más/menos", () => {
    // Guarda de REGRESIÓN sobre el mapa (no de descubrimiento): B2B_STAGES es la foto de
    // settings/pipeline al 30/06 congelada acá. OJO: NO detecta un stage NUEVO agregado en Zoho
    // (esa lista vive en la consola, no en el código) — eso se revisa manualmente contra el
    // pipeline. Lo que sí atrapa: que alguien agregue/saque/renombre una clave de STAGE_TO_ESTADO.
    const B2B_STAGES = ["Nueva Solicitud", "Agendado B2B", "Completado", "Cerrado", "Cancelado"];
    const NOTIFICABLES = B2B_STAGES.filter((s) => mapStageToEstado(s) !== null);
    expect(NOTIFICABLES.sort()).toEqual(["Agendado B2B", "Cerrado", "Completado", "Nueva Solicitud"]);
    expect(Object.keys(STAGE_TO_ESTADO).sort()).toEqual(["Agendado B2B", "Cerrado", "Completado", "Nueva Solicitud"]);
  });
});

// ── Use-case notifyEstadoChange ─────────────────────────────────────────────────

describe("notifyEstadoChange (outbound a ML)", () => {
  it("skip solo en 'Cancelado' (no-notificable) — no llama a ML ni exige técnico/empresa", async () => {
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 908812, stage: "Cancelado" }, { mlCenter: ml });
    expect(out.status).toBe("skipped");
    expect(ml.calls).toHaveLength(0);
  });

  it("envía PENDIENTE en 'Nueva Solicitud' (inicial, sin LinkResultado)", async () => {
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 908812, stage: "Nueva Solicitud", ...WHO }, { mlCenter: ml });
    expect(out).toEqual({ status: "sent", estado: "PENDIENTE" });
    expect(ml.calls[0]).toMatchObject({ nroSolicitud: 908812, estado: "PENDIENTE", ...WHO });
  });

  it("envía COORDINACIÓN en 'Agendado B2B' propagando NombreTecnico/Empresa (obligatorios v1.1)", async () => {
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 908812, stage: "Agendado B2B", ...WHO }, { mlCenter: ml });
    expect(out).toEqual({ status: "sent", estado: "COORDINACIÓN" });
    expect(ml.calls[0]).toMatchObject({ nroSolicitud: 908812, estado: "COORDINACIÓN", ...WHO });
  });

  it("'invalid' (no llama a ML) si falta NombreTecnico o Empresa — obligatorios en v1.1", async () => {
    const ml = new MockMlCenterClient();
    const sinTecnico = await notifyEstadoChange(
      { nroSolicitud: 1, stage: "Agendado B2B", empresa: "Inspecciones XYZ" },
      { mlCenter: ml },
    );
    expect(sinTecnico.status).toBe("invalid");
    const sinEmpresa = await notifyEstadoChange(
      { nroSolicitud: 1, stage: "Agendado B2B", nombreTecnico: "Juan" },
      { mlCenter: ml },
    );
    expect(sinEmpresa.status).toBe("invalid");
    // Un string en blanco no cuenta (trim defensivo).
    const enBlanco = await notifyEstadoChange(
      { nroSolicitud: 1, stage: "Agendado B2B", nombreTecnico: "  ", empresa: "  " },
      { mlCenter: ml },
    );
    expect(enBlanco.status).toBe("invalid");
    expect(ml.calls).toHaveLength(0);
  });

  it("'invalid' (no 'error') si FINALIZADO sin LinkResultado — NO llama a ML", async () => {
    // Es validación de dominio, no falla de ML → la ruta lo traduce a 422, no a 502.
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 1, stage: "Completado", ...WHO }, { mlCenter: ml });
    expect(out.status).toBe("invalid");
    expect(ml.calls).toHaveLength(0);
  });

  it("envía FINALIZADO con LinkResultado (tanto 'Completado' como 'Cerrado')", async () => {
    for (const stage of ["Completado", "Cerrado"]) {
      const ml = new MockMlCenterClient();
      const out = await notifyEstadoChange(
        { nroSolicitud: 1, stage, ...WHO, linkResultado: "https://x/r.pdf", observaciones: "listo" },
        { mlCenter: ml },
      );
      expect(out).toEqual({ status: "sent", estado: "FINALIZADO" });
      // Propaga técnico/empresa + linkResultado + observaciones al cliente ML.
      expect(ml.calls[0]).toMatchObject({
        estado: "FINALIZADO",
        ...WHO,
        linkResultado: "https://x/r.pdf",
        observaciones: "listo",
      });
    }
  });

  it("outcome 'error' (502, reintentable) si ML falla con 5xx, propagando el mensaje upstream", async () => {
    const out = await notifyEstadoChange(
      { nroSolicitud: 1, stage: "Agendado B2B", ...WHO },
      { mlCenter: new FailingMlClient(503) },
    );
    expect(out).toMatchObject({ status: "error", message: expect.stringContaining("503") });
  });

  it("outcome 'invalid' (422, NO reintentable) si ML rechaza con 400 — validación/transición/mismo estado", async () => {
    // Anti-duplicados de v1.1: re-notificar el mismo estado devuelve 400. Reintentar no arregla nada.
    const out = await notifyEstadoChange(
      { nroSolicitud: 1, stage: "Agendado B2B", ...WHO },
      { mlCenter: new FailingMlClient(400) },
    );
    expect(out.status).toBe("invalid");
  });
});
