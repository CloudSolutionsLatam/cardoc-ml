/**
 * Gates de seguridad de la función (plan §7), a nivel unitario del middleware — corren en
 * cada push (a diferencia del smoke, que necesita build). Cubren los invariantes de:
 *   - autorización por scope (matriz scope × endpoint → 403 FORBIDDEN_SCOPE, nunca 404/200);
 *   - traducción de errores al sobre único SIN filtrar internals (cross-tenant → 404, no 403;
 *     upstream → 502 con etiqueta OPACA, sin URL/ruta);
 *   - secreto compartido de la ruta interna;
 *   - correlación (UUID validado o regenerado).
 *
 * Los `req`/`res` son fakes mínimos (cast a `any`): estos tests viven en `test/`, fuera del
 * `tsc -b` de la función (include = `src/**`), y vitest no hace type-check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotImplementedError, PdfNotAvailableError, ReportNotFoundError, UpstreamError } from "@cardoc/providers";
import type { Scope } from "@cardoc/domain";
import {
  correlationMiddleware,
  requireInternalSecret,
  requireScope,
} from "../src/middleware/auth";
import { ApiError, errorMiddleware } from "../src/middleware/errors";
import { listInformesHandler } from "../src/routes/informes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Captura el argumento con que se llamó `next` (el error, o undefined si pasó limpio). */
function captureNext() {
  const box: { called: boolean; arg: unknown } = { called: false, arg: undefined };
  const next = (arg?: unknown): void => {
    box.called = true;
    box.arg = arg;
  };
  return { next, box };
}

/** `res` mínimo que captura status + body del sobre de error. */
function fakeRes() {
  const captured: { status: number; body: unknown; headers: Record<string, unknown> } = {
    status: 0,
    body: undefined,
    headers: {},
  };
  const res = {
    headersSent: false,
    setHeader(name: string, value: unknown): void {
      captured.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as any, captured };
}

// ── Matriz scope × endpoint (AC-10 vs scope) ────────────────────────────────────

describe("requireScope — matriz scope × endpoint", () => {
  // (endpoint lógico, scope exigido) — refleja el wiring de app.ts.
  const ENDPOINTS: Array<{ endpoint: string; required: Scope }> = [
    { endpoint: "POST /v1/opportunity-contact", required: "opportunities:create" },
    { endpoint: "GET /v1/informes", required: "reports:read" },
    { endpoint: "GET /v1/informes/:id/pdf", required: "reports:pdf" },
  ];
  const ALL: Scope[] = ["opportunities:create", "reports:read", "reports:pdf"];

  for (const { endpoint, required } of ENDPOINTS) {
    it(`${endpoint}: token CON '${required}' pasa`, () => {
      const { next, box } = captureNext();
      requireScope(required)({ scopes: [required] } as any, {} as any, next);
      expect(box.called).toBe(true);
      expect(box.arg).toBeUndefined(); // next() sin error
    });

    it(`${endpoint}: token con los OTROS scopes (sin '${required}') → 403 FORBIDDEN_SCOPE`, () => {
      const others = ALL.filter((s) => s !== required);
      const { next, box } = captureNext();
      requireScope(required)({ scopes: others } as any, {} as any, next);
      expect(box.arg).toBeInstanceOf(ApiError);
      const err = box.arg as ApiError;
      expect(err.httpStatus).toBe(403); // 403, NO 404 ni 200
      expect(err.code).toBe("FORBIDDEN_SCOPE");
    });
  }

  it("sin scopes (o scopes ausentes) → 403 FORBIDDEN_SCOPE", () => {
    const { next: n1, box: b1 } = captureNext();
    requireScope("reports:pdf")({ scopes: [] } as any, {} as any, n1);
    expect((b1.arg as ApiError).httpStatus).toBe(403);

    const { next: n2, box: b2 } = captureNext();
    requireScope("reports:pdf")({} as any, {} as any, n2);
    expect((b2.arg as ApiError).httpStatus).toBe(403);
  });
});

// ── Traducción de errores al sobre único (sin filtrar internals) ────────────────

describe("errorMiddleware — mapeo a códigos estables sin fuga de internals", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function run(err: unknown): { status: number; body: any } {
    const { res, captured } = fakeRes();
    const { next } = captureNext();
    errorMiddleware(err, { correlationId: "c1", method: "GET", path: "/x" } as any, res, next);
    return captured as { status: number; body: any };
  }

  it("ReportNotFoundError → 404 NOT_FOUND (cross-tenant indistinguible de inexistente)", () => {
    const c = run(new ReportNotFoundError("acc_B-INF-001"));
    expect(c.status).toBe(404);
    expect(c.body.error.code).toBe("NOT_FOUND");
    // No se filtra el id ajeno ni ubicación: el mensaje es genérico.
    expect(JSON.stringify(c.body)).not.toContain("acc_B-INF-001");
  });

  it("PdfNotAvailableError → 404 PDF_NOT_AVAILABLE", () => {
    const c = run(new PdfNotAvailableError("INF-1"));
    expect(c.status).toBe(404);
    expect(c.body.error.code).toBe("PDF_NOT_AVAILABLE");
  });

  it("UpstreamError → 502 UPSTREAM_ERROR con etiqueta OPACA (sin URL interna)", () => {
    const c = run(new UpstreamError("workdrive", 500, "https://internal.workdrive/ruta/interna fallo"));
    expect(c.status).toBe(502);
    expect(c.body.error.code).toBe("UPSTREAM_ERROR");
    expect(c.body.error.details.upstream).toBe("workdrive"); // etiqueta, no URL
    // La URL/ruta interna del upstream NUNCA llega al consumidor.
    expect(JSON.stringify(c.body)).not.toContain("internal.workdrive");
    expect(JSON.stringify(c.body)).not.toContain("ruta/interna");
  });

  it("Error desconocido → 500 INTERNAL_ERROR (mensaje genérico, sin detalle interno)", () => {
    // El fixture es un marcador reconocible (no un secreto real): el 500 NO debe echar `err.message`.
    const c = run(new Error("detalle-interno-sensible-no-debe-filtrarse"));
    expect(c.status).toBe(500);
    expect(c.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(c.body)).not.toContain("detalle-interno-sensible-no-debe-filtrarse");
  });

  it("ApiError propio pasa tal cual (código y status preservados)", () => {
    const c = run(new ApiError(429, "CAP_EXCEEDED", "límite alcanzado", { retryAfter: 60 }));
    expect(c.status).toBe(429);
    expect(c.body.error.code).toBe("CAP_EXCEEDED");
  });

  it("incluye el correlationId en el sobre", () => {
    const c = run(new ReportNotFoundError("X"));
    expect(c.body.error.correlationId).toBe("c1");
  });
});

