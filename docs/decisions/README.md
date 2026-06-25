---
title: ADRs — cardoc-ml (log de decisiones de arquitectura)
status: active
document_type: decision-log
last_reviewed: 2026-06-25
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
| [0002](#adr-0002) | Idempotencia = External ID de la agenda (`NroSolicitud`) tomado del body | Aceptada |
| [0003](#adr-0003) | Dedup de Contacto por Email | Aceptada |
| [0004](#adr-0004) | Auth a Zoho CRM vía Catalyst Connection (OAuth gestionado) | Aceptada |
| [0005](#adr-0005) | Cross-tenant → 404 (no 403) | Aceptada |
| [0006](#adr-0006) | `accountId` siempre del token | Aceptada |
| [0007](#adr-0007) | Auditoría on-finish, 1 registro/request, append-only | Aceptada |
| [0008](#adr-0008) | Adapter de streaming/SDK en la capa function | Aceptada |
| [0009](#adr-0009) | HTTP externo solo en `packages/providers` | Aceptada |
| [0010](#adr-0010) | Bundle esbuild con externals | Aceptada |
| [0011](#adr-0011) | Contadores de cap in-memory por ahora | Aceptada (provisional) |
| [0012](#adr-0012) | PDF: resolución perezosa con caché en Creator/WorkDrive | Aceptada (mecanismo de generación pendiente) |
| [0013](#adr-0013) | Integración OUTBOUND a ML (CRM workflow → función Catalyst) | Aceptada |

> Confirmadas por Nestor Toñanez, 2026-06-25.

---

## ADR-0001
**Catalyst como gateway de control delante de Zoho.** El DataStore guarda *control*
(tokens, idempotencia, auditoría, caps), no negocio.
- **Contexto:** el negocio vive en Zoho (CRM = relación comercial, Creator = Informes). Zoho no provee auth scoped por consumidor, idempotencia, cap ni auditoría uniforme.
- **Consecuencia:** el gateway centraliza el control y deja a Zoho como sistema de registro. Ver `apps/catalyst/functions/api/`.
- **Descartado:** CRM/Creator como única capa, sin gateway.

## ADR-0002
**Idempotencia = External ID de la agenda (`NroSolicitud`) tomado del body.**
`UNIQUE(account_id, external_id)` → un reintento no crea dos Oportunidades.
- **Estado:** Aceptada (revisa la decisión previa de "header `X-Idempotency-Key` como clave").
- **Contexto:** ML manda la solicitud AutoCheck con su `NroSolicitud`; ese número identifica la agenda y es el ancla de no-duplicación. El header `X-Idempotency-Key` puede coincidir, pero el **body es la fuente canónica**.
- **Consecuencia:** el `external_id` se valida del body, es la clave del `UNIQUE`, y se persiste en un campo **External ID** del Deal (a crear en CRM). Ver `packages/application/src/create-opportunity-contact.ts`. **El scaffold E-01 todavía usa header-key — migrar en E-02.**
- **Descartado:** el header como única clave (el consumidor real —ML— ancla en su `NroSolicitud`, que va en el body).

## ADR-0003
**Dedup de Contacto por Email.**
- **Estado:** Aceptada (revisa "Documento (CI/RUT)").
- **Contexto:** el módulo `Contacts` del CRM **no tiene** un campo Documento/CI/RUT (verificado en el esquema, `discovery/modules/Contacts`). Además la notificación al cliente va por mail, así que el email es el identificador confiable.
- **Consecuencia:** `findContactByDocument` pasa a buscar **por email** → reusar; si no, crear. Ver `packages/providers/src/crm-client.ts`.
- **Descartado:** dedup por documento (no existe el campo) / por teléfono.

## ADR-0004
**Auth a Zoho CRM = Catalyst Connection** (OAuth gestionado por la plataforma).
- **Contexto:** llamar a CRM requiere OAuth con refresh; no queremos secretos en código.
- **Consecuencia:** Catalyst gestiona refresh/rotación; el adapter recibe el `accessToken` resuelto (`CrmConnection`) y nunca toca secretos. Setup: [OQ-P3](../OPEN-QUESTIONS.md).
- **Descartado:** token estático en env / OAuth a mano.

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
**Bundle esbuild con externals** (`express`, `zcatalyst-sdk-node`).
- **Contexto:** Catalyst no entiende `workspace:*` al instalar las deps de la función.
- **Consecuencia:** se inlinean los `@cardoc/*` y se dejan solo los externals → un único `index.js` desplegable. Ver `scripts/bundle-function.mjs` y [build/bundling](../playbooks/monorepo-build-y-bundling.md).
- **Descartado:** `npm install` de `workspace:*` en deploy.

## ADR-0011
**Contadores de cap in-memory por ahora** (por contenedor caliente).
- **Estado:** Aceptada — **provisional**.
- **Contexto:** E-01 necesita un cap funcional sin bloquear por features de plataforma no validadas.
- **Consecuencia:** el cap es por-instancia, no global. El cap distribuido (Catalyst Cache, increment atómico) es de-risk pre-producción — [OQ-P2](../OPEN-QUESTIONS.md). Ver `middleware/cap.ts`.
- **Descartado:** bloquear E-01 hasta tener Cache.

## ADR-0012
**PDF: resolución perezosa con caché en Creator/WorkDrive.** Leer `Analisis.pdf_url` → si
lleno (link WorkDrive) stream; si vacío → generar el PDF en Catalyst → write-back a
`Analisis.pdf_url` → stream.
- **Estado:** Aceptada — el **mecanismo de generación** está pendiente ([OQ-N1](../OPEN-QUESTIONS.md)).
- **Contexto:** confirmado por Nestor; el PDF puede no existir aún al pedirlo.
- **Consecuencia:** la lógica vive en `ReportsSource.openPdf` (adapter); el handler ya pipea sin exponer URL/ruta interna. Ver `packages/providers/src/reports-source.ts`.
- **Descartado:** asumir que el PDF siempre existe / servir el link de WorkDrive directo al consumidor.

## ADR-0013
**Integración OUTBOUND a ML: CRM workflow → función Catalyst → `MlCenterClient`.** cardoc
notifica a ML (MLCenter/AutoCheck) los cambios de estado de la solicitud vía
`POST /api/autocheck/estado/actualizar`.
- **Estado:** Aceptada (trigger confirmado por Nestor 2026-06-25). Mapeo de estados y credenciales pendientes ([OQ-N6/N7](../OPEN-QUESTIONS.md), [OQ-P9](../OPEN-QUESTIONS.md)).
- **Contexto:** el cambio de estado nace en CRM (`Deal.Stage`); hay que avisarle a ML con auth JWT (token 1h).
- **Consecuencia:** un workflow del CRM dispara (webhook con shared-secret) la ruta interna `POST /v1/internal/deal-estado`; la función mapea `Stage→Estado` y llama a `MlCenterClient` (login JWT cacheado + POST). Lógica en código versionado, secretos en Catalyst. Ver `packages/providers/src/mlcenter-client.ts`, `packages/application/src/notify-estado-change.ts`, [`../playbooks/integracion-mlcenter.md`](../playbooks/integracion-mlcenter.md).
- **Descartado:** Deluge en CRM (código en plataforma, secretos en CRM); cron/poll (no event-driven).
