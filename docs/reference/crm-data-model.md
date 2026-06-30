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
2. **El export NO incluye valores de picklist** (`pick_list_values`) en ningún
   archivo. ⇒ **no se puede verificar desde acá** que `Nueva Solicitud` sea un valor
   válido del `Stage`, ni los valores de `Pipeline`/`Estado`. Verificar con
   `GET /crm/v2/settings/fields?module=Deals` antes de cablear el create real.

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
| (Cuenta "ML") | `Account_Name` | lookup → `Accounts` | Así cuelga la Cuenta del Contacto (ver §estructura). |
| — | `Email` | email (100) | ML no manda email. |

## `Deals` — `createOpportunity`

| Payload ML | Campo CRM (api_name) | Tipo | Nota |
|---|---|---|---|
| (fijo) | `Deal_Name` | text (120) | `system_mandatory`. Componer (ej. `"ML <NroSolicitud>"`). |
| (fijo) | `Stage` | picklist | `system_mandatory`. Valor = `FIXED_OPPORTUNITY_STAGE` = `"Nueva Solicitud"` (sin verificar contra picklist). |
| — | `Pipeline` | picklist | **`system_mandatory`** — hay que enviarlo. Valor por confirmar. |
| (contacto creado) | `Contact_Name` | lookup → `Contacts` | `{ "Contact_Name": { "id": "<contactId>" } }`. |
| `nroSolicitud` | `EXTERNAL_ID` | (custom) | **No estaba en el dump** (creado 2026-06-30). |

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

## Hallazgos estructurales (cambian el diseño del adapter)

1. **Deals NO tiene lookup a `Accounts`.** El único lookup "de cuenta" es
   `Deals.Contact_Name` → `Contacts`, y `Contacts.Account_Name` → `Accounts`. ⇒ la
   Cuenta "ML" se asocia **en el Contacto**, no en la Oportunidad. `createContact`
   setea `Account_Name`; `createOpportunity` NO tiene dónde poner la Cuenta. *(Salvo
   que se cree un lookup custom Cuenta en Deals.)* → **CRM-Q3**.
2. **`Pipeline` es `system_mandatory`** en Deals: el create debe enviarlo además del
   `Stage`. Valor por confirmar (picklist, no verificable desde el dump).
3. **Vehículo = lookup, no texto.** `Deals.Vehiculo` → `Products`; y `Products.Marca`
   → `Marcas`, `Products.Modelo` → `Modelos` (también lookups). ⇒ poblar el vehículo
   exige resolver/crear registros en `Marcas`/`Modelos` y `Products` antes del Deal.
   Además **no hay campo de matrícula/placa** en `Products` (candidatos: `Product_Code`,
   `Product_Name`, o el módulo `Veh_culos_Historico`). → **CRM-Q4**.
4. **Estados.** El field-tracker `Historial_de_Estado` trackea
   `Informes_Revision.Estado`, **no** `Deals.Stage`. Define para [OQ-N6](../OPEN-QUESTIONS.md)
   (outbound a ML) cuál es la fuente real del estado: el `Stage` del Deal o el `Estado`
   del Informe. `Visitas` (custom) tampoco tiene lookup a Deals.

## Pendiente de confirmar

- **CRM-Q1** (parcialmente resuelta): api_names estándar capturados acá; faltan los
  **valores de picklist** (`Stage` incluido) vía `settings/fields`.
- **CRM-Q3**: ¿la Oportunidad se vincula a la Cuenta "ML" sólo vía Contacto, o se crea
  un lookup Cuenta custom en Deals?
- **CRM-Q4**: alcance del vehículo (resolver `Products`/`Marcas`/`Modelos` vs. diferir).
- **Pipeline**: ¿qué valor enviar (mandatorio)?
