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
import { ReportNotReadyError, UpstreamError, describeThrown } from "./errors";

type FetchFn = typeof fetch;

/** Envelope de la Custom API: `{ code: 3000, result: {...} }` (planning.md §4.1). */
export interface CreatorEnvelope {
  code?: number;
  /** Texto del error que devuelve Creator junto a un `code` != 3000 (cuando lo manda). */
  message?: unknown;
  result?: (RawInspectionReport & { status?: number; error?: string; message?: unknown }) | null;
}

/**
 * ` "<mensaje>"` de un envelope/result de error de Creator, para el LOG (nunca para el consumidor):
 * acotado a 200 chars y sin URLs (podrían traer la publickey). `""` si no hay mensaje.
 */
export function describeCreatorMessage(o: { message?: unknown } | null | undefined): string {
  const raw = o?.message;
  if (raw == null || raw === "") return "";
  const text = (typeof raw === "string" ? raw : JSON.stringify(raw)).replace(/https?:\/\/\S+/g, "<url>");
  return ` "${text.slice(0, 200)}"`;
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
        throw new UpstreamError("creator", 502, `token OAuth Creator: ${describeThrown(e)}`);
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
      // El body de error de Creator (`{code, message}`) va al log: sin él no se distingue la causa.
      const body = (await res.json().catch(() => undefined)) as { code?: unknown; message?: unknown } | undefined;
      const detail =
        `GET_INSPECTION_REPORT_DETAIL HTTP ${res.status}` +
        (body && typeof body === "object" ? ` code=${String(body.code ?? "?")}${describeCreatorMessage(body)}` : "");
      // Creator procesó el pedido (respondió JSON) y rechazó ESTE informe → todavía no disponible.
      // Fuera de eso: auth (401/403), token de sesión (9430), rate limit, caídas/gateway → genérico.
      const functional =
        body != null && typeof body === "object" && String(body.code) !== "9430" &&
        ![401, 403, 429, 502, 503, 504].includes(res.status);
      if (functional) throw new ReportNotReadyError(res.status, detail);
      throw new UpstreamError("creator", res.status, detail);
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
 * Fotos más pesadas que esto se piden como VISTA PREVIA de WorkDrive en vez de bajar el original.
 * Las originales de cámara (12 MP) pesan ~2.8 MB; las capturadas desde la app ~0.3-0.7 MB, que siguen
 * bajando tal cual (sin achicarlas a 1536 px). ADR-0016.
 */
export const DEFAULT_WD_PREVIEW_ABOVE_BYTES = 1_500_000;
/** Lado pedido a la vista previa. WorkDrive acota a ~2046×1536 (una vertical sale 1152×1536). */
const WD_PREVIEW_PX = 1920;

/**
 * URL de la vista previa de WorkDrive para un link PÚBLICO de descarga
 * (`files-accl.<dominio>/public/workdrive-external/download/<id>` →
 * `previewengine-accl.<dominio>/image/WD/<id>?width=..&height=..`), o `null` si no es de WorkDrive.
 * ⚠️ `previewengine` es el servicio que usa el visor web de WorkDrive: **no documentado**. Devuelve un
 * JPEG reducido y YA ENDEREZADO (aplica la orientación EXIF) sin auth, igual que el link público.
 * Medido en 2117957 (2026-10-15): 122 fotos 336 MB → 48.9 MB, 0 fallas.
 */
export function toWorkDrivePreviewUrl(url: string, px = WD_PREVIEW_PX): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const id = /^\/public\/workdrive-external\/download\/([A-Za-z0-9]+)$/.exec(u.pathname)?.[1];
  if (!id || !u.hostname.startsWith("files-accl.")) return null;
  return `${u.protocol}//${u.hostname.replace(/^files-accl\./, "previewengine-accl.")}/image/WD/${id}?width=${px}&height=${px}`;
}

export interface PublicImageFetcherOptions {
  /** Timeout POR request (original o vista previa). */
  timeoutMs?: number;
  /** Desde qué tamaño (bytes) se usa la vista previa de WorkDrive. `null` = nunca (siempre originales). */
  previewAboveBytes?: number | null;
}

const isImage = (b: Uint8Array): boolean =>
  b.length > 3 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50));

/**
 * Fetcher de imágenes para embeber fotos en el PDF. Las URLs de las fotos son **públicas** (Nestor
 * 2026-07-01) → GET sin auth. Degrada a `null` ante cualquier fallo (el informe se genera igual,
 * con placeholder). No necesita OAuth.
 *
 * Fotos pesadas (ADR-0016): apenas llegan los headers del original, si pesa más que
 * `previewAboveBytes` se CANCELA su descarga y se pide la vista previa de WorkDrive (~0.4 MB, ya
 * reducida y derecha) — no se bajan ni se decodifican los 12 MP. Si la vista previa falla, se vuelve
 * al original (que el optimizador reduce con sharp, como antes).
 */
export function createPublicImageFetcher(fetchFn: FetchFn = fetch, opts: PublicImageFetcherOptions = {}): ImageFetcher {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const previewAbove = opts.previewAboveBytes === undefined ? DEFAULT_WD_PREVIEW_ABOVE_BYTES : opts.previewAboveBytes;
  // Timeout POR FOTO: sin él, una conexión colgada bloquea a su worker hasta la guillotina de la
  // plataforma (Advanced I/O corta TODO a los 30s) y un solo cuelgue mata la generación entera. Con
  // timeout, la foto colgada se omite (misma degradación que una foto caída).
  const get = (u: string) => fetchFn(u, { signal: AbortSignal.timeout(timeoutMs) });
  const getBytes = async (u: string): Promise<Uint8Array | null> => {
    const res = await get(u);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  };

  return async (url) => {
    try {
      const res = await get(url);
      if (!res.ok) return null;
      const size = Number(res.headers.get("content-length"));
      const previewUrl = previewAbove !== null && size > previewAbove ? toWorkDrivePreviewUrl(url) : null;
      if (!previewUrl) return new Uint8Array(await res.arrayBuffer());

      await res.body?.cancel().catch(() => undefined); // el original pesado NO se baja
      try {
        const preview = await getBytes(previewUrl);
        if (preview && isImage(preview)) return preview;
      } catch {
        // timeout / red → cae al original
      }
      console.warn("[pdf] vista previa de WorkDrive no disponible → se baja el original");
      return await getBytes(url);
    } catch {
      return null; // WorkDrive caído / timeout / archivo ilegible → sin foto, nunca rompe la generación
    }
  };
}
