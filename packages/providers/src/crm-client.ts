/**
 * Puerto `CrmClient` — escritura en Zoho CRM (módulos Contacts + Deals; la Cuenta es
 * Accounts, una sola: la Cuenta "ML"). La auth la resuelve la FUNCIÓN (self-client a
 * nivel código — hay un bug de Catalyst Connection con el refresh token) y la pasa en
 * `CrmConnection.getAccessToken()`. El adapter nunca lee secretos por su cuenta.
 */
import { UpstreamError } from "./errors";

/**
 * Conexión de runtime al CRM. La FUNCIÓN arma el resolvedor del token (self-client con el
 * SDK de Catalyst); el adapter solo lo invoca por llamada (lazy: no se pide token en
 * endpoints que no tocan CRM).
 */
export interface CrmConnection {
  /** Dominio de la API de Zoho (p.ej. https://www.zohoapis.com). */
  apiDomain: string;
  /** Devuelve un access token válido para el header `Zoho-oauthtoken`. */
  getAccessToken(): Promise<string>;
}

/**
 * api_names reales del CRM que usa el adapter (E-02), mapa de `payload ML → campo Zoho`.
 * Módulos y campos estándar confirmados contra el discovery del CRM (snapshot 2026-06-25);
 * los dos custom (`Cedula`, `EXTERNAL_ID`) los confirmó Nestor 2026-06-30 (posteriores al
 * dump, por eso no figuran en él). Detalle y caveats: `docs/reference/crm-data-model.md`.
 */
export const ZOHO_CRM_FIELDS = {
  /** api_names de módulo. */
  modules: { contacts: "Contacts", deals: "Deals", accounts: "Accounts", products: "Products" },
  /** Contacts — campos que escribe `createContact`. */
  contact: {
    cedula: "Cedula", //          custom — llave de dedup (ADR-0003)
    firstName: "First_Name",
    lastName: "Last_Name", //     único system_mandatory del módulo
    mobile: "Mobile", //          OJO: este CRM no tiene campo "Phone"
    email: "Email",
    account: "Account_Name", //   lookup → Accounts (así cuelga la Cuenta "ML")
  },
  /** Deals — campos que escribe `createOpportunity`. */
  deal: {
    name: "Deal_Name", //         system_mandatory
    stage: "Stage", //            system_mandatory; valor = FIXED_OPPORTUNITY_STAGE
    pipeline: "Pipeline", //      system_mandatory; valor = ZOHO_FIXED_PIPELINE
    contact: "Contact_Name", //   lookup → Contacts
    externalId: "EXTERNAL_ID", // custom ← NroSolicitud (ADR-0002)
    // Agenda (fase posterior): Inspector→Inspectores, Vehiculo→Products,
    // Fecha_y_hora_de_visita_programada, nota_agenda, Ciudad/Calle/N_mero/Estado.
  },
  /**
   * Informes Revisión — módulo del CRM que correlaciona el N.º de Solicitud externo con el
   * Análisis (Creator). Lo consulta la variante del PDF por NroSolicitud (D3b, mail Cardoc 2026-07-02).
   */
  informesRevision: {
    module: "Informes_Revision", //                 api_name del módulo (confirmar en discovery)
    nroSolicitudExterno: "Nro_Solicitud_Externo", // ✅ confirmado (Nestor 2026-07-02): campo de búsqueda
    analisisId: "Creator_Analisis_ID", //           ✅ confirmado (Nestor 2026-07-02): id del Análisis en Creator
  },
} as const;

/**
 * Pipeline fijo al crear el Deal (`Deals.Pipeline` es `system_mandatory`). Las solicitudes
 * AutoCheck viven en el pipeline **B2B**, cuyo flujo de stages es:
 * `Nueva Solicitud` → `Agendado B2B` → `Completado` → `Cerrado` | `Cancelado`.
 * OJO: el stage inicial `Nueva Solicitud` (= `FIXED_OPPORTUNITY_STAGE`) pertenece a ESTE
 * pipeline, NO al `Standard` (default) — crear el Deal con `Standard` + ese stage sería
 * inconsistente y Zoho lo rechaza. Confirmado vía `settings/pipeline` (Nestor 2026-06-30).
 */
export const ZOHO_FIXED_PIPELINE = "B2B" as const;

