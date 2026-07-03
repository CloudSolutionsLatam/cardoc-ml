/**
 * `buildReportFilename` — nomenclatura del PDF (decisión §10 D4, mail Cardoc 2026-07-02):
 * NombreCliente_IDInterno_Fecha.pdf con fecha ISO 8601 y sanitización segura para header/FS.
 */
import { describe, expect, it } from "vitest";
import type { InformeReport } from "@cardoc/domain";
import { buildReportFilename } from "../src/reports-source";

/** Informe mínimo: `buildReportFilename` solo lee cliente.nombre / reportCode / fechaInspeccion. */
function informe(over: Partial<InformeReport> = {}): InformeReport {
  return {
    reportCode: "#R-12345",
    cliente: { nombre: "Automotora del Este S.A.", telefono: "" },
    fechaInspeccion: "20/06/2026",
    ...over,
  } as unknown as InformeReport;
}

describe("buildReportFilename", () => {
  it("compone NombreCliente_IDInterno_Fecha.pdf con fecha dd/mm/yyyy → ISO", () => {
    expect(buildReportFilename(informe(), "999")).toBe("Automotora-del-Este-S-A_R-12345_2026-06-20.pdf");
  });

  it("quita acentos y la tilde de la ñ (NFD + marcas combinantes)", () => {
    const name = buildReportFilename(informe({ cliente: { nombre: "José Peña Ñandú", telefono: "" } }), "1");
    expect(name.startsWith("Jose-Pena-Nandu_")).toBe(true);
  });

  it("deja pasar una fecha que ya viene en ISO 8601", () => {
    expect(buildReportFilename(informe({ fechaInspeccion: "2026-06-15" }), "1")).toContain("_2026-06-15.pdf");
  });

  it("fecha no parseable → 'sin-fecha' (sin fallbackDate)", () => {
    expect(buildReportFilename(informe({ fechaInspeccion: "ayer" }), "1")).toContain("_sin-fecha.pdf");
  });

  it("fecha ausente/no parseable + fallbackDate → usa el fallback (p. ej. fecha de generación)", () => {
    expect(buildReportFilename(informe({ fechaInspeccion: "" }), "1", "2026-07-01")).toContain("_2026-07-01.pdf");
    // Una fecha propia válida SIEMPRE gana sobre el fallback.
    expect(buildReportFilename(informe({ fechaInspeccion: "20/06/2026" }), "1", "2026-07-01")).toContain("_2026-06-20.pdf");
  });

  it("cliente vacío → 'Cliente'; reportCode vacío → cae al id (sanitizado)", () => {
    const name = buildReportFilename(informe({ cliente: { nombre: "", telefono: "" }, reportCode: "" }), "4837888000004307360");
    expect(name).toBe("Cliente_4837888000004307360_2026-06-20.pdf");
  });

  it("no deja caracteres inseguros para el header/FS (solo [A-Za-z0-9-_.])", () => {
    const name = buildReportFilename(informe({ cliente: { nombre: 'A/B\\C"D#E', telefono: "" } }), "1");
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.pdf$/);
  });
});
