/**
 * Token OAuth de Zoho (self-client) resistente a la caída del Cache de Catalyst. ADR-0004 (rev. 2026-10-09).
 *
 * El connector del SDK (`app.connection({...}).getConnector().getAccessToken()`) guarda el token
 * en el Cache de Catalyst y hace un **Cache GET en cada llamada** (el connector es por request).
 * Incidente 2026-10-09: se agotó el free tier del Cache (`FREE_USAGE_LIMIT_REACHED … Cache - Get`)
 * → sin token, TODA llamada a Zoho caía en 502 antes de tocar el CRM. Este proveedor:
 *  1. **memoiza el token a nivel contenedor** (instancia de módulo) → ~1 Cache GET cada 10 min,
 *     no uno por request;
 *  2. si el SDK falla, **refresca directo** contra Zoho Accounts con el mismo self-client y memoiza
 *     hasta 5 min antes del vencimiento.
 * El refresh directo es el FALLBACK, no el camino principal: Zoho limita los access tokens que se
 * acuñan por refresh token en una ventana corta, y el Cache del SDK es lo que comparte el token
 * entre contenedores. Al vencer la memo se vuelve a probar el SDK (se recupera solo si vuelve el Cache).
 */
import { describeThrown } from "./errors";

/** Credenciales del self-client (Environment Variables). Nunca se loguean. */
export interface ZohoSelfClientCreds {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** Default `https://accounts.zoho.com`. */
  accountsUrl?: string;
}

export interface ZohoTokenProviderOptions {
  /** Lectura LAZY de las creds (el proveedor vive a nivel módulo; el env se lee al usarlo). */
  selfClient: () => ZohoSelfClientCreds;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Aviso operativo cuando se cae al refresh directo (motivo del SDK, sin secretos). */
  onFallback?: (reason: string) => void;
}

/**
 * Vida de un token que vino del SDK: el SDK lo cachea con `expires_at = emisión + 45 min` y lo
 * sirve hasta ese momento → cualquier token que devuelve tiene ≥15 min de vida. 10 min es seguro.
 */
const PRIMARY_TTL_MS = 10 * 60_000;
/** Margen antes del vencimiento real de un token acuñado por el refresh directo. */
const DIRECT_MARGIN_SEC = 300;

export class ZohoTokenProvider {
  private memo: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ZohoTokenProviderOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /**
   * @param primary camino principal (connector del SDK); se pasa por llamada porque depende del
   *   `catalystApp` del request.
   */
  async getAccessToken(primary: () => Promise<string>): Promise<string> {
    if (this.memo && this.now() < this.memo.expiresAt) return this.memo.value;
    // Requests concurrentes del mismo contenedor comparten UNA resolución (no N refresh).
    this.inflight ??= this.resolve(primary).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async resolve(primary: () => Promise<string>): Promise<string> {
    let primaryReason: string;
    try {
      const value = await primary();
      this.memo = { value, expiresAt: this.now() + PRIMARY_TTL_MS };
      return value;
    } catch (e) {
      primaryReason = describeThrown(e);
    }
    this.opts.onFallback?.(primaryReason);
    try {
      const { value, expiresInSec } = await this.refreshDirect();
      this.memo = { value, expiresAt: this.now() + Math.max(60, expiresInSec - DIRECT_MARGIN_SEC) * 1000 };
      return value;
    } catch (e) {
      // Los dos caminos en el mensaje: el log dice por qué cayó el SDK Y por qué falló el directo.
      throw new Error(`SDK: ${primaryReason} · refresh directo: ${describeThrown(e)}`);
    }
  }

  /** POST /oauth/v2/token (grant refresh_token). Zoho responde 200 con `{error}` si la cred es inválida. */
  private async refreshDirect(): Promise<{ value: string; expiresInSec: number }> {
    const c = this.opts.selfClient();
    if (!c.clientId || !c.clientSecret || !c.refreshToken) {
      throw new Error("faltan ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN");
    }
    const accountsUrl = (c.accountsUrl || "https://accounts.zoho.com").replace(/\/$/, "");
    const res = await this.fetchFn(`${accountsUrl}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
      }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number | string;
      error?: string;
      error_description?: string;
    };
    if (!json.access_token) {
      // Solo `error`/`error_description` (p.ej. invalid_code, Access Denied por rate limit); nunca el body entero.
      const why = [json.error, json.error_description].filter(Boolean).join(": ") || "sin access_token";
      throw new Error(`HTTP ${res.status} ${why}`);
    }
    return { value: json.access_token, expiresInSec: Number(json.expires_in) || 3600 };
  }
}
