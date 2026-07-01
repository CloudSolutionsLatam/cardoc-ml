/**
 * Tests del transform (raw Custom API → InformeReport). Bloquean las trampas de fallo
 * silencioso de planning.md §4.4 y las reglas §4.5: cada `it` falla si se rompe una regla
 * que, de otro modo, produciría contenido faltante SIN error.
 */
import { describe, expect, it } from "vitest";
import { getInitials, transformReportData, type RawInspectionReport } from "../src/report-transform";

/** Raw mínimo con un componente en el anidamiento correcto (3 niveles). */
function rawWithComponent(over: Partial<RawInspectionReport> = {}): RawInspectionReport {
  return {
    code: "#R-12345",
    modulos: [
      {
        name: "2- CHASIS",
        sub_modulos: [
          {
            name: "FRENTE",
            components: [
              {
                id: "c1",
                name: "Chasis delantero izquierdo",
                description: "desc",
                status: { name: "bueno", label: "Bueno" },
                ai_summary: "ok",
                inspector_note: "nota",
                evidences: [],
              },
            ],
          },
        ],
      },
    ],
    ...over,
  };
}

describe("transformReportData — trampas de fallo silencioso (§4.4)", () => {
  it("vehicle.año (clave con Ñ+tilde) se lee; matricula→placa; kms→kilometraje con ' km'", () => {
    const out = transformReportData({
      code: "#R-1",
      vehicle: { marca: "VW", modelo: "Amarok", año: "2018", matricula: "SBA1234", kms: 90000, motor: "2.0", transmision: "AT" },
    });
    expect(out.vehiculo.año).toBe("2018");
    expect(out.vehiculo.placa).toBe("SBA1234");
    expect(out.vehiculo.kilometraje).toBe("90000 km");
  });

  it("campos de vehículo ausentes caen a '' (no 'N/A'); placa a 'Sin matrícula'; km '' sin valor", () => {
    const out = transformReportData({ code: "#R-1", vehicle: {} });
    expect(out.vehiculo.marca).toBe("");
    expect(out.vehiculo.motor).toBe("");
    expect(out.vehiculo.placa).toBe("Sin matrícula");
    expect(out.vehiculo.kilometraje).toBe("");
  });

  it("score = 0 es VÁLIDO (no se coacciona a null)", () => {
    expect(transformReportData({ score: 0 }).score).toBe(0);
  });

  it("score '' / null / ausente → null (oculta la sección)", () => {
    expect(transformReportData({ score: "" }).score).toBeNull();
    expect(transformReportData({ score: null }).score).toBeNull();
    expect(transformReportData({}).score).toBeNull();
  });

  it("score numérico se preserva", () => {
    expect(transformReportData({ score: 8 }).score).toBe(8);
  });

  it("score string numérico ('8') se coacciona a number (Creator/Deluge serializa así)", () => {
    expect(transformReportData({ score: "8" }).score).toBe(8);
  });

  it("score string NO numérico ('N/A') → null (blinda contra imprimir 'NaN/10')", () => {
    expect(transformReportData({ score: "N/A" }).score).toBeNull();
  });

  it("los components DEBEN estar bajo sub_modulos (3 niveles); aplanarlos = cero detalles", () => {
    const conAnidamiento = transformReportData(rawWithComponent());
    expect(conAnidamiento.detalles).toHaveLength(1);
    // Si alguien pusiera components directo bajo el módulo (2 niveles), el transform no los ve:
    const aplanado = transformReportData({
      code: "#R-1",
      // @ts-expect-error — shape inválido a propósito (components fuera de sub_modulos)
      modulos: [{ name: "M", components: [{ name: "X", status: { name: "malo" } }] }],
    });
    expect(aplanado.detalles).toHaveLength(0);
  });
});

