/**
 * Use-case: listar Informes de Revisión de la Cuenta autenticada (GET /v1/informes).
 *
 * El `accountId` lo agrega el backend desde el token; el consumidor no puede elegir Cuenta.
 */
import type { InformeRevision, ListInformesQuery, Page } from "@cardoc/domain";
import type { ReportsSource } from "@cardoc/providers";

export function listInformes(
  accountId: string,
  query: ListInformesQuery,
  deps: { reports: ReportsSource },
): Promise<Page<InformeRevision>> {
  return deps.reports.listByAccount(accountId, query);
}
