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
 * Config de conexión a Creator/WorkDrive (Environment Variables). ⚠️ Los valores exactos
 * (URL REST de la Custom API, si aplica `public_key` u OAuth, dominio de descarga de WorkDrive)
 * se confirman con el admin de Creator antes de activar `CARDOC_REPORTS_MODE=creator`.
 */
export interface CreatorConnection {
  /** ⚠️ URL REST de `GET_INSPECTION_REPORT_DETAIL` server-to-server. */
  reportDetailUrl: string;
  /** ⚠️ public_key de la Custom API (si el acceso server-to-server la usa). */
  publicKey: string;
  /** OAuth (self-client) para descargar archivos de WorkDrive. */
  getAccessToken(): Promise<string>;
}

/**
 * Fetcher REST del detalle del informe. ⚠️ Arma la URL con los params documentados en §5.1
 * (`id`, `portalType`, `publickey`); el `token` de sesión de portal NO aplica server-to-server
 * (a confirmar con qué se reemplaza). Config-driven — no hay URL hardcodeada.
 */
export function createReportDetailFetcher(conn: CreatorConnection, fetchFn: FetchFn = fetch): ReportDetailFetcher {
  return async (id, portalType) => {
    const q = new URLSearchParams({ id, portalType });
    if (conn.publicKey) q.set("publickey", conn.publicKey);
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(`${conn.reportDetailUrl}?${q.toString()}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
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
 * Fetcher de imágenes de WorkDrive (para embeber fotos en el PDF). GET autenticado con OAuth;
 * degrada a `null` ante cualquier fallo (el informe se genera igual, con placeholder). ⚠️ el
 * mecanismo de descarga exacto de WorkDrive (URL directa vs API `/files/{id}/content`) se confirma.
 */
export function createWorkDriveImageFetcher(conn: CreatorConnection, fetchFn: FetchFn = fetch): ImageFetcher {
  return async (url) => {
    try {
      const token = await conn.getAccessToken();
      const res = await fetchFn(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null; // WorkDrive caído / archivo ilegible → sin foto, nunca rompe la generación
    }
  };
}
