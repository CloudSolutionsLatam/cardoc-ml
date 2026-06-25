/**
 * Puerto `CrmClient` — escritura en Zoho CRM (Contactos + Oportunidades estándar:
 * módulos Contacts y Deals; la "Cuenta" es Accounts).
 *
 * La autenticación es Catalyst Connection (OAuth gestionado): la FUNCIÓN resuelve el
 * `accessToken` desde la Connection y lo pasa en `CrmConnection`. El adapter nunca
 * lee secretos por su cuenta.
 */
import type { ContactInput } from "@cardoc/domain";
import { NotImplementedError } from "./errors";

/** Credenciales de runtime resueltas por la función desde la Catalyst Connection. */
export interface CrmConnection {
  accessToken: string;
  /** Dominio de la API de Zoho (p.ej. https://www.zohoapis.com). */
  apiDomain: string;
}

export interface CrmCreateOpportunityInput {
  nombre: string;
  /** Cuenta (Account) del tenant — derivada del token, nunca del payload. */
  accountId: string;
  contactId: string;
  /** Estado fijo, fijado server-side. */
  stage: string;
  meta?: Record<string, unknown>;
}

export interface CrmClient {
  /** Dedup: busca Contacto por documento (CI/RUT). Null si no existe. */
  findContactByDocument(documento: string, conn: CrmConnection): Promise<{ id: string } | null>;
  createContact(input: ContactInput, conn: CrmConnection): Promise<{ id: string }>;
  createOpportunity(input: CrmCreateOpportunityInput, conn: CrmConnection): Promise<{ id: string }>;
}

/**
 * Mock determinístico para dev/test y para el thin-slice e2e sin CRM real.
 * Dedup por documento en memoria; mismo documento ⇒ mismo contactId (reuse).
 */
export class MockCrmClient implements CrmClient {
  private readonly contactsByDoc = new Map<string, string>();
  private seq = 0;

  async findContactByDocument(documento: string, _conn: CrmConnection): Promise<{ id: string } | null> {
    const id = this.contactsByDoc.get(documento);
    return id ? { id } : null;
  }

  async createContact(input: ContactInput, _conn: CrmConnection): Promise<{ id: string }> {
    this.seq += 1;
    const id = `mock-contact-${this.seq}`;
    this.contactsByDoc.set(input.documento, id);
    return { id };
  }

  async createOpportunity(_input: CrmCreateOpportunityInput, _conn: CrmConnection): Promise<{ id: string }> {
    this.seq += 1;
    return { id: `mock-opp-${this.seq}` };
  }
}

/**
 * Adapter real de Zoho CRM (REST v3). STUB — se implementa en E-02 una vez confirmada
 * la Connection y los API names de Contacts/Deals/Accounts. Aquí es el ÚNICO lugar
 * autorizado a hacer HTTP a CRM (fetch permitido por el lint solo en providers).
 */
export class ZohoCrmClient implements CrmClient {
  async findContactByDocument(_documento: string, _conn: CrmConnection): Promise<{ id: string } | null> {
    throw new NotImplementedError("ZohoCrmClient", "findContactByDocument");
  }

  async createContact(_input: ContactInput, _conn: CrmConnection): Promise<{ id: string }> {
    throw new NotImplementedError("ZohoCrmClient", "createContact");
  }

  async createOpportunity(_input: CrmCreateOpportunityInput, _conn: CrmConnection): Promise<{ id: string }> {
    throw new NotImplementedError("ZohoCrmClient", "createOpportunity");
  }
}
