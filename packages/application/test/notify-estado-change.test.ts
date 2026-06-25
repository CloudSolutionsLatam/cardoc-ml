import { describe, expect, it, beforeEach } from "vitest";
import { MockMlCenterClient } from "@cardoc/providers";
import { notifyEstadoChange, STAGE_TO_ESTADO } from "../src/notify-estado-change";

// El mapeo Stage→Estado es placeholder (vacío) hasta cerrar el OQ; lo poblamos por test.
beforeEach(() => {
  for (const k of Object.keys(STAGE_TO_ESTADO)) delete STAGE_TO_ESTADO[k];
});

describe("notifyEstadoChange (outbound a ML)", () => {
  it("skip si el Stage no mapea a un Estado de ML", async () => {
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 908812, stage: "Cualquiera" }, { mlCenter: ml });
    expect(out.status).toBe("skipped");
    expect(ml.calls).toHaveLength(0);
  });

  it("envía COORDINACIÓN cuando el Stage mapea", async () => {
    STAGE_TO_ESTADO["Coordinación"] = "COORDINACIÓN";
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 908812, stage: "Coordinación" }, { mlCenter: ml });
    expect(out).toEqual({ status: "sent", estado: "COORDINACIÓN" });
    expect(ml.calls[0]).toMatchObject({ nroSolicitud: 908812, estado: "COORDINACIÓN" });
  });

  it("error si FINALIZADO sin LinkResultado (no llama a ML)", async () => {
    STAGE_TO_ESTADO["Finalizado"] = "FINALIZADO";
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange({ nroSolicitud: 1, stage: "Finalizado" }, { mlCenter: ml });
    expect(out.status).toBe("error");
    expect(ml.calls).toHaveLength(0);
  });

  it("envía FINALIZADO con LinkResultado", async () => {
    STAGE_TO_ESTADO["Finalizado"] = "FINALIZADO";
    const ml = new MockMlCenterClient();
    const out = await notifyEstadoChange(
      { nroSolicitud: 1, stage: "Finalizado", linkResultado: "https://x/r.pdf" },
      { mlCenter: ml },
    );
    expect(out).toEqual({ status: "sent", estado: "FINALIZADO" });
  });
});
