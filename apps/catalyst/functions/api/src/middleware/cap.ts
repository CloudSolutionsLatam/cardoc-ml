/**
 * Cap configurable por consumidor + endpoint, en 3 ventanas (hora/día/semana) → 429
 * CAP_EXCEEDED (AC-07). Se evalúa DESPUÉS de auth+scope (401/403 no consumen cap).
 *
 * Límites: config por consumidor (`CapRepository`) con fallback a los defaults de env.
 *
 * NOTA (gate de plataforma): los contadores acá son IN-MEMORY (por contenedor caliente).
 * El blueprint pide Catalyst Cache (TTL nativo, atomicidad del increment) para un cap
 * distribuido real; pendiente de validar la atomicidad antes de producción.
 */
import type { NextFunction, Response } from "express";
import type { CapWindow } from "@cardoc/persistence";
import { ApiError } from "./errors";
import type { AuthedRequest } from "./auth";

const DEFAULTS: Record<CapWindow, number> = {
  hour: Number(process.env["CARDOC_CAP_DEFAULT_HOUR"] ?? 1000),
  day: Number(process.env["CARDOC_CAP_DEFAULT_DAY"] ?? 10000),
  week: Number(process.env["CARDOC_CAP_DEFAULT_WEEK"] ?? 50000),
};
const WINDOW_MS: Record<CapWindow, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};
const WINDOWS: readonly CapWindow[] = ["hour", "day", "week"];

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export function cap(endpoint: string) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    req.endpoint = endpoint;
    const consumerId = req.consumerId ?? "unknown";
    const config = req.container ? await req.container.cap.getConfig(consumerId, endpoint) : null;
    const limits: Record<CapWindow, number | null> = {
      hour: config?.limitHour ?? DEFAULTS.hour,
      day: config?.limitDay ?? DEFAULTS.day,
      week: config?.limitWeek ?? DEFAULTS.week,
    };

    const nowMs = Date.now();
    let exceeded: { window: CapWindow; limit: number; retryAfter: number } | null = null;
    let tightest: { window: CapWindow; limit: number; remaining: number } | null = null;

    for (const w of WINDOWS) {
      const limit = limits[w];
      if (limit === null) {
        continue;
      }
      const key = `${consumerId}|${endpoint}|${w}`;
      let bucket = buckets.get(key);
      if (!bucket || nowMs >= bucket.resetAt) {
        bucket = { count: 0, resetAt: nowMs + WINDOW_MS[w] };
        buckets.set(key, bucket);
      }
      bucket.count += 1;

      const remaining = limit - bucket.count;
      if (!tightest || remaining < tightest.remaining) {
        tightest = { window: w, limit, remaining };
      }
      if (bucket.count > limit) {
        const retryAfter = Math.ceil((bucket.resetAt - nowMs) / 1000);
        if (!exceeded || retryAfter < exceeded.retryAfter) {
          exceeded = { window: w, limit, retryAfter };
        }
      }
    }

    if (tightest) {
      res.setHeader("X-Cap-Window", tightest.window);
      res.setHeader("X-Cap-Limit", String(tightest.limit));
      res.setHeader("X-Cap-Remaining", String(Math.max(0, tightest.remaining)));
    }

    if (exceeded) {
      res.setHeader("Retry-After", String(exceeded.retryAfter));
      next(
        new ApiError(429, "CAP_EXCEEDED", "límite de uso excedido", {
          window: exceeded.window,
          limit: exceeded.limit,
          retryAfterSeconds: exceeded.retryAfter,
        }),
      );
      return;
    }
    next();
  };
}
