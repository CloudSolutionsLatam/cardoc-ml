/**
 * Middlewares transversales: correlación, composición de deps, autenticación, scope.
 *
 * Regla núcleo: el `consumerId`/`accountId`/`scopes` se RESUELVEN del token (hash →
 * `api_tokens`). JAMÁS vienen del payload/query del request (tenancy, AC-06/AC-10).
 */
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { hashToken, type Scope } from "@cardoc/domain";
import { buildContainer, type ApiContainer } from "../container";
import { ApiError } from "./errors";

/** Request enriquecido por los middlewares. */
export interface AuthedRequest extends Request {
  container?: ApiContainer;
  consumerId?: string;
  accountId?: string;
  scopes?: Scope[];
  correlationId?: string;
  startMs?: number;
  /** Endpoint lógico, seteado por el middleware de cap (para auditoría). */
  endpoint?: string;
  /** Código de error, seteado por errorMiddleware (para auditoría on-finish). */
  errorCode?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Propaga el `X-Correlation-Id` (validado como UUID o regenerado) y marca el inicio. */
export function correlationMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const incoming = req.header("x-correlation-id");
  const correlationId = incoming && UUID_RE.test(incoming) ? incoming : randomUUID();
  req.correlationId = correlationId;
  req.startMs = Date.now();
  res.setHeader("X-Correlation-Id", correlationId);
  next();
}

/** Compone las dependencias (repos + adapters) para este request y las cuelga del req. */
export function attachContainer(req: AuthedRequest, _res: Response, next: NextFunction): void {
  try {
    req.container = buildContainer(req);
    next();
  } catch (e) {
    next(new ApiError(500, "INTERNAL_ERROR", `container init failed: ${(e as Error).message}`));
  }
}

/** Exige Bearer token, lo resuelve a consumidor + Cuenta + scopes y valida vigencia. */
export async function authMiddleware(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (token.length === 0) {
    next(new ApiError(401, "UNAUTHENTICATED", "falta el Bearer token"));
    return;
  }
  if (!req.container) {
    next(new ApiError(500, "INTERNAL_ERROR", "container no adjunto"));
    return;
  }

  try {
    // Solo se compara el HASH; el token plano nunca se persiste ni se loguea.
    const row = await req.container.tokens.resolveByHash(hashToken(token));
    const expired = row?.expiresAt ? Date.parse(row.expiresAt) < Date.now() : false;
    if (!row || row.revokedAt || expired) {
      next(new ApiError(401, "UNAUTHENTICATED", "token inválido"));
      return;
    }
    req.consumerId = row.consumerId;
    req.accountId = row.accountId;
    req.scopes = row.scopes;
    await req.container.tokens.touchLastUsed(row.tokenHash);
    next();
  } catch (e) {
    next(e);
  }
}

/** Exige un scope concreto. 403 FORBIDDEN_SCOPE si el token no lo tiene. */
export function requireScope(scope: Scope) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.scopes || !req.scopes.includes(scope)) {
      next(new ApiError(403, "FORBIDDEN_SCOPE", "scope insuficiente", { required: scope }));
      return;
    }
    next();
  };
}

/**
 * Protege rutas internas (CRM → Catalyst) con un shared-secret (`x-internal-secret`),
 * no con Bearer: es una llamada de confianza, no de un consumidor público.
 */
export function requireInternalSecret(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const expected = process.env["INTERNAL_WEBHOOK_SECRET"] ?? "dev-internal-secret";
  const got = req.header("x-internal-secret") ?? "";
  if (got !== expected) {
    next(new ApiError(401, "UNAUTHENTICATED", "internal secret inválido"));
    return;
  }
  next();
}