/** Datos del Contacto a crear (de lo que manda ML). Dedup por `nroCedula`. */
export interface CrmContactData {
  nroCedula: number;
  nombres: string;
  apellidos: string;
  celular?: string;
  /** Cuenta "ML" (del token) → se setea en `Account_Name` (así cuelga la Cuenta del Contacto). */
  accountId: string;
}

/**
 * Datos de la Oportunidad (Deal) a crear. `nroSolicitud` = External ID (`EXTERNAL_ID`).
 * NO lleva `accountId`: Deals **no tiene lookup a Accounts**; la Cuenta "ML" se asocia en
 * el Contacto (`Contacts.Account_Name`). Ver `docs/reference/crm-data-model.md` (CRM-Q3).
 */
export interface CrmOpportunityData {
  nroSolicitud: number;
  contactId: string;
  /** Estado fijo, fijado server-side. */
  stage: string;
  marca?: string;
  modelo?: string;
  anio?: number;
  matricula?: string;
  sucursal?: string;
  departamento?: string;
  ciudad?: string;
  direccion?: string;
  /** Identificador de empresa que mandó ML (informativo). */
  tenant?: string;
}

/** Resultado de un create en el CRM: id del registro + si ya existía (dedup del propio CRM). */
export interface CrmWriteResult {
  id: string;
  /** true si el registro ya existía y Zoho lo dedupeó (`DUPLICATE_DATA` por campo único). */
  duplicate: boolean;
}

export interface CrmClient {
  /** Dedup: busca Contacto por cédula. Null si no existe. */
  findContactByCedula(nroCedula: number, conn: CrmConnection): Promise<{ id: string } | null>;
  createContact(data: CrmContactData, conn: CrmConnection): Promise<CrmWriteResult>;
  createOpportunity(data: CrmOpportunityData, conn: CrmConnection): Promise<CrmWriteResult>;
  /**
   * Resuelve el id de Análisis (Creator) desde el N.º de Solicitud externo, buscando en el módulo
   * Informes Revisión del CRM. Null si no existe. (Variante del PDF por NroSolicitud, D3b.)
   */
  findAnalisisIdByNroSolicitud(nroSolicitudExterno: string, conn: CrmConnection): Promise<string | null>;
}

/**
 * Mock determinístico para dev/test y para el e2e sin CRM real.
 * Dedup por cédula en memoria; misma cédula ⇒ mismo contactId (reuse).
 */
export class MockCrmClient implements CrmClient {
  private readonly contactsByCedula = new Map<number, string>();
  private readonly dealsByExternalId = new Map<number, string>();
  private readonly analisisByNroSolicitud = new Map<string, string>();
  private seq = 0;

  /** Siembra la correlación NroSolicitud externo → id de Análisis (dev/test de la variante D3b). */
  seedInformeRevision(nroSolicitudExterno: string, analisisId: string): void {
    this.analisisByNroSolicitud.set(nroSolicitudExterno, analisisId);
  }

  async findContactByCedula(nroCedula: number, _conn: CrmConnection): Promise<{ id: string } | null> {
    const id = this.contactsByCedula.get(nroCedula);
    return id ? { id } : null;
  }

  async findAnalisisIdByNroSolicitud(nroSolicitudExterno: string, _conn: CrmConnection): Promise<string | null> {
    return this.analisisByNroSolicitud.get(nroSolicitudExterno) ?? null;
  }

  async createContact(data: CrmContactData, _conn: CrmConnection): Promise<CrmWriteResult> {
    const existing = this.contactsByCedula.get(data.nroCedula);
    if (existing) return { id: existing, duplicate: true };
    this.seq += 1;
    const id = `mock-contact-${this.seq}`;
    this.contactsByCedula.set(data.nroCedula, id);
    return { id, duplicate: false };
  }

  async createOpportunity(data: CrmOpportunityData, _conn: CrmConnection): Promise<CrmWriteResult> {
    // Dedup por EXTERNAL_ID (simula el DUPLICATE_DATA de Zoho con campo único).
    const existing = this.dealsByExternalId.get(data.nroSolicitud);
    if (existing) return { id: existing, duplicate: true };
    this.seq += 1;
    const id = `mock-opp-${this.seq}`;
    this.dealsByExternalId.set(data.nroSolicitud, id);
    return { id, duplicate: false };
  }
}

