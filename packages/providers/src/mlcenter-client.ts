/**
 * Puerto `MlCenterClient` — integración OUTBOUND con ML (plataforma MLCenter /
 * "Mi Auto"·"TuAuto", mlcenter.com.uy, producto AutoCheck). cardoc le notifica los
 * cambios de estado de la solicitud AutoCheck.
 *
 * Contrato (doc API AutoCheck v1.1 — docs/reference/API_ENDPOINT_ACTUALIZAR_ESTADO_AUTOCHECK.md):
 *  - Auth: POST {base}/api/login/authenticatecardoc { Usuario, Password } -> { Status, Token } (JWT, 1h).
 *  - POST {base}/api/autocheck/estado/actualizar (Bearer)
 *      { NroSolicitud, Estado, NombreTecnico, Empresa, LinkResultado?, Observaciones? }.
 *  - v1.1: `NombreTecnico` y `Empresa` son OBLIGATORIOS en toda actualización.
 *  - Estados: PENDIENTE (inicial) -> COORDINACIÓN -> FINALIZADO (terminal). LinkResultado obligatorio en FINALIZADO.
 *  - Anti-duplicados: re-actualizar al MISMO estado -> 400 (no reintentable). Errores 4xx = validación/
 *    transición/duplicado (cliente); 5xx = falla real del upstream (reintentable). El adapter propaga el
 *    httpStatus para que el use-case distinga 400 (invalid/422) de 5xx (error/502).
 *
 * Es el ÚNICO lugar (junto al resto de providers) autorizado a HTTP externo.
 */
import { UpstreamError } from "./errors";

/** Estados que cardoc emite hacia ML. PENDIENTE = inicial (Deal en "Nueva Solicitud"). */
export type MlEstado = "PENDIENTE" | "COORDINACIÓN" | "FINALIZADO";

export interface MlCenterConfig {
  /** Base del API, p.ej. https://www.mlcenter.com.uy/apimiauto (prod) o .../ApiMiAutoTesting (testing). */
  baseUrl: string;
  usuario: string;
  password: string;
}

export interface UpdateEstadoInput {
  /** Nº de solicitud AutoCheck = External ID de la Oportunidad. */
  nroSolicitud: number;
  estado: MlEstado;
  /** Técnico que realiza el chequeo (obligatorio en v1.1). El use-case lo garantiza no vacío. */
  nombreTecnico: string;
  /** Empresa que realiza el chequeo (obligatorio en v1.1). El use-case lo garantiza no vacío. */
  empresa: string;
  /** Obligatorio si estado === "FINALIZADO" (URL del resultado/informe). */
  linkResultado?: string;
  observaciones?: string;
}

export interface MlCenterClient {
  updateEstado(input: UpdateEstadoInput): Promise<{ nroSolicitud: number; estado: string }>;
}

/** Mock para dev/test y para el thin-slice sin red. Registra las llamadas. */
export class MockMlCenterClient implements MlCenterClient {
  readonly calls: UpdateEstadoInput[] = [];
  async updateEstado(input: UpdateEstadoInput): Promise<{ nroSolicitud: number; estado: string }> {
    this.calls.push(input);
    return { nroSolicitud: input.nroSolicitud, estado: input.estado };
  }
}

/**
 * Adapter de INSPECCIÓN: NO llama a ML. Loggea (console.log → logs de la función Catalyst) el
 * **payload exacto** que `MlCenterHttpClient` le POSTearía a AutoCheck, para ver qué manda cardoc
 * cuando el CRM dispara un cambio de estado. Devuelve éxito. Se activa con `CARDOC_ML_MODE=log`.
 */
