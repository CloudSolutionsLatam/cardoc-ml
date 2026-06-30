// Chequeo manual del adapter ZohoCrmClient contra el CRM REAL, usando las credenciales
// self-client del .env. Vive en la CAPA DE SCRIPTS, no en el runtime (el runtime resuelve
// el token con el SDK de Catalyst; acá hacemos el refresh por HTTP directo para poder probar
// desde la máquina, sin Catalyst). Requiere build previo (lo hace `pnpm zoho:check`).
//
// Uso:
//   pnpm zoho:check            # READ-only: refresca token + busca (prueba auth/scopes/conectividad)
//   pnpm zoho:check --write    # además CREA Contacto + Oportunidad REALES en el CRM
//
// --write requiere CARDOC_TEST_ACCOUNT_ID = id de la Cuenta "ML" (p.ej. 6687138000031320073).
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { ZohoCrmClient } = require(resolve(root, "packages/providers/dist/index.js"));
const { FIXED_OPPORTUNITY_STAGE } = require(resolve(root, "packages/domain/dist/index.js"));

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`✗ Falta la variable de entorno ${k} (definila en .env)`);
    process.exit(1);
  }
  return v;
};

const clientId = need("ZOHO_CLIENT_ID");
const clientSecret = need("ZOHO_CLIENT_SECRET");
const refreshToken = need("ZOHO_REFRESH_TOKEN");
const apiDomain = process.env.ZOHO_CRM_API_DOMAIN ?? "https://www.zohoapis.com";
const accountsUrl = process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com";
const write = process.argv.includes("--write");

// Refresh self-client (grant_type=refresh_token) — HTTP directo a Zoho Accounts.
async function refreshAccessToken() {
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`refresh HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`Zoho no devolvió access_token: ${text}`);
  return json.access_token;
}

// Payload de ejemplo (el mismo del smoke).
const ej = { NroCedula: 45321890, NroSolicitud: 908812, Nombres: "Juan Carlos", Apellidos: "Pérez Rodríguez", Celular: "099123456", Marca: "Chevrolet", Modelo: "Onix", Anio: 2022, Matricula: "SBA1234" };

try {
  console.log(`CRM check → apiDomain=${apiDomain} · modo=${write ? "WRITE (crea registros REALES)" : "READ-only"}\n`);

  const accessToken = await refreshAccessToken();
  console.log("✓ refresh_token → access_token OK (auth/scopes válidos)\n");

  const conn = { apiDomain, getAccessToken: async () => accessToken };
  const crm = new ZohoCrmClient();

  const contactoExistente = await crm.findContactByCedula(ej.NroCedula, conn);
  console.log(`  findContactByCedula(${ej.NroCedula}) →`, contactoExistente);

  if (!write) {
    console.log(
      "\n✓ READ-only OK (auth + scopes + conectividad). El dedup del Deal por EXTERNAL_ID se prueba al crear; para el alta real: pnpm zoho:check --write",
    );
    process.exit(0);
  }

  const accountId = need("CARDOC_TEST_ACCOUNT_ID");
  console.log(`\n⚠️  WRITE: creando Contacto + Oportunidad REALES bajo la Cuenta ${accountId}…`);
  const contact =
    contactoExistente ??
    (await crm.createContact(
      { nroCedula: ej.NroCedula, nombres: ej.Nombres, apellidos: ej.Apellidos, celular: ej.Celular, accountId },
      conn,
    ));
  // contact viene de findContactByCedula ({id}) o de createContact ({id, duplicate}).
  const contactReused = Boolean(contactoExistente) || contact.duplicate === true;
  console.log("  Contacto →", contact.id, contactReused ? "(reusado)" : "(creado)");
  // La dedup del Deal la hace el CRM: createOpportunity devuelve {id, duplicate} (DUPLICATE_DATA por EXTERNAL_ID).
  const opp = await crm.createOpportunity(
    {
      nroSolicitud: ej.NroSolicitud,
      contactId: contact.id,
      stage: FIXED_OPPORTUNITY_STAGE,
      marca: ej.Marca,
      modelo: ej.Modelo,
      anio: ej.Anio,
      matricula: ej.Matricula,
    },
    conn,
  );
  console.log("  Oportunidad →", opp.id, opp.duplicate ? "(ya existía por EXTERNAL_ID — DUPLICATE_DATA)" : "(creada)");
  console.log("\n✓ alta real OK — verificá el Contacto + la Oportunidad en el CRM.");
} catch (e) {
  console.error("\n✗ FALLÓ:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
