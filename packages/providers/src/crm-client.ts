/**
 * Puerto `CrmClient` — escritura en Zoho CRM (módulos Contacts + Deals; la Cuenta es
 * Accounts, una sola: la Cuenta "ML"). La auth la resuelve la FUNCIÓN (self-client a
 * nivel código — hay un bug de Catalyst Connection con el refresh token) y la pasa en
 * `CrmConnection`. El adapter nunca lee secretos por su cuenta.
 */
import { NotImplementedError } from "./errors";

/** Credenciales de runtime resueltas por la función. */
export interface CrmConnection {
  accessToken: string;
  /** Dominio de la API de Zoho (p.ej. https://www.zohoapis.com). */
  apiDomain: string;
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
}

/** Datos de la Oportunidad (Deal) a crear. `nroSolicitud` = External ID (`EXTERNAL_ID`). */
export interface CrmOpportunityData {
  nroSolicitud: number;
  /**
   * Cuenta (Account "ML") — del token, nunca del payload. OJO: Deals **no tiene
   * lookup a Accounts** en este CRM; la Cuenta cuelga del Contacto
   * (`Contacts.Account_Name`). Ver `docs/reference/crm-data-model.md` (CRM-Q3).
   */
  accountId: string;
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

export interface CrmClient {
  /** Dedup: busca Contacto por cédula. Null si no existe. */
  findContactByCedula(nroCedula: number, conn: CrmConnection): Promise<{ id: string } | null>;
  createContact(data: CrmContactData, conn: CrmConnection): Promise<{ id: string }>;
  createOpportunity(data: CrmOpportunityData, conn: CrmConnection): Promise<{ id: string }>;
}

/**
 * Mock determinístico para dev/test y para el e2e sin CRM real.
 * Dedup por cédula en memoria; misma cédula ⇒ mismo contactId (reuse).
 */
export class MockCrmClient implements CrmClient {
  private readonly contactsByCedula = new Map<number, string>();
  private seq = 0;

  async findContactByCedula(nroCedula: number, _conn: CrmConnection): Promise<{ id: string } | null> {
    const id = this.contactsByCedula.get(nroCedula);
    return id ? { id } : null;
  }

  async createContact(data: CrmContactData, _conn: CrmConnection): Promise<{ id: string }> {
    this.seq += 1;
    const id = `mock-contact-${this.seq}`;
    this.contactsByCedula.set(data.nroCedula, id);
    return { id };
  }

  async createOpportunity(_data: CrmOpportunityData, _conn: CrmConnection): Promise<{ id: string }> {
    this.seq += 1;
    return { id: `mock-opp-${this.seq}` };
  }
}

/**
 * Adapter real de Zoho CRM (REST v2). STUB — se implementa en E-02 con el **self-client**
 * (client_id/secret/refresh_token en env cifrada; el adapter renueva el access token).
 * Campos custom ya creados (ver `ZOHO_CRM_FIELDS`): `Cedula` en Contacts (ADR-0003),
 * `EXTERNAL_ID` en Deals (ADR-0002). Falta confirmar los API names de los módulos
 * estándar. Único lugar autorizado a HTTP a CRM.
 */
export class ZohoCrmClient implements CrmClient {
  async findContactByCedula(_nroCedula: number, _conn: CrmConnection): Promise<{ id: string } | null> {
    throw new NotImplementedError("ZohoCrmClient", "findContactByCedula");
  }

  async createContact(_data: CrmContactData, _conn: CrmConnection): Promise<{ id: string }> {
    throw new NotImplementedError("ZohoCrmClient", "createContact");
  }

  async createOpportunity(_data: CrmOpportunityData, _conn: CrmConnection): Promise<{ id: string }> {
    throw new NotImplementedError("ZohoCrmClient", "createOpportunity");
  }
}