describe("transformReportData — vocabularios y reglas (§4.3/§4.5)", () => {
  it("mapEstado: advertencia→observacion, malo→critico, bueno/otro/null→aprobado", () => {
    const estado = (name: string | undefined) =>
      transformReportData(rawWithComponent({
        modulos: [{ name: "M", sub_modulos: [{ name: "S", components: [{ name: "C", status: name ? { name } : undefined }] }] }],
      })).detalles[0]?.estado;
    expect(estado("advertencia")).toBe("observacion");
    expect(estado("malo")).toBe("critico");
    expect(estado("bueno")).toBe("aprobado");
    expect(estado("cualquier_otra_cosa")).toBe("aprobado");
    expect(estado(undefined)).toBe("aprobado");
  });

  it("status.name === 'sin_evaluar' descarta el componente entero", () => {
    const out = transformReportData({
      code: "#R-1",
      modulos: [{ name: "M", sub_modulos: [{ name: "S", components: [
        { name: "A", status: { name: "sin_evaluar" } },
        { name: "B", status: { name: "bueno" } },
      ] }] }],
    });
    expect(out.detalles).toHaveLength(1);
    expect(out.detalles[0].titulo).toBe("B");
  });

  it("sub_modulo sin components se saltea", () => {
    const out = transformReportData({
      code: "#R-1",
      modulos: [{ name: "M", sub_modulos: [{ name: "vacío", components: [] }, { name: "S", components: [{ name: "C", status: { name: "bueno" } }] }] }],
    });
    expect(out.detalles).toHaveLength(1);
  });

  it("tituloJerarquico: colapsa duplicados CONSECUTIVOS y hace join ' - '", () => {
    const out = transformReportData({
      code: "#R-1",
      modulos: [{ name: "CHASIS", sub_modulos: [{ name: "CHASIS", components: [{ name: "Larguero", status: { name: "bueno" } }] }] }],
    });
    // "CHASIS" (módulo) y "CHASIS" (submódulo) consecutivos → uno solo.
    expect(out.detalles[0].tituloJerarquico).toBe("CHASIS - Larguero");
  });

  it("tituloJerarquico vacío → 'Sin nombre'", () => {
    const out = transformReportData({
      code: "#R-1",
      modulos: [{ name: "", sub_modulos: [{ name: "", components: [{ name: "", status: { name: "bueno" } }] }] }],
    });
    expect(out.detalles[0].tituloJerarquico).toBe("Sin nombre");
  });

  it("evidence buckets: foto→imagenes(url), audio(req resource)→audioData, video(sin req)→videoData, ocr(req)→pdfData", () => {
    const out = transformReportData({
      code: "#R-1",
      modulos: [{ name: "M", sub_modulos: [{ name: "S", components: [{
        name: "C", status: { name: "bueno" },
        evidences: [
          { type: "foto", resource: "http://wd/f1.jpg" },
          { type: "foto", resource: "" }, // sin resource → descartada
          { type: "audio", resource: "http://wd/a1.mp3" },
          { type: "audio", resource: "" }, // sin resource → descartada
          { type: "video", resource: "" }, // video SIN resource → SE CONSERVA
          { type: "ocr", resource: "http://wd/doc.pdf" },
          { type: "ocr", resource: "" }, // sin resource → descartada
        ],
      }] }] }],
    });
    const d = out.detalles[0];
    expect(d.imagenes).toEqual(["http://wd/f1.jpg"]);
    expect(d.audioData).toHaveLength(1);
    expect(d.videoData).toHaveLength(1); // conservado pese a resource vacío
    expect(d.pdfData).toHaveLength(1);
  });

  it("id de detalle: contador 1-based corrido en todo el informe", () => {
    const out = transformReportData({
      code: "#R-1",
      modulos: [
        { name: "M1", sub_modulos: [{ name: "S", components: [{ name: "A", status: { name: "bueno" } }, { name: "B", status: { name: "bueno" } }] }] },
        { name: "M2", sub_modulos: [{ name: "S", components: [{ name: "C", status: { name: "bueno" } }] }] },
      ],
    });
    expect(out.detalles.map((d) => d.id)).toEqual([1, 2, 3]);
    expect(out.detalles.map((d) => d.seccionId)).toEqual([1, 1, 2]);
  });

  it("inspector.cargo = 'Inspector @ {agencia}' o 'Inspector' sin agencia; fecha NO se re-formatea", () => {
    const conAgencia = transformReportData({ inspector: { name: "Ana", fecha: "20/06/2026" }, inspection_agency: { name: "TallerX" } });
    expect(conAgencia.inspector.cargo).toBe("Inspector @ TallerX");
    expect(conAgencia.fechaInspeccion).toBe("20/06/2026");
    const sinAgencia = transformReportData({ inspector: { name: "Ana" } });
    expect(sinAgencia.inspector.cargo).toBe("Inspector");
  });

  it("code → id y reportCode; ausente → ''", () => {
    expect(transformReportData({ code: "#R-9" }).reportCode).toBe("#R-9");
    expect(transformReportData({}).reportCode).toBe("");
  });
});

describe("getInitials", () => {
  it("2+ palabras → iniciales de las 2 primeras", () => expect(getInitials("Juan Pérez López")).toBe("JP"));
  it("1 palabra → primeras 2 letras", () => expect(getInitials("Ana")).toBe("AN"));
  it("vacío → 'IC'", () => expect(getInitials("")).toBe("IC"));
});
