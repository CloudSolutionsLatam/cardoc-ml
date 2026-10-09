import { describe, expect, it, vi } from "vitest";
import { ZohoTokenProvider } from "../src/zoho-token";

const creds = { clientId: "1000.ID", clientSecret: "SECRET", refreshToken: "1000.RT" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Rechazo tal cual lo arma el SDK de Catalyst en un no-2xx (objeto plano, no Error). */
const cacheExhausted = {
  statusCode: 400,
  code: "FREE_USAGE_LIMIT_REACHED",
  message: "You have exhausted the free tier allowance for Cache - Get.",
};

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ZohoTokenProvider — camino principal (SDK)", () => {
  it("memoiza el token del SDK 10 min a nivel contenedor (no un Cache GET por request)", async () => {
    const c = clock();
    const primary = vi.fn(async () => "tok-sdk");
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const p = new ZohoTokenProvider({ selfClient: () => creds, fetchFn, now: c.now });

    expect(await p.getAccessToken(primary)).toBe("tok-sdk");
    c.advance(9 * 60_000);
    expect(await p.getAccessToken(primary)).toBe("tok-sdk");
    expect(primary).toHaveBeenCalledTimes(1);

    c.advance(2 * 60_000); // pasó la memo → vuelve a pedirle al SDK
    await p.getAccessToken(primary);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requests concurrentes comparten UNA resolución", async () => {
    const primary = vi.fn(async () => "tok-sdk");
    const p = new ZohoTokenProvider({ selfClient: () => creds });
    const all = await Promise.all([p.getAccessToken(primary), p.getAccessToken(primary), p.getAccessToken(primary)]);
    expect(all).toEqual(["tok-sdk", "tok-sdk", "tok-sdk"]);
    expect(primary).toHaveBeenCalledTimes(1);
  });
});

describe("ZohoTokenProvider — fallback refresh directo", () => {
  it("Cache agotado (FREE_USAGE_LIMIT_REACHED) → refresca directo contra Accounts y avisa el motivo", async () => {
    const c = clock();
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), body: String((init as { body?: string }).body) });
      return json({ access_token: "tok-direct", expires_in: 3600 });
    }) as typeof fetch;
    const onFallback = vi.fn();
    const primary = vi.fn(async () => Promise.reject(cacheExhausted));
    const p = new ZohoTokenProvider({ selfClient: () => creds, fetchFn, now: c.now, onFallback });

    expect(await p.getAccessToken(primary)).toBe("tok-direct");
    expect(calls[0]?.url).toBe("https://accounts.zoho.com/oauth/v2/token");
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("1000.RT");
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("FREE_USAGE_LIMIT_REACHED"));

    // Memo hasta 5 min antes del vencimiento (55 min): ni SDK ni Accounts de nuevo.
    c.advance(54 * 60_000);
    expect(await p.getAccessToken(primary)).toBe("tok-direct");
    expect(calls).toHaveLength(1);
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("fallan los dos → el error nombra ambos motivos, sin secretos", async () => {
    const fetchFn = (async () => json({ error: "invalid_code" })) as unknown as typeof fetch; // Zoho: 200 + {error}
    const p = new ZohoTokenProvider({ selfClient: () => creds, fetchFn });
    const err = await p.getAccessToken(async () => Promise.reject(cacheExhausted)).catch((e: Error) => e);
    expect(String(err)).toContain("SDK: HTTP 400 FREE_USAGE_LIMIT_REACHED");
    expect(String(err)).toContain("refresh directo: HTTP 200 invalid_code");
    expect(String(err)).not.toContain("SECRET");
    expect(String(err)).not.toContain("1000.RT");
  });

  it("sin creds del self-client → error explícito (no un fetch con undefined)", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const p = new ZohoTokenProvider({ selfClient: () => ({}), fetchFn });
    await expect(p.getAccessToken(async () => Promise.reject(cacheExhausted))).rejects.toThrow(/faltan ZOHO_CLIENT_ID/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("tras un fallo NO queda memoizado el error: el siguiente request reintenta", async () => {
    let ok = false;
    const fetchFn = (async () => (ok ? json({ access_token: "tok-2", expires_in: 3600 }) : json({ error: "Access Denied" }, 400))) as unknown as typeof fetch;
    const p = new ZohoTokenProvider({ selfClient: () => creds, fetchFn });
    const primary = async () => Promise.reject(cacheExhausted);
    await expect(p.getAccessToken(primary)).rejects.toThrow(/Access Denied/);
    ok = true;
    expect(await p.getAccessToken(primary)).toBe("tok-2");
  });
});