export class LoggingMlCenterClient implements MlCenterClient {
  readonly calls: UpdateEstadoInput[] = [];
  async updateEstado(input: UpdateEstadoInput): Promise<{ nroSolicitud: number; estado: string }> {
    this.calls.push(input);
    // Mismo shape que el POST real a /api/autocheck/estado/actualizar (PascalCase de AutoCheck).
    const payload: Record<string, unknown> = {
      NroSolicitud: input.nroSolicitud,
      Estado: input.estado,
      NombreTecnico: input.nombreTecnico,
      Empresa: input.empresa,
    };
    if (input.linkResultado) payload["LinkResultado"] = input.linkResultado;
    if (input.observaciones) payload["Observaciones"] = input.observaciones;
    console.log(`[ml-notify] (log-mode) payload que se enviaría a ML: ${JSON.stringify(payload)}`);
    return { nroSolicitud: input.nroSolicitud, estado: input.estado };
  }
}

interface AuthResponse {
  Status?: string;
  Token?: string;
  Mensaje?: string;
}
interface EstadoResponse {
  nroSolicitud?: number;
  estado?: string;
  mensaje?: string;
}
/** Sobre de error de AutoCheck v1.1: `{ codigo, mensaje, detalles[] }`. */
interface EstadoErrorResponse {
  codigo?: number;
  mensaje?: string;
  detalles?: string[];
}

/**
 * Adapter HTTP real. Cachea el JWT (~1h) y lo renueva ante 401.
 * ✅ Validado contra el sandbox de ML testing (2026-07-15): login `{Status:"OK",Token}` (200),
 * `COORDINACIÓN` aceptada (200 `{mensaje,nroSolicitud,estado}`), y anti-duplicados (mismo estado →
 * 400 `{codigo,mensaje,detalles[]}`) → el use-case lo mapea a 422. Falta el impacto real en prod.
 */
export class MlCenterHttpClient implements MlCenterClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: MlCenterConfig) {}

  private async authenticate(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAt - 60_000) {
      return this.token.value;
    }
    const res = await fetch(`${this.cfg.baseUrl}/api/login/authenticatecardoc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Usuario: this.cfg.usuario, Password: this.cfg.password }),
    });
    if (!res.ok) {
      throw new UpstreamError("mlcenter", res.status, "login a ML falló");
    }
    const body = (await res.json()) as AuthResponse;
    if (body.Status !== "OK" || !body.Token) {
      throw new UpstreamError("mlcenter", res.status, body.Mensaje || "login a ML sin token");
    }
    this.token = { value: body.Token, expiresAt: now + 3_600_000 };
    return body.Token;
  }

  async updateEstado(input: UpdateEstadoInput): Promise<{ nroSolicitud: number; estado: string }> {
    const token = await this.authenticate();
    const payload: Record<string, unknown> = {
      NroSolicitud: input.nroSolicitud,
      Estado: input.estado,
      NombreTecnico: input.nombreTecnico,
      Empresa: input.empresa,
    };
    if (input.linkResultado) payload["LinkResultado"] = input.linkResultado;
    if (input.observaciones) payload["Observaciones"] = input.observaciones;

    const res = await fetch(`${this.cfg.baseUrl}/api/autocheck/estado/actualizar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      this.token = null; // token vencido/ inválido → forzar re-login en el próximo intento
      throw new UpstreamError("mlcenter", 401, "no autorizado en ML");
    }
    if (!res.ok) {
      // v1.1: 400 = validación / transición inválida / mismo estado (anti-duplicados). El sobre trae
      // `detalles[]` con el motivo. Se preserva el httpStatus real: el use-case mapea 400 → invalid (422,
      // NO reintentable) y el resto (5xx) → error (502, reintentable). El mensaje se arma con los detalles.
      const err = (await res.json().catch(() => ({}))) as EstadoErrorResponse;
      const detalle = err.detalles?.length ? err.detalles.join("; ") : err.mensaje;
      throw new UpstreamError("mlcenter", res.status, detalle || "ML rechazó la actualización de estado");
    }
    const ok = (await res.json()) as EstadoResponse;
    return { nroSolicitud: ok.nroSolicitud ?? input.nroSolicitud, estado: ok.estado ?? input.estado };
  }
}
