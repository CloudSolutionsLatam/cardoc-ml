---
title: "Playbook — Secretos y Connections"
status: vigente
last_reviewed: 2026-06-25
---

# Secretos y Connections

Cómo cardoc-ml maneja credenciales y autenticación a Zoho. Tres reglas de oro, en orden de prioridad:

1. **Cero secretos en el repo.** Ni en commits, ni en historia, ni en `.env.example`.
2. **Los secretos viven en Catalyst Console → Environment Variables.** El runtime los lee; el repo no los conoce.
3. **La función resuelve credenciales en runtime, nunca el dominio ni la persistencia.** El DataStore guarda referencias (`secret_ref`), no valores.

> El que filtra un token, regala la batalla antes de pelearla. Acá no se filtra nada.

---

## 1. Cero secretos en repo — defensa en profundidad

Dos capas que se complementan: prevención (`.gitignore`) y detección (CI gate). Ninguna sustituye a la otra.

### Capa 1 — `.gitignore` (prevención)

[`/.gitignore`](../../.gitignore) bloquea todo lo que pueda cargar un secreto antes de que llegue al índice:

| Patrón | Qué protege |
|---|---|
| `.env` | Variables de entorno locales (dev). |
| `.env.*` con excepción `!.env.example` | Toda variante (`.env.local`, `.env.prod`) queda fuera; **solo** se versiona la plantilla. |
| `.catalystrc` | Binding local del proyecto Catalyst (IDs de proyecto/environment). Se versiona `.catalystrc.example`, nunca el real. |
| `.output/` | Salida del Catalyst CLI. |
| `apps/catalyst/functions/*/index.js[.map]` | Bundles esbuild generados en deploy. No se versionan (ver [monorepo-build-y-bundling](./monorepo-build-y-bundling.md)). |

La plantilla [`/.env.example`](../../.env.example) es la única fuente de verdad de **qué** variables existen. Su primera línea lo deja explícito:

```
# En Catalyst los secretos viven en Console → Environment Variables, NUNCA en el repo.
```

### Capa 2 — secret-scanning en CI (detección)

El workflow [`/.github/workflows/ci.yml`](../../.github/workflows/ci.yml) tiene un job dedicado `secret-scan` que corre **gitleaks** como gate (independiente del job `build`):

```yaml
secret-scan:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0           # historia completa, no solo el HEAD
    - name: gitleaks
      run: >
        docker run --rm -v "${{ github.workspace }}:/repo"
        ghcr.io/gitleaks/gitleaks:latest detect --source=/repo --redact --no-banner
```

Puntos accionables:

- **`fetch-depth: 0`** → escanea la **historia completa**, no solo el diff. Un secreto enterrado en un commit viejo también rompe el build.
- **`detect`** → modo escaneo de historia git (no `protect`/`stage`).
- **`--redact`** → los hallazgos salen redactados en el log; el secreto detectado no se re-expone en CI.
- Corre el **binario directo** (`docker run … gitleaks`), no el action wrapper, para evitar la licencia del wrapper.
- Es un **gate**: si gitleaks encuentra algo, el job falla y bloquea el merge.

### Si gitleaks rompe el build

1. **No** hagas un commit "fix" encima: el secreto sigue en la historia y el job (que lee `fetch-depth: 0`) lo seguirá viendo.
2. **Rotá el secreto inmediatamente** (asumilo comprometido) — ver §4 para tokens de consumidores, §3 para credenciales de Zoho.
3. Limpiá la historia (reescritura con filtro / `git filter-repo`) **⚠️ verificar** procedimiento con el owner antes de force-push a `main`.
4. Movelo a Catalyst Console → Environment Variables (§2) y referenciá por `secret_ref` (§2.2).

---

## 2. Dónde viven los secretos: Catalyst Console → Environment Variables

### 2.1 Modelo

