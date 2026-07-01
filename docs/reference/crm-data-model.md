---
title: CRM data model — proyección para cardoc-ml
status: reference
last_reviewed: 2026-06-30
---

# CRM data model — lo que toca cardoc-ml

Mapa de los **api_names reales** de Zoho CRM que la integración usa, derivado del
discovery del CRM. **No duplica** ese discovery: es la proyección mínima para el
`ZohoCrmClient` (E-02). Fuente de verdad completa (94 módulos):

> `C:\Users\david\Documents\unicorp\cardoc\crm\feedback-ia\discovery\modules\<Modulo>\data_model.json`
> (índice curado en `…\discovery\modules\README.md`).

## ⚠️ Caveats del snapshot

1. **El discovery es del 2026-06-25**, anterior a los campos custom que Nestor creó
   el **2026-06-30** (`EXTERNAL_ID` en Deals, `Cedula` en Contacts). Por eso **esos
   dos campos NO aparecen en el dump** — no es un error, el dump los precede. Sus
   api_names vienen confirmados directamente por Nestor, no del dump.
2. **El discovery NO incluye valores de picklist.** Resuelto aparte con `settings/stages`
   + `settings/pipeline` (Nestor 2026-06-30): `Stage = "Nueva Solicitud"` y `Pipeline =
   "B2B"` confirmados (ver §Pipeline B2B). Para otros picklists (`Estado`/depto) sigue
   valiendo `GET /settings/fields?module=Deals`.

## Implementación (E-02 — ✅)

`ZohoCrmClient` (`packages/providers/src/crm-client.ts`) está implementado contra Zoho REST v2:
`findContactByCedula` (dedup), `findDealByExternalId` (idempotencia del Deal), `createContact`,
`createOpportunity`. Token vía **self-client del SDK** (`container.ts`, lazy + memoizado por request).
El estado `error` del use-case es **reintentable** (efecto idempotente: dedup por cédula +
`EXTERNAL_ID`). 25 tests verdes. **Alta real validada en Catalyst** (datastore + Zoho):
smoke `scripts/smoke-catalyst-crm.mjs` → 5/5, con el Deal en `Stage = "Nueva Solicitud"`.
La idempotencia Capa 1 se apoya en `UNIQUE(idempotency_key)` (single-column; el filtrado por
`account_id` en el código es lectura defensiva de tenancy, no parte del índice).

## Módulos (api_name)

| api_name | Label | Rol en cardoc-ml |
|---|---|---|
| `Contacts` | Contactos | Contacto del cliente (dedup por `Cedula`) |
| `Deals` | Oportunidades | La Oportunidad / agenda de revisión |
| `Accounts` | Cuentas | Cuenta única "ML" |
| `Products` | **Vehiculos** | El vehículo (lookup desde Deals) |
| `Inspectores` | Inspectores | Inspector asignado (lookup desde Deals) |
| `Marcas` / `Modelos` | — | Lookups de `Products.Marca` / `.Modelo` |

## `Contacts` — `createContact`

| Payload ML | Campo CRM (api_name) | Tipo | Nota |
|---|---|---|---|
| `nroCedula` | `Cedula` | (custom) | Llave de dedup. **No estaba en el dump** (creado 2026-06-30). |
| `nombres` | `First_Name` | text (40) | — |
| `apellidos` | `Last_Name` | text (80) | **Único `system_mandatory`** del módulo. |
| `celularCliente` | `Mobile` | phone (30) | **OJO: no existe `Phone`** en este CRM; el teléfono de persona es `Mobile`. |
| (Cuenta "ML") | `Account_Name` | lookup → `Accounts` | **Decisión CRM-Q3:** la Cuenta "ML" se asocia **acá** (el Deal no lleva Cuenta). |
| — | `Email` | email (100) | ML no manda email. |

## `Deals` — `createOpportunity`

| Payload ML | Campo CRM (api_name) | Tipo | Nota |
|---|---|---|---|
| (fijo) | `Deal_Name` | text (120) | `system_mandatory`. Componer (ej. `"ML <NroSolicitud>"`). |
| (fijo) | `Stage` | picklist | `system_mandatory`. Valor = `FIXED_OPPORTUNITY_STAGE` = `"Nueva Solicitud"` ✅ (confirmado en `settings/stages`, id …31320001). |
| (fijo) | `Pipeline` | picklist | **`system_mandatory`**. Valor = **`"B2B"`** (`ZOHO_FIXED_PIPELINE`). `Nueva Solicitud` es stage de este pipeline, no del `Standard`. |
| (contacto creado) | `Contact_Name` | lookup → `Contacts` | `{ "Contact_Name": { "id": "<contactId>" } }`. |
| `nroSolicitud` | `EXTERNAL_ID` | (custom) | **No estaba en el dump** (creado 2026-06-30). |
| `marca`/`modelo`/`anio`/`matricula` (+ sucursal/dir.) | `nota_agenda` | textarea | **Decisión CRM-Q4:** el adapter compone un texto con el vehículo + sucursal y lo escribe acá. **No** se modela `Products`. |

