---
title: ADRs — cardoc-ml (log de decisiones de arquitectura)
status: active
document_type: decision-log
last_reviewed: 2026-06-30
---

# Decisiones de arquitectura (ADR log)

Log **canónico** de decisiones de arquitectura de cardoc-ml. Versión simplificada del
sistema de ADRs del ERP: un solo archivo, una entrada corta por decisión. Una decisión
aceptada es **irreversible sin una nueva ADR** que la supersede.

Convención: si una ADR crece o necesita discusión extensa, se separa a su propio
`docs/decisions/00XX-titulo.md` y acá queda el resumen + link. Mientras tanto, viven inline.

`ARQUITECTURA.md §10` muestra el resumen en tabla; **este archivo es la fuente canónica**
(con contexto y consecuencia). Las preguntas sin cerrar van en
[`../OPEN-QUESTIONS.md`](../OPEN-QUESTIONS.md).

| ADR | Decisión | Estado |
|-----|----------|--------|
| [0001](#adr-0001) | Catalyst como gateway de control delante de Zoho | Aceptada |
| [0002](#adr-0002) | Idempotencia en 2 capas: `X-Idempotency-Key` opcional (Catalyst) + `EXTERNAL_ID`=NroSolicitud único (CRM) | Aceptada (revisado) |
| [0003](#adr-0003) | Dedup de Contacto por `NroCedula` (campo Cedula custom en Contacts) | Aceptada |
| [0004](#adr-0004) | Auth a Zoho CRM vía self-client OAuth (SDK); la Catalyst Connection tenía bug de refresh token | Aceptada (revisado) |
| [0005](#adr-0005) | Cross-tenant → 404 (no 403) | Aceptada |
| [0006](#adr-0006) | `accountId` siempre del token | Aceptada |
| [0007](#adr-0007) | Auditoría on-finish, 1 registro/request, append-only | Aceptada |
| [0008](#adr-0008) | Adapter de streaming/SDK en la capa function | Aceptada |
| [0009](#adr-0009) | HTTP externo solo en `packages/providers` | Aceptada |
| [0010](#adr-0010) | Bundle esbuild: inlina todo salvo `zcatalyst-sdk-node`, que se externaliza Y se shippea como `node_modules` real (el runtime no lo provee) | Aceptada (revisado en smoke) |
| [0011](#adr-0011) | Contadores de cap in-memory por ahora | Aceptada (provisional) |
| [0012](#adr-0012) | PDF: resolución perezosa con caché en Creator/WorkDrive | Aceptada (mecanismo de generación pendiente) |
| [0013](#adr-0013) | Integración OUTBOUND a ML (CRM workflow → función Catalyst) | Aceptada |
| [0014](#adr-0014) | Auth del consumidor por header `X-Api-Key` (Catalyst reserva `Authorization`) | Aceptada |
| [0015](#adr-0015) | `GET /v1/informes` (listado) descartado — ML es push (outbound E-07), no pull | Aceptada |

> Confirmadas por Nestor Toñanez, 2026-06-25.

---

## ADR-0001
**Catalyst como gateway de control delante de Zoho.** El DataStore guarda *control*
(tokens, idempotencia, auditoría, caps), no negocio.
- **Contexto:** el negocio vive en Zoho (CRM = relación comercial, Creator = Informes). Zoho no provee auth scoped por consumidor, idempotencia, cap ni auditoría uniforme.
- **Consecuencia:** el gateway centraliza el control y deja a Zoho como sistema de registro. Ver `apps/catalyst/functions/api/`.
- **Descartado:** CRM/Creator como única capa, sin gateway.

## ADR-0002
**Idempotencia en DOS capas** (defensa en profundidad). El POST no crea dos Oportunidades vía dos
mecanismos complementarios, porque cardoc es un middleware entre sistemas externos (ML) y la base
real (Zoho CRM).
- **Estado:** Aceptada — **implementado** (revisa la idea previa de un único header obligatorio / único anclaje en el body).
- **Contexto:** ML manda `NroSolicitud` (único) en el body y, **opcionalmente**, un header `X-Idempotency-Key`.
- **Consecuencia:**
  - **Capa 1 — middleware (Catalyst):** SOLO si llega `X-Idempotency-Key` (ese header ES la clave, NO el
    `NroSolicitud`). Row en `crm_opportunities` (`UNIQUE(idempotency_key)` **single-column** — la UI de Catalyst
    no permite UNIQUE compuesto; `account_id` se filtra en la query como defensa de tenancy — + `payload_fingerprint`),
    consultado **antes** de tocar Zoho → replay → `200 duplicate`; misma clave + payload distinto → `409`. Fast-path que evita el roundtrip al CRM.
  - **Capa 2 — base (Zoho CRM):** SIEMPRE. `EXTERNAL_ID` = `NroSolicitud` es **único** en Deals; al recrear,
    Zoho responde `DUPLICATE_DATA` con el id existente → el adapter lo devuelve como `duplicate` (no error).
    Dedup del Contacto por cédula. Es la verdad durable.
  - Sin header, la Capa 1 se omite y la Capa 2 es la única autoridad (sin detección de payload-distinto →
    eso es exclusivo de la Capa 1). Ver `create-opportunity-contact.ts` + `providers/src/crm-client.ts`.
- **Descartado:** un `X-Idempotency-Key` **obligatorio** (ML no siempre lo manda) y depender **solo** del
  middleware (se perdería la dedup si el DataStore se resetea — por eso la Capa 2 en el CRM).

## ADR-0003
**Dedup de Contacto por `NroCedula`.**
- **Estado:** Aceptada — **implementado** (revisa "Email" y "Documento", ambos descartados).
- **Contexto:** el payload de ML trae `NroCedula` pero **no trae email** (confirmado por mail); y el módulo `Contacts` no tiene campo documento. La cédula es la identidad estable que sí llega.
- **Consecuencia:** `findContactByCedula` antes de crear; si existe, se reutiliza. Usa el **campo custom `Cedula`** en Contacts (creado en CRM — Nestor 2026-06-30). Ver `packages/providers/src/crm-client.ts`.
- **Descartado:** email (ML no lo manda) / teléfono.

## ADR-0004
**Auth a Zoho CRM = self-client OAuth resuelto por el SDK de Catalyst** (NO la Catalyst Connection de consola).
- **Estado:** Aceptada — **revisado tras el deploy real (2026-06-30)**: la *Catalyst Connection* de consola tenía un bug que no generaba refresh token → se resuelve por **self-client a nivel código**.
- **Contexto:** llamar a CRM requiere OAuth con refresh token; no queremos el dance a mano ni secretos hardcodeados.
- **Consecuencia:** las credenciales del self-client (`ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN`) viven en **Environment Variables** de Catalyst; en runtime el SDK las usa vía `app.connection({...}).getConnector().getAccessToken()` (resolución **lazy** y memoizada por request). Override directo `ZOHO_CRM_ACCESS_TOKEN` para testing/token corto. El `accessToken` resuelto llega al adapter como `CrmConnection`; nunca se hardcodea. Ver `container.ts` y [`../playbooks/secretos-y-connections.md`](../playbooks/secretos-y-connections.md).
- **Descartado:** la Catalyst Connection de consola (bug de refresh token); token estático en código; OAuth dance a mano en el adapter.

## ADR-0005
**Cross-tenant → 404** (no 403). 403 queda reservado a falta de scope.
- **Contexto:** un token de la automotora A pide un recurso de B.
- **Consecuencia:** 404 no revela la existencia del recurso ajeno. Verificado en smoke (informe ajeno → 404). Ver `packages/providers/src/reports-source.ts` + `middleware/errors.ts`.
- **Descartado:** 403 para acceso cruzado (confirmaría existencia).

## ADR-0006
**`accountId` siempre del token**, nunca del payload/query.
- **Contexto:** es la base de la tenancy.
- **Consecuencia:** el consumidor no puede elegir Cuenta; un `accountId` en la query se ignora (reforzado con `.strict()` en el schema de la query). Repos reciben `accountId` como primer argumento. Ver `middleware/auth.ts`.
- **Descartado:** aceptar `accountId` del input.

## ADR-0007
**Auditoría on-finish, 1 registro por request, append-only.**
- **Contexto:** AC-09 exige `httpStatus` + `latencyMs` + `correlationId` por request, en los 3 endpoints.
- **Consecuencia:** un middleware `on-finish` captura el estado ya conocido al cierre; cubre también los GET (sin use-case) y los errores (401/403/429). Ver `middleware/audit.ts`. (Limitación conocida: un 500 de `attachContainer` no se audita — ver [OQ / follow-ups](../OPEN-QUESTIONS.md).)
- **Descartado:** auditar dentro de cada use-case (no conoce status/latencia ni cubre GET).

## ADR-0008
**Adapter de streaming/SDK en la capa function**, no en `packages/*`.
- **Contexto:** el stream del PDF y el `catalyst.initialize` necesitan el SDK; el dominio debe quedar puro.
- **Consecuencia:** la regla hexagonal se sostiene — `persistence` usa el DataStore por tipado estructural (`CatalystAppLike`), sin importar el SDK. El sistema corre completo en local sin Catalyst. Ver `container.ts`.
- **Descartado:** meter el SDK/stream en `persistence`/`providers`.

## ADR-0009
**HTTP externo solo en `packages/providers`** (adapters `Zoho*`).
- **Contexto:** aislar el upstream (CRM/Creator/WorkDrive) tras un puerto.
- **Consecuencia:** los Mock permiten e2e sin Zoho; los adapters reales entran en E-02/E-03 sin tocar el resto. Lo verifica el lint (`no fetch` fuera de providers). Ver `eslint.config.mjs`.
- **Descartado:** llamar a Zoho desde use-cases o rutas.

## ADR-0010
**Bundle esbuild: inlinar todo salvo `zcatalyst-sdk-node`, que se externaliza Y se shippea como
`node_modules` real.** `express`, `zod` y los `@cardoc/*` se INLINAN en el `index.js`; el único
external es `zcatalyst-sdk-node`.
- **Estado:** Aceptada — **revisado a los golpes en el deploy real (smoke 2026-06-25, CRM real 2026-06-30).**
- **Contexto:** el deploy necesita un `index.js` autosuficiente; `workspace:*` no resuelve. Se probaron tres caminos hasta dar con el bueno:
  1. Externalizar `express` → runtime `Cannot find module 'express'` ⇒ **Catalyst NO instala las `dependencies` del `package.json`** (hay que inlinar).
  2. Inlinar TODO, incluido el SDK (`external: []`) → runtime `Cannot find module './zcql/zcql'` ⇒ el SDK hace `require()` **dinámicos** de sus submódulos que esbuild no puede resolver estáticamente.
  3. Externalizar el SDK sin más → runtime `Cannot find module 'zcatalyst-sdk-node'` ⇒ el runtime **NO lo provee**, y el symlink de pnpm se rompe al zipear en `catalyst deploy`.
- **Consecuencia:** el SDK se **externaliza** (lista única en `scripts/function-externals.mjs`, consumida por `bundle-function.mjs`) y se **materializa como `node_modules` real** en el function dir vía `scripts/deploy-prep-sdk.mjs` (paso `pnpm --filter @cardoc/fn-api predeploy`, antes de `catalyst deploy`). Tras un `pnpm install` hay que re-correr el prep (restaura el symlink de pnpm). Ver [build/bundling](../playbooks/monorepo-build-y-bundling.md) y el [playbook de deploy](../playbooks/deploy-y-rollback.md).
- **Descartado:** externalizar `express` (Catalyst no instala deps); inlinar el SDK (require dinámicos → rompe); asumir que el runtime provee el SDK (no lo hace).

## ADR-0011
**Contadores de cap in-memory por ahora** (por contenedor caliente).
- **Estado:** Aceptada — **provisional**.
- **Contexto:** E-01 necesita un cap funcional sin bloquear por features de plataforma no validadas.
- **Consecuencia:** el cap es por-instancia, no global. El cap distribuido (Catalyst Cache, increment atómico) es de-risk pre-producción — [OQ-P2](../OPEN-QUESTIONS.md). Ver `middleware/cap.ts`.
- **Descartado:** bloquear E-01 hasta tener Cache.

## ADR-0012
**PDF: resolución perezosa con caché + generación en Catalyst con pdf-lib.** Leer
`Analisis.pdf_url` → si lleno (link WorkDrive) stream; si vacío → **generar el PDF en Catalyst
con pdf-lib** → write-back a `Analisis.pdf_url` → stream.
- **Estado:** Aceptada. Flujo perezoso confirmado por Nestor. **Motor: pdf-lib** (JS puro, en
  Catalyst), detrás del puerto `PdfGenerator`. **cardoc-ml es el GENERADOR ÚNICO del PDF**
  (Nestor 2026-07-01): reemplaza el `window.print()` del portal y su pdf-backend Chromium. Se
  **reconstruye el informe REAL** (contrato de datos, reglas y layout del portal —
  `docs/reference/pdf-backend/planning.md`): `transformReportData` portado a Node
  (`report-transform.ts`) + `InformeReport` (dominio) + layout fiel en pdf-lib. Reconstrucción
  **fiel en contenido/estructura, no pixel-1:1** (pdf-lib no tiene CSS). Pendiente (E-03): el
  **read real desde Creator** (`Analisis`), el **write-back** y el **embebido de fotos** (vía
  `ImageFetcher` con auth de WorkDrive) — hoy `MockReportsSource` arma un `InformeReport` de muestra.
- **Contexto:** confirmado por Nestor; el PDF puede no existir aún al pedirlo. Generarlo es la
  parte "difícil y pesada"; el read/caché es secundario. Hoy hay una sola Cuenta "ML" → el 404
  cross-tenant no aplica en la práctica aún (pero la tenancy en `openPdf` se mantiene).
- **Consecuencia:** la generación vive detrás de `PdfGenerator` (`packages/providers/src/pdf-generator.ts`,
  impl `PdfLibReportGenerator`), usada por `ReportsSource.openPdf`; el handler ya pipea sin
  exponer URL/ruta interna. pdf-lib se **inlina** en el bundle (no external): +~1.5 MB
  (index.js ≈ 2.3 MB) — trade-off aceptable, sin binario pesado ni upstream. Swappeable a otro
  motor (Zoho Writer, @react-pdf) sin tocar el resto.
- **Descartado:** Chromium/Puppeteer headless (binario ~300 MB, cold-start/bundle riesgosos en
  Advanced I/O); Zoho Writer Merge para el arranque (suma upstream/auth/round-trip — queda como
  alternativa del puerto); asumir que el PDF siempre existe / servir el link de WorkDrive directo.

## ADR-0013
**Integración OUTBOUND a ML: CRM workflow → función Catalyst → `MlCenterClient`.** cardoc
notifica a ML (MLCenter/AutoCheck) los cambios de estado de la solicitud vía
`POST /api/autocheck/estado/actualizar`.
- **Estado:** Aceptada (trigger confirmado por Nestor 2026-06-25). Mapeo `Stage→Estado` ✅ confirmado e implementado (Nestor 2026-07-01, `STAGE_TO_ESTADO`); pendientes: origen del `LinkResultado` ([OQ-N7](../OPEN-QUESTIONS.md)), credenciales de ML ([OQ-P9](../OPEN-QUESTIONS.md)) y confirmar la fuente del disparo (Stage del Deal vs Estado del Informe, [OQ-N6](../OPEN-QUESTIONS.md)).
- **Contexto:** el cambio de estado nace en CRM (`Deal.Stage`); hay que avisarle a ML con auth JWT (token 1h).
- **Consecuencia:** un workflow del CRM dispara (webhook con shared-secret) la ruta interna `POST /v1/internal/deal-estado`; la función mapea `Stage→Estado` y llama a `MlCenterClient` (login JWT cacheado + POST). Lógica en código versionado, secretos en Catalyst. Ver `packages/providers/src/mlcenter-client.ts`, `packages/application/src/notify-estado-change.ts`, [`../playbooks/integracion-mlcenter.md`](../playbooks/integracion-mlcenter.md).
- **Descartado:** Deluge en CRM (código en plataforma, secretos en CRM); cron/poll (no event-driven).

## ADR-0014
**Auth del consumidor por header `X-Api-Key`, NO `Authorization`.**
- **Estado:** Aceptada — **descubierto en el smoke en Catalyst (2026-06-25)**.
- **Contexto:** Catalyst **reserva el header `Authorization`** y lo valida como token OAuth de Zoho; un `Authorization: Bearer <nuestro-token>` devuelve `INVALID_TOKEN` ANTES de llegar a la función (aun con Security Rules `authentication: optional`).
- **Consecuencia:** el token del consumidor viaja en `X-Api-Key`; `authMiddleware` lo lee de ahí. La function debe tener Security Rules `authentication: optional` (Catalyst no exige token propio) → nuestra auth (`X-Api-Key` + scope + tenancy + cap) es la protección real. Verificado en el smoke: `X-Api-Key` pasa limpio, `Authorization` lo intercepta Catalyst. Ver `apps/catalyst/functions/api/src/middleware/auth.ts`.
- **Descartado:** `Authorization: Bearer` (lo intercepta Catalyst).

## ADR-0015
**`GET /v1/informes` (listado pull) descartado — reemplazado por la notificación OUTBOUND a ML.**
- **Estado:** Aceptada (Nestor, 2026-06-30).
- **Contexto:** el único consumidor es ML, que es **push**: escucha los cambios de estado vía la notificación OUTBOUND (E-07, endpoint AutoCheck `estado/actualizar`, [ADR-0013](#adr-0013)). No hace *pull* de un listado de informes.
- **Consecuencia:** `GET /v1/informes` (consulta normalizada, filtros, paginación) **no se implementa** contra Creator; E-03 se reduce al **PDF** (`GET /v1/informes/:id/pdf`), candidato a target del `LinkResultado` enviado a ML ([OQ-N7](../OPEN-QUESTIONS.md)). La ruta sigue cableada en modo **mock** (valida el pipeline de middlewares), sin adapter Creator de listado.
- **Descartado:** exponer un listado/consulta *pull* al consumidor.