- El **valor** del secreto se carga **una sola vez** en Catalyst Console → Environment Variables del environment correspondiente (Development / Production). **⚠️ verificar (consola)** la ruta exacta del menú y si las env vars son por-environment o por-función.
- En **runtime** la función lo lee vía `process.env["NOMBRE"]`. Ejemplo real en [`container.ts`](../../apps/catalyst/functions/api/src/container.ts):

  ```ts
  accessToken: process.env["ZOHO_CRM_ACCESS_TOKEN"] ?? "dev-token",
  apiDomain:   process.env["ZOHO_CRM_API_DOMAIN"]   ?? "https://www.zohoapis.com",
  ```

  El `?? "dev-token"` es **solo** el fallback de desarrollo local. En Production, `ZOHO_CRM_ACCESS_TOKEN` se resuelve desde la Catalyst Connection (ver §3), no desde una env var con el valor pegado.

> **Nota de higiene:** `ZOHO_CRM_ACCESS_TOKEN` **no** figura en [`/.env.example`](../../.env.example) —y está bien que no figure—. La plantilla solo declara `ZOHO_CRM_API_DOMAIN` y `ZOHO_CRM_CONNECTOR_NAME`. El access token nunca es una variable que un dev deba copiar a mano: lo provee la Connection. Mantener `.env.example` sin esa línea es parte del diseño.

### 2.2 Patrón `secret_ref` — el DataStore guarda la referencia, no el valor

Regla dura del modelo de datos: **ninguna tabla del DataStore almacena un secreto en claro.** Lo que se persiste es una *referencia* o un *derivado no reversible*:

| Caso | Qué se guarda | Qué NO se guarda |
|---|---|---|
| Token de API de un consumidor | `api_tokens.token_hash` (SHA-256, ver §4) | El token en claro. Imposible reconstruirlo desde el hash. |
| Credencial de Zoho CRM | El **nombre del conector** (`ZOHO_CRM_CONNECTOR_NAME`, p.ej. `zoho_crm_conn`) | El access/refresh token: los gestiona la Connection (§3). |

El principio `secret_ref`: cuando una entidad necesita "el secreto X", guarda **el identificador con el que pedirlo** (nombre de Connection, nombre de env var), y la resolución a valor ocurre en runtime, en la capa función. El esquema completo del DataStore está en [datastore-esquema](./datastore-esquema.md).

---

## 3. Auth a Zoho CRM vía Catalyst Connection (OAuth gestionado)

**Decisión confirmada (Nestor, 2026-06-25):** la autenticación a Zoho CRM es una **Catalyst Connection** — OAuth gestionado por la plataforma. cardoc **no** implementa el dance de OAuth ni guarda refresh tokens; eso es responsabilidad de Catalyst.

### 3.1 Cómo se modela en cardoc

La separación de responsabilidades es explícita y está codificada en los tipos. Cabecera de [`crm-client.ts`](../../packages/providers/src/crm-client.ts):

> La autenticación es Catalyst Connection (OAuth gestionado): la **FUNCIÓN** resuelve el `accessToken` desde la Connection y lo pasa en `CrmConnection`. El adapter **nunca** lee secretos por su cuenta.

El contrato que viaja al adapter es deliberadamente mínimo:

```ts
/** Credenciales de runtime resueltas por la función desde la Catalyst Connection. */
export interface CrmConnection {
  accessToken: string;
  /** Dominio de la API de Zoho (p.ej. https://www.zohoapis.com). */
  apiDomain: string;
}
```

Quién hace qué:

| Actor | Responsabilidad |
|---|---|
| **Catalyst Connection** | Mantiene el OAuth (refresh, expiración) contra Zoho. Fuente del access token. |
| **Capa función** ([`container.ts`](../../apps/catalyst/functions/api/src/container.ts)) | Resuelve `CrmConnection {accessToken, apiDomain}` por request y la inyecta en el container. |
| **Adapter** (`ZohoCrmClient` en `@cardoc/providers`) | Recibe `conn: CrmConnection` en cada método. Usa el token; **no** lo obtiene. Único lugar autorizado a hacer HTTP a CRM. |

Esto se ve en la firma de cada método del puerto `CrmClient` — la `conn` es un parámetro, no un estado interno del adapter:

```ts
findContactByCedula(nroCedula: number, conn: CrmConnection): Promise<{ id: string } | null>;
createContact(input: ContactInput, conn: CrmConnection): Promise<{ id: string }>;
createOpportunity(input: CrmCreateOpportunityInput, conn: CrmConnection): Promise<{ id: string }>;
```

### 3.2 La resolución en runtime

`buildContainer(req)` en [`container.ts`](../../apps/catalyst/functions/api/src/container.ts) arma la `CrmConnection` por request vía `resolveCrmConnection(...)`:

```ts
function resolveCrmConnection(_appOrReq: unknown): CrmConnection {
  return {
    accessToken: process.env["ZOHO_CRM_ACCESS_TOKEN"] ?? "dev-token",
    apiDomain:   process.env["ZOHO_CRM_API_DOMAIN"]   ?? "https://www.zohoapis.com",
  };
}
```

**Estado actual (E-02):** esta función todavía lee `ZOHO_CRM_ACCESS_TOKEN` de env (placeholder de dev). El comentario de la propia función lo deja anotado:

> El access token se resuelve por **self-client a nivel código** (`resolveZohoAccessToken`): el SDK renueva con `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`; override directo con `ZOHO_CRM_ACCESS_TOKEN` (dev).
>
> **Prueba local:** `pnpm zoho:check` (script en `scripts/`, fuera del runtime) refresca el token por HTTP directo (sin Catalyst) y ejerce el `ZohoCrmClient` contra el CRM real — READ-only por default; `--write` crea registros (requiere `CARDOC_TEST_ACCOUNT_ID`).

**⚠️ verificar (docs oficiales / consola):** la **API exacta del SDK Catalyst para obtener el access token de una Connection** en runtime (nombre del método, si toma el `app` de `catalyst.initialize(req)` y el nombre del conector `ZOHO_CRM_CONNECTOR_NAME`, manejo de refresh/expiración). Cuando se confirme, `resolveCrmConnection` reemplaza el `process.env[...] ?? "dev-token"` por la llamada real al conector. Es parte del de-risk de [OPERACIONES](../../OPERACIONES.md) y del setup de Connection OAuth (open question de plataforma).

### 3.3 Variables `ZOHO_CRM_*`

| Variable | En `.env.example` | Rol | Fuente del valor real |
|---|---|---|---|
| `ZOHO_CRM_API_DOMAIN` | Sí (`https://www.zohoapis.com`) | Dominio base de la API de Zoho. No es secreto. | Env var / Console. |
| `ZOHO_CRM_CONNECTOR_NAME` | Sí (`zoho_crm_conn`) | Nombre de la Catalyst Connection a consultar. No es secreto — es un `secret_ref`. | Env var / Console. |
| `ZOHO_CRM_ACCESS_TOKEN` | **No** | Placeholder de dev (fallback `?? "dev-token"`). En prod **no se usa** como valor pegado. | Catalyst Connection (§3.2). |

El switch de modo lo da `CARDOC_CRM_MODE`: `zoho` → `ZohoCrmClient` (HTTP real, requiere Connection); cualquier otro valor → `MockCrmClient` (dedup en memoria, sin red). Default en `.env.example`: `mock`.

> **Recordatorio de tenancy:** el `accountId` que va a la Connection y al CRM **siempre** sale del token del consumidor, nunca del payload ni del query. La `CrmConnection` lleva la credencial; el `accountId` lo lleva el caso de uso. Ver [CONTRATOS](../../CONTRATOS.md).

---

## 4. Rotación de tokens de API de consumidores

Los consumidores (automotoras) se autentican contra cardoc con un **X-Api-Key token** propio. Estos tokens son responsabilidad de cardoc, no de Zoho.

### 4.1 Solo se guarda el hash

`@cardoc/domain` expone `hashToken` / `generateToken` (Node puro, sin SDK). En el DataStore, la tabla `api_tokens` guarda **`token_hash`** (SHA-256), nunca el token en claro. Se ve sembrado en [`container.ts`](../../apps/catalyst/functions/api/src/container.ts):