**Agenda (opcional, fase posterior)** — campos reales en Deals si se decide poblarlos:
`Inspector` (→`Inspectores`), `Vehiculo` (→`Products`),
`Fecha_y_hora_de_visita_programada` / `Fecha_y_hora_Fin_de_visita_programada` (datetime),
`nota_agenda` (textarea), y dirección como texto suelto: `Ciudad`, `Calle`, `N_mero`,
`Primera_calle_de_cruce`, `Segunda_calle_de_cruce`, `Estado` (picklist, ¿departamento?),
`Latitud`/`Longitud`/`Enlace_Google_Maps`.

## `Accounts` — la Cuenta "ML"

`Account_Name` (text, mandatory) la nombra; `External_Account_ID` (text custom) sirve
para matchearla sin el id interno; `Account_Type` / `Categoria_cliente` (picklists) la
segmentan. Único lookup outbound: `Owner` → user (es la raíz).

## Pipeline B2B (flujo de stages)

Las solicitudes AutoCheck van en el pipeline **`B2B`** (no el `Standard` default). Su flujo
(de `settings/pipeline`, confirmado 2026-06-30):

`Nueva Solicitud` → `Agendado B2B` → `Completado` → `Cerrado` | `Cancelado`

- El alta crea el Deal con `Pipeline = "B2B"` + `Stage = "Nueva Solicitud"`.
- ⚠️ `Nueva Solicitud` **no** existe en el pipeline `Standard`; mezclar pipeline/stage de
  pipelines distintos hace que Zoho rechace el create.

**Mapeo `Stage` → ML `Estado`** (OQ-N6, outbound E-07 — ✅ **confirmado por Nestor 2026-07-01**;
implementado en `STAGE_TO_ESTADO`, `packages/application/src/notify-estado-change.ts`):

| Stage B2B | ML `Estado` |
|---|---|
| `Nueva Solicitud` | — (inicial, sin notificar) |
| `Agendado B2B` | `COORDINACIÓN` |
| `Completado` / `Cerrado` | `FINALIZADO` (requiere `LinkResultado`) |
| `Cancelado` | — (terminal; ML no tiene estado de cancelación) |

> ⚠️ Residual (OQ-N6.a): el mapeo asume que la fuente del estado es `Deals.Stage`. Falta
> confirmar que el workflow del CRM dispara sobre `Deals.Stage` y no sobre
> `Informes_Revision.Estado` (ver Hallazgo #4). Si fuera lo segundo, cambian las claves del mapa.

## Hallazgos estructurales (cambian el diseño del adapter)

1. **Deals NO tiene lookup a `Accounts`.** El único lookup "de cuenta" es
   `Deals.Contact_Name` → `Contacts`, y `Contacts.Account_Name` → `Accounts`. → **Resuelto
   (CRM-Q3): vía Contacto** — `createContact` setea `Account_Name`; el Deal solo linkea
   el Contacto (no se crea lookup Cuenta en Deals).
2. **`Pipeline` es `system_mandatory`** en Deals: el create debe enviarlo además del
   `Stage`. → hay un **Pipeline específico** de AutoCheck (**CRM-Q5**), valor pendiente
   (picklist, no verificable desde el dump).
3. **Vehículo = lookup, no texto.** `Deals.Vehiculo` → `Products`; y `Products.Marca`
   → `Marcas`, `Products.Modelo` → `Modelos` (también lookups); **sin campo de matrícula**.
   → **Resuelto (CRM-Q4): NO se modela `Products`** — el adapter vuelca marca/modelo/año/
   matrícula (+ sucursal) como texto en `nota_agenda` del Deal.
4. **Estados.** El field-tracker `Historial_de_Estado` trackea
   `Informes_Revision.Estado`, **no** `Deals.Stage`. El **mapeo** de valores ya está confirmado
   e implementado (OQ-N6.b, ver §Pipeline B2B), pero queda **abierto** cuál es la fuente real
   del disparo (OQ-N6.a): el `Stage` del Deal o el `Estado` del Informe. El diseño actual asume
   `Deals.Stage` (consistente con el endpoint `deal-estado`). `Visitas` (custom) tampoco tiene
   lookup a Deals.

## Pendiente de confirmar

- **CRM-Q1**: ✅ api_names estándar + `Stage = "Nueva Solicitud"` y `Pipeline = "B2B"`
  confirmados (`settings/stages`/`settings/pipeline`). Menor pendiente: valores del picklist
  `Estado` (depto) si se decide poblarlo.
- **CRM-Q3**: ✅ Resuelto — Cuenta "ML" vía Contacto (`Contacts.Account_Name`).
- **CRM-Q4**: ✅ Resuelto — vehículo como texto en `nota_agenda`; no se modela `Products`.
- **CRM-Q5**: ✅ Resuelto — `Pipeline = "B2B"` (`ZOHO_FIXED_PIPELINE`).
- **OAuth** ([OQ-P3](../OPEN-QUESTIONS.md)): self-client (client_id/secret/refresh_token) para
  escribir en CRM. **Resuelto en el entorno de smoke** (el alta real ya escribió en Zoho, 5/5);
  queda replicar la config de secrets en cada entorno donde se despliegue.
