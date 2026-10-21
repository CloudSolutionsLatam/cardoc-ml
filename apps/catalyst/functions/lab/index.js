/**
 * Función de LABORATORIO de plataforma (Development y Production).
 *
 * Mide si una función Advanced I/O de Catalyst puede subir archivos pesados a WorkDrive dentro de
 * la ventana de 30 s, y cuánto tarda cada tramo. Es el camino del write-back del PDF (OQ-N8).
 * Resultados del 2026-10-21 en OPERACIONES.md §lab.
 *
 * APAGADA por defecto: sin `LAB_ENABLED=1` responde 404 a todo (no se distingue de no existir).
 * Prendida, exige el header `x-lab-secret` == env `LAB_SECRET` (secreto PROPIO, no el del webhook).
 * Env vars de la función (en Catalyst son por función): LAB_ENABLED, LAB_SECRET, ZOHO_CLIENT_ID,
 * ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN. Memoria de la función: 512 MB (con 256 muere desde 25 MB).
 *
 *   GET  /env                                → qué env vars ve la función (solo nombres) + runtime
 *   POST /upload?mb=N&mode=simple|multipart|stream → arma N MB incompresibles y los sube a WorkDrive
 *        (simple = FormData/Blob · multipart = mismo endpoint, multipart a mano en stream, sin copias
 *         · stream = API de stream upload, requiere un scope que el self-client no tiene)
 *        &cleanup=1  (default)                → manda el archivo a la papelera al terminar
 *        &budget=27000                        → corta la subida a los N ms para devolver un resultado
 *                                               en vez del 408 opaco del gateway
 *   POST /alloc?mb=N&copies=k                → solo memoria, sin red (dónde muere la función)
 *
 * Única dependencia: `zcatalyst-sdk-node` (token por el conector + Cache). Se materializa como
 * node_modules real con `npm run deploy:prep` (en esta carpeta) antes de deployar; `lab` está fuera
 * del workspace de pnpm.
 */
"use strict";

const crypto = require("node:crypto");

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const WD_API = "https://www.zohoapis.com/workdrive/api/v1";
const WD_STREAM = "https://upload.zoho.com/workdrive-api/v1/stream/upload";
// Carpeta "cardoc-ml-lab" en My Folders de la cuenta del self-client (creada 2026-10-21).
const DEFAULT_PARENT = "3hbg9b4976167692d4e23994a42e1ffcc1ad4";
/** Tope de la subida simple de WorkDrive (más arriba pide la API de stream, sin scope). */
const MAX_MB = 250;

/** Compara el secreto en tiempo constante. */
function secretMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pico de RSS observado durante el pedido (MB). */
let peakRss = 0;
function sampleRss() {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

/*
 * Token de Zoho. Zoho Accounts permite 10 pedidos de token cada 10 min POR CLIENT, y este self-client
 * es el mismo que usa `api` en prod. Por eso, igual que `api` (container.ts):
 *   1. Camino principal: conector del SDK de Catalyst (`zoho_crm_conn`), que guarda el token en el
 *      Cache de Catalyst compartido por todos los contenedores del entorno.
 *   2. Respaldo: refresh directo, memoizado por contenedor y en pausa 10 min tras un fallo.
 */
const CONNECTOR = process.env.ZOHO_CRM_CONNECTOR_NAME || "zoho_crm_conn";
/** Cuánto se reusa en memoria un token que vino del SDK (el SDK lo vence a los 45 min). */
const SDK_MEMO_MS = 10 * 60 * 1000;
let cachedToken = null;
let refreshBlockedUntil = 0;

async function sdkToken(req) {
  const catalyst = require("zcatalyst-sdk-node");
  return catalyst
    .initialize(req)
    .connection({
      [CONNECTOR]: {
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        auth_url: `${ACCOUNTS}/oauth/v2/auth`,
        refresh_url: `${ACCOUNTS}/oauth/v2/token`,
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      },
    })
    .getConnector(CONNECTOR)
    .getAccessToken();
}

/** Devuelve `{ value, source }`; `source` = memo | sdk | direct, y `sdkError` si el SDK falló. */
async function accessToken(req) {
  if (cachedToken && cachedToken.exp > Date.now()) return { value: cachedToken.value, source: "memo" };
  let sdkError;
  try {
    const value = await sdkToken(req);
    cachedToken = { value, exp: Date.now() + SDK_MEMO_MS };
    return { value, source: "sdk" };
  } catch (e) {
    // El SDK rechaza con objetos planos {statusCode, code, message}, no con Error.
    sdkError = String(e?.message || e?.code || JSON.stringify(e)).slice(0, 200);
    console.warn(`[lab] SDK/Cache falló (${sdkError}) → refresh directo`);
  }
  return { ...(await directToken()), sdkError };
}

async function directToken() {
  if (refreshBlockedUntil > Date.now()) throw new Error(`refresh en pausa hasta ${new Date(refreshBlockedUntil).toISOString()}`);
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID || "",
      client_secret: process.env.ZOHO_CLIENT_SECRET || "",
      refresh_token: process.env.ZOHO_REFRESH_TOKEN || "",
    }),
  });
  const j = await r.json();
  if (!j.access_token) {
    refreshBlockedUntil = Date.now() + 10 * 60 * 1000;
    throw new Error(`refresh falló: ${j.error || r.status}`);
  }
  cachedToken = { value: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return { value: j.access_token, source: "direct" };
}

