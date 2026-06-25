/**
 * Puerto `MlCenterClient` — integración OUTBOUND con ML (plataforma MLCenter /
 * "Mi Auto"·"TuAuto", mlcenter.com.uy, producto AutoCheck). cardoc le notifica los
 * cambios de estado de la solicitud AutoCheck.
 *
 * Contrato (doc API AutoCheck v1.0):
 *  - Auth: POST {base}/api/login/authenticatecardoc { Usuario, Password } -> { Status, Token } (JWT, 1h).
 *  - POST {base}/api/autocheck/estado/actualizar (Bearer) { NroSolicitud, Estado, LinkResultado?, Observaciones? }.
 *  - Estados: COORDINACIÓN -> FINALIZADO (terminal). LinkResultado obligatorio en FINALIZADO.
 *
 * Es el ÚNICO lugar (junto al resto de providers) autorizado a HTTP externo.
 */
import { UpstreamError } from "./errors";

/** Estados que cardoc emite hacia ML (PENDIENTE es el inicial del lado de ML). */
export type MlEstado = "COORDINACIÓN" | "FINALIZADO";

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

/**
 * Adapter HTTP real. Cachea el JWT (~1h) y lo renueva ante 401. STUB-grade: implementado
 * según el doc del endpoint pero AÚN SIN PROBAR contra el sandbox de ML (faltan credenciales).
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
      const err = (await res.json().catch(() => ({}))) as EstadoResponse;
      throw new UpstreamError("mlcenter", res.status, err.mensaje || "ML rechazó la actualización de estado");
    }
    const ok = (await res.json()) as EstadoResponse;
    return { nroSolicitud: ok.nroSolicitud ?? input.nroSolicitud, estado: ok.estado ?? input.estado };
  }
}
