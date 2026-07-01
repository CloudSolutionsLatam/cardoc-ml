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
  type CatalystAppLike,
  type ConsumersRepository,
  type OpportunitiesRepository,
  type TokensRepository,
} from "@cardoc/persistence";
import {
  MockCrmClient,
  MockMlCenterClient,
  MockReportsSource,
  MlCenterHttpClient,
  ZohoCreatorReportsSource,
  ZohoCrmClient,
  type CrmClient,
  type CrmConnection,
  type MlCenterClient,
  type ReportsSource,
} from "@cardoc/providers";

const useDatastore = process.env["CARDOC_PERSISTENCE"] === "datastore";
const useZohoCrm = process.env["CARDOC_CRM_MODE"] === "zoho";
const useCreator = process.env["CARDOC_REPORTS_MODE"] === "creator";
const useMlHttp = process.env["CARDOC_ML_MODE"] === "http";

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
  /** Cliente OUTBOUND a ML (MLCenter/AutoCheck) — notificación de cambios de estado. */
  mlCenter: MlCenterClient;
}

// ── Singletons in-memory (modo dev/local), sembrados una vez ──────────────────
const memTokens = new InMemoryTokensRepository();
const memConsumers = new InMemoryConsumersRepository();
const memOpportunities = new InMemoryOpportunitiesRepository();
const memAudit = new InMemoryAuditLogRepository();
const memCap = new InMemoryCapRepository();
const memCrm = new MockCrmClient();
const memReports = new MockReportsSource();

// Cliente ML (singleton: el adapter HTTP cachea el JWT ~1h). Mock por defecto.
const mlCenter: MlCenterClient = useMlHttp
  ? new MlCenterHttpClient({
      baseUrl: process.env["MLCENTER_BASE_URL"] ?? "https://www.mlcenter.com.uy/ApiMiAutoTesting",
      usuario: process.env["MLCENTER_USER"] ?? "",
      password: process.env["MLCENTER_PASSWORD"] ?? "",
    })
  : new MockMlCenterClient();

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

const ZOHO_CONNECTOR = process.env["ZOHO_CRM_CONNECTOR_NAME"] ?? "zoho_crm_conn";

/**
 * Conexión CRM de runtime. Arma el resolvedor LAZY del access token (no se pide token si
 * el request no toca CRM). El token se obtiene por **self-client a nivel código** (la
 * Catalyst Connection tiene un bug que no genera refresh token). Secretos en Environment
 * Variables (`ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`); ver secretos-y-connections.md.
 */
function resolveCrmConnection(catalystApp: unknown): CrmConnection {
  // Memoiza el token por request (buildContainer corre por request): findContact +
  // createContact + createOpportunity comparten una sola resolución.
  let tokenPromise: Promise<string> | undefined;
  return {
    apiDomain: process.env["ZOHO_CRM_API_DOMAIN"] ?? "https://www.zohoapis.com",
    getAccessToken: () => (tokenPromise ??= resolveZohoAccessToken(catalystApp)),
  };
}

async function resolveZohoAccessToken(catalystApp: unknown): Promise<string> {
  // Override directo (testing local / token de corta vida) — evita el SDK.
  const direct = process.env["ZOHO_CRM_ACCESS_TOKEN"];
  if (direct) return direct;
  // Self-client: el SDK de Catalyst renueva el access token con las creds en env vars.
  const app = catalystApp as {
    connection(cfg: Record<string, unknown>): {
      getConnector(name: string): { getAccessToken(): Promise<string> };
    };
  };
  return app
    .connection({
      [ZOHO_CONNECTOR]: {
        client_id: process.env["ZOHO_CLIENT_ID"],
        client_secret: process.env["ZOHO_CLIENT_SECRET"],
        auth_url: "https://accounts.zoho.com/oauth/v2/auth",
        refresh_url: "https://accounts.zoho.com/oauth/v2/token",
        refresh_token: process.env["ZOHO_REFRESH_TOKEN"],
      },
    })
    .getConnector(ZOHO_CONNECTOR)
    .getAccessToken();
}

/** Repos + adapters por request: DataStore (si el flag está) o in-memory sembrado. */
export function buildContainer(req: unknown): ApiContainer {
  const crm: CrmClient = useZohoCrm ? new ZohoCrmClient() : memCrm;
  // Fail-fast: en modo zoho sin DataStore (no hay app Catalyst para el self-client) hace
  // falta el token directo. Sin esto, getAccessToken() reventaría TARDE (tras sembrar el
  // row pending), envenenando el NroSolicitud. Síncrono → lo captura attachContainer → 500.
  if (useZohoCrm && !useDatastore && !process.env["ZOHO_CRM_ACCESS_TOKEN"]) {
    throw new Error(
      "CARDOC_CRM_MODE=zoho en modo memory requiere ZOHO_CRM_ACCESS_TOKEN " +
        "(o CARDOC_PERSISTENCE=datastore para resolver el token con el self-client del SDK).",
    );
  }
  const reports: ReportsSource = useCreator ? new ZohoCreatorReportsSource() : memReports;

  if (useDatastore) {
    // El runtime NO provee el SDK: se externaliza en el bundle y se shippea como node_modules
    // real (scripts/deploy-prep-sdk.mjs). Se carga LAZY acá (en memory mode no se requiere). ADR-0010.
    const catalyst = require("zcatalyst-sdk-node") as { initialize(req: unknown): CatalystAppLike };
    const app = catalyst.initialize(req);
    const repos = createCatalystRepositories(app);
    return { ...repos, crm, connection: resolveCrmConnection(app), reports, mlCenter };
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
    mlCenter,
  };
}