/** N MB incompresibles (como un PDF de fotos JPEG): bloques de 1 MB aleatorios distintos. */
function makePayload(mb) {
  const buf = Buffer.allocUnsafe(mb * 1024 * 1024);
  for (let off = 0; off < buf.length; off += 1024 * 1024) crypto.randomFillSync(buf, off, 1024 * 1024);
  return buf;
}

async function uploadSimple(token, parent, name, buf, signal) {
  const form = new FormData();
  form.append("filename", name);
  form.append("parent_id", parent);
  form.append("override-name-exist", "true");
  form.append("content", new Blob([buf], { type: "application/pdf" }), name);
  return fetch(`${WD_API}/upload`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    body: form,
    signal,
  });
}

/**
 * Mismo endpoint que `uploadSimple`, pero el multipart se arma a mano y se manda como stream sobre el
 * buffer original (en tramos de 1 MB): sin las copias que hacen Blob/FormData. Content-Length explícito.
 */
async function uploadMultipartStream(token, parent, name, buf, signal) {
  const boundary = `----cardoclab${crypto.randomBytes(12).toString("hex")}`;
  const field = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  const head = Buffer.from(
    field("filename", name) +
      field("parent_id", parent) +
      field("override-name-exist", "true") +
      `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const CHUNK = 1024 * 1024;
  let off = -1; // -1 = cabecera, luego el archivo por tramos, al final el cierre
  const body = new ReadableStream({
    pull(ctrl) {
      if (off === -1) { ctrl.enqueue(head); off = 0; return; }
      if (off < buf.length) { ctrl.enqueue(buf.subarray(off, off + CHUNK)); off += CHUNK; return; }
      ctrl.enqueue(tail);
      ctrl.close();
    },
  });
  return fetch(`${WD_API}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(head.length + buf.length + tail.length),
    },
    body,
    duplex: "half",
    signal,
  });
}

async function uploadStream(token, parent, name, buf, signal) {
  return fetch(WD_STREAM, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.length),
      "x-filename": encodeURIComponent(name),
      "x-parent_id": parent,
      "upload-id": crypto.randomUUID(),
      "x-streammode": "1",
      "x-override-name-exist": "true",
    },
    body: buf,
    signal,
  });
}

/** Saca el id del archivo de cualquiera de las dos formas de respuesta de WorkDrive. */
function fileIdOf(j) {
  const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
  return d?.attributes?.resource_id || d?.id || null;
}