// ── Ruta interna: shared-secret ─────────────────────────────────────────────────

describe("requireInternalSecret", () => {
  const SECRET = process.env["INTERNAL_WEBHOOK_SECRET"] ?? "dev-internal-secret";

  function call(secretHeader: string | undefined): { called: boolean; arg: unknown } {
    const { next, box } = captureNext();
    const req = { header: (n: string) => (n === "x-internal-secret" ? secretHeader : undefined) };
    requireInternalSecret(req as any, {} as any, next);
    return box;
  }

  it("secret correcto → pasa", () => {
    const box = call(SECRET);
    expect(box.arg).toBeUndefined();
  });

  it("secret incorrecto → 401 UNAUTHENTICATED", () => {
    const box = call("wrong-secret");
    expect((box.arg as ApiError).httpStatus).toBe(401);
    expect((box.arg as ApiError).code).toBe("UNAUTHENTICATED");
  });

  it("secret ausente → 401 UNAUTHENTICATED", () => {
    const box = call(undefined);
    expect((box.arg as ApiError).httpStatus).toBe(401);
  });
});

// ── Correlación: UUID validado o regenerado (AC-04) ─────────────────────────────

describe("correlationMiddleware", () => {
  function call(incoming: string | undefined): { req: any; captured: any } {
    const { res, captured } = fakeRes();
    const { next } = captureNext();
    const req: any = { header: (n: string) => (n === "x-correlation-id" ? incoming : undefined) };
    correlationMiddleware(req, res, next);
    return { req, captured };
  }

  it("propaga un X-Correlation-Id válido (UUID)", () => {
    const valid = "123e4567-e89b-42d3-a456-426614174000";
    const { req, captured } = call(valid);
    expect(req.correlationId).toBe(valid);
    expect(captured.headers["x-correlation-id"]).toBe(valid);
  });

  it("regenera un UUID cuando el header es inválido", () => {
    const { req, captured } = call("no-es-un-uuid");
    expect(req.correlationId).not.toBe("no-es-un-uuid");
    expect(UUID_RE.test(req.correlationId)).toBe(true);
    expect(captured.headers["x-correlation-id"]).toBe(req.correlationId);
  });

  it("genera un UUID cuando no viene header", () => {
    const { req } = call(undefined);
    expect(UUID_RE.test(req.correlationId)).toBe(true);
  });
});

// ── GET /v1/informes: listado descartado (ADR-0015) → 501 limpio, no 500 ─────────

describe("listInformesHandler — gate del listado descartado", () => {
  const baseReq = (listByAccount: () => Promise<unknown>): any => ({
    query: {},
    correlationId: "corr-test",
    accountId: "acc_ml",
    container: { reports: { listByAccount } },
  });

  it("adapter que lanza NotImplementedError (modo creator) → 501 NOT_IMPLEMENTED (no 500)", async () => {
    const { next, box } = captureNext();
    const { res } = fakeRes();
    listInformesHandler(
      baseReq(async () => {
        throw new NotImplementedError("ZohoCreatorReportsSource", "listByAccount");
      }),
      res,
      next,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(box.arg).toBeInstanceOf(ApiError);
    const err = box.arg as ApiError;
    expect(err.httpStatus).toBe(501);
    expect(err.code).toBe("NOT_IMPLEMENTED");
  });

  it("modo mock (listByAccount responde) → 200 data[], sin next(err)", async () => {
    const { next, box } = captureNext();
    const { res, captured } = fakeRes();
    listInformesHandler(
      baseReq(async () => ({ data: [], page: { limit: 20, nextCursor: null, hasMore: false } })),
      res,
      next,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(box.called).toBe(false);
    expect(captured.status).toBe(200);
  });
});
