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

/** Datos del Contacto a crear (de lo que manda ML). Dedup por `nroCedula`. */
export interface CrmContactData {
  nroCedula: number;
  nombres: string;
  apellidos: string;
  celular?: string;
}

/** Datos de la Oportunidad (Deal) a crear. `nroSolicitud` = External ID. */
export interface CrmOpportunityData {
  nroSolicitud: number;
  /** Cuenta (Account "ML") — del token, nunca del payload. */
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
 * (client_id/secret/refresh_token en env cifrada; el adapter renueva el access token) una
 * vez confirmados los API names de Contacts/Deals/Accounts y los campos custom
 * (`Cedula` en Contacts, External ID en Deals). Único lugar autorizado a HTTP a CRM.
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
