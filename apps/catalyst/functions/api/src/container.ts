/**
 * Composición de dependencias del API.
 *
 * Persistencia (`CARDOC_PERSISTENCE`): `datastore` → repos DataStore-backed
 * (`catalyst.initialize(req)` por request); default → in-memory singleton SEMBRADO
 * con consumidor/token de dev (Bearer `test-token`, todos los scopes, Cuenta `acc_dev`).
 *
 * CRM (`CARDOC_CRM_MODE`): `zoho` → ZohoCrmClient; default → MockCrmClient.
 * Informes (`CARDOC_REPORTS_MODE`): `creator` → ZohoCreatorReportsSource; default → Mock.
 *
 * Los adapters concretos (con SDK Catalyst / HTTP) viven en esta capa, NO en packages/*.
 */
import catalyst = require("zcatalyst-sdk-node");
import { ALL_SCOPES, hashToken } from "@cardoc/domain";
import {
  createCatalystRepositories,
  InMemoryAuditLogRepository,
  InMemoryCapRepository,
  InMemoryConsumersRepository,
  InMemoryOpportunitiesRepository,
  InMemoryTokensRepository,
  type AuditLogRepository,
  type CapRepository,
  type ConsumersRepository,
  type OpportunitiesRepository,
  type TokensRepository,
} from "@cardoc/persistence";
import {
  MockCrmClient,
  MockReportsSource,
  ZohoCreatorReportsSource,
  ZohoCrmClient,
  type CrmClient,
  type CrmConnection,
  type ReportsSource,
} from "@cardoc/providers";

const useDatastore = process.env["CARDOC_PERSISTENCE"] === "datastore";
const useZohoCrm = process.env["CARDOC_CRM_MODE"] === "zoho";
const useCreator = process.env["CARDOC_REPORTS_MODE"] === "creator";

const DEV_CONSUMER = "consumer_dev";
const DEV_ACCOUNT = "acc_dev";
const DEV_TOKEN = "test-token";

export interface ApiContainer {
  tokens: TokensRepository;
  consumers: ConsumersRepository;
  opportunities: OpportunitiesRepository;
  audit: AuditLogRepository;
  cap: CapRepository;
  crm: CrmClient;
  connection: CrmConnection;
  reports: ReportsSource;
}

// ── Singletons in-memory (modo dev/local), sembrados una vez ──────────────────
const memTokens = new InMemoryTokensRepository();
const memConsumers = new InMemoryConsumersRepository();
const memOpportunities = new InMemoryOpportunitiesRepository();
const memAudit = new InMemoryAuditLogRepository();
const memCap = new InMemoryCapRepository();
const memCrm = new MockCrmClient();
const memReports = new MockReportsSource();

if (!useDatastore) {
  memTokens.seed({
    tokenHash: hashToken(DEV_TOKEN),
    consumerId: DEV_CONSUMER,
    accountId: DEV_ACCOUNT,
    scopes: [...ALL_SCOPES],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  });
  memConsumers.seed({
    consumerId: DEV_CONSUMER,
    crmAccountId: DEV_ACCOUNT,
    name: "Automotora Dev",
    status: "active",
  });
}

/**
 * Conexión CRM de runtime. En `datastore` mode se resolverá el access token desde la
 * Catalyst Connection (OAuth gestionado, E-02); en dev es un stub.
 */
function resolveCrmConnection(_appOrReq: unknown): CrmConnection {
  return {
    accessToken: process.env["ZOHO_CRM_ACCESS_TOKEN"] ?? "dev-token",
    apiDomain: process.env["ZOHO_CRM_API_DOMAIN"] ?? "https://www.zohoapis.com",
  };
}

/** Repos + adapters por request: DataStore (si el flag está) o in-memory sembrado. */
export function buildContainer(req: unknown): ApiContainer {
  const crm: CrmClient = useZohoCrm ? new ZohoCrmClient() : memCrm;
  const reports: ReportsSource = useCreator ? new ZohoCreatorReportsSource() : memReports;

  if (useDatastore) {
    const app = catalyst.initialize(req as { [key: string]: unknown });
    const repos = createCatalystRepositories(app);
    return { ...repos, crm, connection: resolveCrmConnection(app), reports };
  }
  return {
    tokens: memTokens,
    consumers: memConsumers,
    opportunities: memOpportunities,
    audit: memAudit,
    cap: memCap,
    crm,
    connection: resolveCrmConnection(req),
    reports,
  };
}