async function trash(token, id) {
  const r = await fetch(`${WD_API}/files/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { attributes: { status: "51" }, type: "files" } }),
  });
  return r.status;
}

async function handleUpload(req, url, res) {
  const t0 = Date.now();
  peakRss = 0;
  const mb = Number(url.searchParams.get("mb") || 10);
  const UPLOADERS = { simple: uploadSimple, multipart: uploadMultipartStream, stream: uploadStream };
  const mode = UPLOADERS[url.searchParams.get("mode")] ? url.searchParams.get("mode") : "simple";
  const cleanup = url.searchParams.get("cleanup") !== "0";
  const budget = Number(url.searchParams.get("budget") || 27000);
  const parent = url.searchParams.get("parent") || DEFAULT_PARENT;
  if (!Number.isFinite(mb) || mb <= 0 || mb > MAX_MB) return send(res, 422, { error: `mb fuera de rango (1..${MAX_MB})` });

  const out = { mb, mode, budgetMs: budget };
  const tk = await accessToken(req);
  const token = tk.value;
  out.tokenSource = tk.source;
  if (tk.sdkError) out.sdkError = tk.sdkError;
  out.tokenMs = Date.now() - t0;

  let t = Date.now();
  const buf = makePayload(mb);
  out.genMs = Date.now() - t;
  sampleRss();

  // La subida corta a `budget` ms (medido desde el inicio del pedido) para no comernos el 408.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, budget - (Date.now() - t0)));
  const rssTimer = setInterval(sampleRss, 250);
  const name = `lab-${mode}-${mb}MB-${Date.now()}.pdf`;
  t = Date.now();
  try {
    const r = await UPLOADERS[mode](token, parent, name, buf, ctrl.signal);
    const text = await r.text();
    out.uploadMs = Date.now() - t;
    out.uploadStatus = r.status;
    out.mbPerSec = Number((mb / (out.uploadMs / 1000)).toFixed(2));
    let j = null;
    try { j = JSON.parse(text); } catch { /* respuesta no JSON */ }
    out.fileId = fileIdOf(j);
    if (!r.ok) out.uploadError = (j?.errors?.[0]?.title || text).slice(0, 300);
  } catch (e) {
    out.uploadMs = Date.now() - t;
    out.uploadError = ctrl.signal.aborted ? `abortado por budget tras ${out.uploadMs} ms` : String(e?.message || e);
  } finally {
    clearTimeout(timer);
    clearInterval(rssTimer);
  }
  sampleRss();

  if (cleanup && out.fileId) {
    t = Date.now();
    out.trashStatus = await trash(token, out.fileId);
    out.trashMs = Date.now() - t;
  }
  out.peakRssMB = Math.round(peakRss / 1048576);
  out.totalMs = Date.now() - t0;
  console.log("[lab]", JSON.stringify(out));
  send(res, 200, out);
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://lab");
    const secret = process.env.LAB_SECRET;
    if (process.env.LAB_ENABLED !== "1") return send(res, 404, { error: "ruta desconocida" });
    // Prendida sin secreto: se distingue del secreto equivocado (solo revela que falta la env var).
    if (!secret) return send(res, 503, { error: "LAB_SECRET no configurado en la función lab" });
    if (!secretMatches(req.headers["x-lab-secret"], secret)) return send(res, 401, { error: "x-lab-secret inválido" });
    const path = url.pathname.replace(/^\/server\/lab/, "") || "/";

    if (req.method === "GET" && path === "/env") {
      const names = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ACCOUNTS_URL", "LAB_SECRET"];
      return send(res, 200, {
        node: process.version,
        present: Object.fromEntries(names.map((n) => [n, Boolean(process.env[n])])),
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        heapLimitMB: Math.round(require("node:v8").getHeapStatistics().heap_size_limit / 1048576),
      });
    }
    if (req.method === "POST" && path === "/upload") return await handleUpload(req, url, res);
    // Solo memoria, sin red: arma N MB y `copies` copias más (lo que hace FormData/Blob al subir).
    if (req.method === "POST" && path === "/alloc") {
      const mb = Math.min(Number(url.searchParams.get("mb") || 10), MAX_MB);
      const copies = Math.min(Number(url.searchParams.get("copies") || 0), 4);
      const t = Date.now();
      const keep = [makePayload(mb)];
      for (let i = 0; i < copies; i++) keep.push(Buffer.from(keep[0]));
      const rssMB = Math.round(process.memoryUsage().rss / 1048576);
      return send(res, 200, { mb, copies, rssMB, ms: Date.now() - t, held: keep.length });
    }
    return send(res, 404, { error: "ruta desconocida" });
  } catch (e) {
    console.error("[lab] error", e);
    return send(res, 500, { error: String(e?.message || e) });
  }
};
