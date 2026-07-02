/**
 * Cliente HTTP server-to-server de Zoho Creator + WorkDrive (para `ZohoCreatorReportsSource`).
 *
 * ⚠️ cardoc-ml es SERVER-SIDE: **no** puede usar el SDK cliente `ZOHO.CREATOR.DATA.invokeCustomApi`
 * del portal (planning.md §5.1). Accede por **REST + OAuth** (self-client), único lugar autorizado
 * a HTTP (providers). El portal invoca la Custom API `GET_INSPECTION_REPORT_DETAIL` con `public_key`
 * + un `token` de sesión de portal; para cardoc-ml el **endpoint REST exacto y el mecanismo de auth
 * server-to-server** (public_key solo, u OAuth, y qué reemplaza al `token` de sesión) están **por
 * confirmar** — por eso todo es CONFIG-DRIVEN (`CreatorConnection`, desde Environment Variables) y
 * va marcado ⚠️. La LÓGICA (envelope, defensa portalType, transform, generación, fetch de fotos)
 * es firme y testeable; solo la URL/auth se cablea cuando se confirmen.
 */
import type { RawInspectionReport } from "./report-transform";
import type { ImageFetcher } from "./pdf-generator";
import { UpstreamError } from "./errors";

type FetchFn = typeof fetch;

/** Envelope de la Custom API: `{ code: 3000, result: {...} }` (planning.md §4.1). */
export interface CreatorEnvelope {
  code?: number;
  result?: (RawInspectionReport & { status?: number; error?: string }) | null;
}

/** Trae el envelope crudo del informe por id (+ portalType). Inyectable para tests. */
export type ReportDetailFetcher = (id: string, portalType: string) => Promise<CreatorEnvelope>;

/**
 * Config de conexión a Creator (Environment Variables). Formato de la Custom API REST **verificado
 * en vivo (2026-07-01)** contra el endpoint real de cardoc:
 *   `https://www.zohoapis.com/creator/custom/cardoc/GET_INSPECTION_REPORT_DETAIL?publickey=<clave>&id=..&portalType=ml`
 * (sin segmento de versión; auth **Public Key** = param `publickey` en la URL — probado: sin key →
 * 401; con key → la API procesa; no requiere token de sesión). El "Endpoint URL" (con la key) se
 * copia VERBATIM de la consola a `CREATOR_REPORT_DETAIL_URL` (una sola var; la key NO va en el repo).
 *
 * `authMode`: hoy **publickey** (la key viaja en la URL). A futuro **oauth** — reconfigurar la Custom
 * API a OAuth2 y usar el MISMO self-client de tokens que el CRM (`getAccessToken`).
 */
export interface CreatorConnection {
  /** Endpoint URL de la Custom API, VERBATIM de la consola (en modo publickey ya incluye `?publickey=...`).
   *  cardoc-ml le agrega `id` + `portalType`. */
  reportDetailUrl: string;
  /** "publickey" (default; la key va en la URL) | "oauth" (Authorization con el self-client del CRM). */
  authMode?: "publickey" | "oauth";
  /** Acuña el `token` de sesión que la Custom API exige (mini-JWT AES; ver creator-token.ts). Si se
   *  provee, el fetcher lo agrega como query param `token`. Sin él, la función Deluge devuelve 9430. */
  mintToken?: () => string;
  /** Access token OAuth (self-client — el MISMO gestor que el CRM). Solo se usa en `authMode: "oauth"`. */
  getAccessToken(): Promise<string>;
}

/**
 * Fetcher REST del detalle del informe. Reproduce lo que hace `invokeCustomApi` del portal, pero
 * server-to-server: GET a la Custom API con `id` + `portalType`. Auth por `authMode`: publickey (en
 * la URL) u oauth (header `Zoho-oauthtoken`, mismo self-client del CRM). Config-driven, sin URL hardcodeada.
 */
export function createReportDetailFetcher(conn: CreatorConnection, fetchFn: FetchFn = fetch): ReportDetailFetcher {
  return async (id, portalType) => {
    let url: URL;
    try {
      url = new URL(conn.reportDetailUrl);
    } catch {
      throw new UpstreamError("creator", 502, "CREATOR_REPORT_DETAIL_URL ausente o inválida");
    }
    url.searchParams.set("id", id);
    url.searchParams.set("portalType", portalType);
    if (conn.mintToken) url.searchParams.set("token", conn.mintToken()); // token de sesión (evita el 9430)
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (conn.authMode === "oauth") {
      // OAuth2: mismo gestor de tokens que el CRM (self-client). Requiere la Custom API en modo OAuth.
      try {
        headers["Authorization"] = `Zoho-oauthtoken ${await conn.getAccessToken()}`;
      } catch (e) {
        throw new UpstreamError("creator", 502, `token OAuth Creator: ${(e as Error).message}`);
      }
    }
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(url.toString(), { method: "GET", headers });
    } catch (e) {
      // Rechazo de red (DNS/ECONNREFUSED/timeout) → 502, no un Error crudo (que daría 500 opaco).
      throw new UpstreamError("creator", 502, `GET_INSPECTION_REPORT_DETAIL red: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new UpstreamError("creator", res.status, `GET_INSPECTION_REPORT_DETAIL HTTP ${res.status}`);
    }
    // Body no-JSON / vacío / `null` (Zoho puede devolver una página de error con HTTP 200) → 502.
    try {
      const env = (await res.json()) as CreatorEnvelope | null;
      if (env == null || typeof env !== "object") throw new Error("body no-JSON");
      return env;
    } catch {
      throw new UpstreamError("creator", 502, "GET_INSPECTION_REPORT_DETAIL body no-JSON");
    }
  };
}

/**
 * Fetcher de imágenes para embeber fotos en el PDF. Las URLs de las fotos son **públicas** (Nestor
 * 2026-07-01) → GET sin auth. Degrada a `null` ante cualquier fallo (el informe se genera igual,
 * con placeholder). No necesita OAuth.
 */
export function createPublicImageFetcher(fetchFn: FetchFn = fetch): ImageFetcher {
  return async (url) => {
    try {
      const res = await fetchFn(url);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null; // WorkDrive caído / archivo ilegible → sin foto, nunca rompe la generación
    }
  };
}