// ── Adapter real: Zoho CRM REST v2 ───────────────────────────────────────────

type FetchFn = typeof fetch;
type FetchResponse = Awaited<ReturnType<FetchFn>>;

/** Respuesta de los endpoints de escritura (`POST /crm/v2/<Module>`). */
interface ZohoWriteResponse {
  data?: Array<{
    code?: string;
    message?: string;
    /** En éxito trae `id`; en error (p.ej. INVALID_DATA) trae `api_name` del campo culpable. */
    details?: { id?: string; api_name?: string; [key: string]: unknown };
    /** En `DUPLICATE_DATA`, el registro existente que disparó el duplicado. */
    duplicate_record?: { id?: string };
  }>;
}
/** Respuesta del endpoint de búsqueda (`GET /crm/v2/<Module>/search`). */
interface ZohoSearchResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Compone la `nota_agenda` del Deal con el vehículo + sucursal que manda ML — CRM-Q4: el
 * vehículo NO se modela como `Products`, va como texto. Omite los campos vacíos; devuelve
 * `""` si no hay nada (el adapter entonces no manda el campo).
 */
export function composeNotaAgenda(data: CrmOpportunityData): string {
  const vehiculo = [data.marca, data.modelo, data.anio].filter(Boolean).join(" ");
  const ubicacion = [data.ciudad, data.departamento].filter(Boolean).join(", ");
  return [
    vehiculo && `Vehículo: ${vehiculo}`,
    data.matricula && `Matrícula: ${data.matricula}`,
    data.sucursal && `Sucursal: ${data.sucursal}`,
    ubicacion && `Ubicación: ${ubicacion}`,
    data.direccion && `Dirección: ${data.direccion}`,
    data.tenant && `Tenant ML: ${data.tenant}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Opciones del adapter; `fetchFn` se inyecta en tests. */
export interface ZohoCrmClientOptions {
  fetchFn?: FetchFn;
}

/**
 * Adapter real de Zoho CRM (REST v2). Auth vía `conn.getAccessToken()` (self-client que
 * arma la función). Mapea el payload de ML a los api_names de `ZOHO_CRM_FIELDS`
 * (ver `docs/reference/crm-data-model.md`). Único lugar autorizado a HTTP a CRM.
 */
export class ZohoCrmClient implements CrmClient {
  private readonly fetchFn: FetchFn;
  constructor(opts: ZohoCrmClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async findContactByCedula(nroCedula: number, conn: CrmConnection): Promise<{ id: string } | null> {
    const { contact, modules } = ZOHO_CRM_FIELDS;
    const id = await this.searchFirstId(modules.contacts, `(${contact.cedula}:equals:${nroCedula})`, conn);
    return id ? { id } : null;
  }

  async findAnalisisIdByNroSolicitud(nroSolicitudExterno: string, conn: CrmConnection): Promise<string | null> {
    const ir = ZOHO_CRM_FIELDS.informesRevision;
    if (!ir.analisisId) {
      // Guard: el api_name del campo que referencia el Análisis aún no está confirmado (mail Cardoc / OQ).
      // Sin él no se puede resolver el id — se corta acá en vez de armar una query rota.
      throw new Error("Informes_Revision.analisisId: api_name pendiente de confirmar (variante PDF por NroSolicitud)");
    }
    const record = await this.searchFirstRecord(ir.module, `(${ir.nroSolicitudExterno}:equals:${nroSolicitudExterno})`, conn);
    const raw = record?.[ir.analisisId];
    return raw != null && String(raw).length > 0 ? String(raw) : null;
  }

  async createContact(data: CrmContactData, conn: CrmConnection): Promise<CrmWriteResult> {
    const f = ZOHO_CRM_FIELDS.contact;
    const record: Record<string, unknown> = {
      [f.lastName]: data.apellidos,
      [f.firstName]: data.nombres,
      [f.cedula]: String(data.nroCedula), // `Cedula` es campo TEXT en Zoho (no number)
      [f.account]: { id: data.accountId },
    };
    if (data.celular) record[f.mobile] = data.celular;
    return this.createRecord(ZOHO_CRM_FIELDS.modules.contacts, record, conn);
  }

  async createOpportunity(data: CrmOpportunityData, conn: CrmConnection): Promise<CrmWriteResult> {
    const f = ZOHO_CRM_FIELDS.deal;
    const record: Record<string, unknown> = {
      [f.name]: `ML ${data.nroSolicitud}`,
      [f.pipeline]: ZOHO_FIXED_PIPELINE,
      [f.stage]: data.stage,
      [f.contact]: { id: data.contactId },
      [f.externalId]: String(data.nroSolicitud), // externo/BIGINT siempre como string
    };
    const nota = composeNotaAgenda(data);
    if (nota) record["nota_agenda"] = nota;
    return this.createRecord(ZOHO_CRM_FIELDS.modules.deals, record, conn);
  }

  /** GET /<module>/search?criteria=... → id del primer match (204 → null). */
  private async searchFirstId(module: string, criteria: string, conn: CrmConnection): Promise<string | null> {
    const url = `${crmBase(conn)}/${module}/search?criteria=${encodeURIComponent(criteria)}`;
    const res = await this.request(url, { method: "GET" }, conn);
    if (res.status === 204) return null; // Zoho devuelve 204 cuando no hay coincidencias
    if (!res.ok) throw new UpstreamError("crm", res.status, `${module}/search HTTP ${res.status}`);
    const json = await parseCrmJson<ZohoSearchResponse>(res);
    const id = json.data?.[0]?.id;
    return id ? String(id) : null;
  }

  /** GET /<module>/search?criteria=... → primer registro completo (204 → null). */
  private async searchFirstRecord(module: string, criteria: string, conn: CrmConnection): Promise<Record<string, unknown> | null> {
    const url = `${crmBase(conn)}/${module}/search?criteria=${encodeURIComponent(criteria)}`;
    const res = await this.request(url, { method: "GET" }, conn);
    if (res.status === 204) return null;
    if (!res.ok) throw new UpstreamError("crm", res.status, `${module}/search HTTP ${res.status}`);
    const json = await parseCrmJson<{ data?: Array<Record<string, unknown>> }>(res);
    return json.data?.[0] ?? null;
  }

  private async createRecord(
    module: string,
    record: Record<string, unknown>,
    conn: CrmConnection,
  ): Promise<CrmWriteResult> {
    const res = await this.request(
      `${crmBase(conn)}/${module}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: [record] }) },
      conn,
    );
    // Zoho responde por-registro; parseamos el body (tolerando no-JSON) para leer el code real.
    const json = await parseCrmJson<ZohoWriteResponse>(res).catch(() => undefined);
    const row = json?.data?.[0];
    // Idempotencia de la BASE: si el campo único (EXTERNAL_ID) ya existe, Zoho responde
    // DUPLICATE_DATA con el registro existente → lo tratamos como "ya existía" (no error).
    const dupId = row?.duplicate_record?.id ?? row?.details?.id;
    if (row?.code === "DUPLICATE_DATA" && dupId) {
      return { id: String(dupId), duplicate: true };
    }
    if (!res.ok || row?.code !== "SUCCESS" || !row?.details?.id) {
      const detail = row?.details ? ` ${JSON.stringify(row.details)}` : "";
      const reason = row?.code ? `${row.code}${row.message ? `: ${row.message}` : ""}${detail}` : `HTTP ${res.status}`;
      throw new UpstreamError("crm", res.status, `${module} create rechazado (${reason})`);
    }
    return { id: String(row.details.id), duplicate: false };
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    conn: CrmConnection,
  ): Promise<FetchResponse> {
    const token = await conn.getAccessToken();
    try {
      return await this.fetchFn(url, {
        method: init.method,
        headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(init.headers ?? {}) },
        body: init.body,
      });
    } catch (e) {
      // fetch global NO lanza por 4xx/5xx; un throw acá es de red/DNS/timeout.
      throw new UpstreamError("crm", 0, `red CRM: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function crmBase(conn: CrmConnection): string {
  return `${conn.apiDomain}/crm/v2`;
}

/** Zoho a veces devuelve `{code,message}` con HTTP 200 → exigir content-type JSON. */
async function parseCrmJson<T>(res: FetchResponse): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new UpstreamError("crm", res.status, `CRM respuesta no-JSON (${ct || "sin content-type"})`);
  }
  return (await res.json()) as T;
}