```ts
memTokens.seed({
  tokenHash: hashToken(DEV_TOKEN),   // DEV_TOKEN = "test-token", solo dev/in-memory
  consumerId: DEV_CONSUMER,
  accountId: DEV_ACCOUNT,
  scopes: [...ALL_SCOPES],
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
});
```

Consecuencia operativa directa: **el token no es recuperable.** Si un consumidor lo pierde, no se "consulta": se rota (se emite uno nuevo). El `sha256` es unidireccional por diseño.

### 4.2 Procedimiento de rotación = crear nuevo + revocar viejo

La rotación **no** es un update in-place del token. Es dos pasos, en este orden, para no dejar al consumidor sin acceso durante el cambio:

| Paso | Acción | Efecto en `api_tokens` |
|---|---|---|
| 1 | **Generar** un token nuevo (`generateToken`) para el mismo `consumer_id` / `account_id`, con los mismos `scopes`. Entregarlo al consumidor por canal seguro. | Nueva fila con su `token_hash`, `revoked_at = null`. |
| 2 | El consumidor confirma que el nuevo funciona y corta el viejo. | **Revocar** el viejo: `revoked_at = <timestamp>`. |

Notas:

- Durante la ventana entre paso 1 y 2, **ambos** tokens son válidos (rotación sin downtime). Mantenela corta.
- **Revocar = `revoked_at`**, no borrar la fila. La auditoría y el `audit_log` (append-only) necesitan que el `consumer_id` siga resolviendo.
- `expires_at` permite caducidad programada; `last_used_at` ayuda a detectar tokens muertos candidatos a revocar.
- Un token **comprometido** (filtrado, detectado por gitleaks) se **revoca de inmediato** y se emite uno nuevo — el paso 2 va primero, asumiendo el viejo perdido.

### 4.3 Qué pasa en el pipeline

`authMiddleware` resuelve el X-Api-Key del header `X-Api-Key` hasheándolo (`hashToken`) y buscando la fila en `api_tokens`. Un token revocado (`revoked_at` no nulo) o expirado (`expires_at` pasado) → `UNAUTHENTICATED 401`, con el sobre de error único `{ error: { code, message, correlationId, details? } }`. El detalle del pipeline (orden de middlewares, scopes, caps) está en [ARQUITECTURA](../../ARQUITECTURA.md) y [CONTRATOS](../../CONTRATOS.md).

---

## 5. Checklist operativo

Antes de cada deploy / al onboard de un consumidor:

- [ ] No hay `.env`, `.catalystrc` ni `index.js` bundle trackeados (`git status` limpio en esos paths).
- [ ] CI `secret-scan` (gitleaks) en verde sobre el PR.
- [ ] Secretos de Zoho cargados en Catalyst Console del environment correcto, **no** en el repo. **⚠️ verificar** que la Connection `zoho_crm_conn` está configurada en el environment de destino.
- [ ] Tokens de consumidor: solo `token_hash` en `api_tokens`; el token en claro entregado por canal seguro y no persistido en ningún lado.
- [ ] Rotación pendiente: ¿hay tokens viejos sin `revoked_at` tras una rotación completada? Cerrarlos.

---

## Referencias

- Código: [`packages/providers/src/crm-client.ts`](../../packages/providers/src/crm-client.ts) · [`apps/catalyst/functions/api/src/container.ts`](../../apps/catalyst/functions/api/src/container.ts) · [`/.env.example`](../../.env.example) · [`/.gitignore`](../../.gitignore) · [`/.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- Docs: [Arquitectura](../../ARQUITECTURA.md) · [Contratos](../../CONTRATOS.md) · [Atributos de calidad](../../ATRIBUTOS-DE-CALIDAD.md) · [Operaciones](../../OPERACIONES.md) · [Plan de desarrollo](../../PLAN-DE-DESARROLLO.md)
- Playbooks: [Catalyst artefactos](./catalyst-artefactos.md) · [Monorepo build y bundling](./monorepo-build-y-bundling.md) · [Deploy y rollback](./deploy-y-rollback.md) · [DataStore esquema](./datastore-esquema.md)
- Índice de docs: [docs/README.md](../README.md) · raíz: [README.md](../../README.md)
