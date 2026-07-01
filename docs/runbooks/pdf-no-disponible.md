# Runbook — PDF no disponible (`Analisis.pdf_url` vacío y la generación falla)

> Diagnóstico desde el `correlationId` (`X-Correlation-Id`) → `audit_log`.
> Ver [OPERACIONES.md §5](../../OPERACIONES.md).

> ⚙️🔴 **Bloqueado por negocio (E-03 / OQ-N1).** La **generación** del PDF cuando
> `Analisis.pdf_url` está vacío **no está definida** (plantilla nativa de Creator vs HTML→PDF
> en Catalyst vs servicio existente) ni de qué datos sale (relación `Informes`↔`Analisis`,
> OQ-N2). Este runbook fija el **diagnóstico y la contención**; los pasos de resolución
> marcados ⚙️ se completan y se dry-runean cuando se cierre OQ-N1/OQ-N2 y entre el adapter real.
> Ver [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md).

## Cuándo se dispara

`GET /v1/informes/:id/pdf` devuelve **`404 PDF_NOT_AVAILABLE`**: el informe **existe** (y es
de la Cuenta del token) pero su PDF no está disponible ni se pudo generar. Distinto de:
- `404 NOT_FOUND` → el informe no existe **o es de otra Cuenta** (tenancy) — ver
  [outage-creator-workdrive.md](outage-creator-workdrive.md) y la nota anti-cross-tenant.
- `502 UPSTREAM_ERROR{workdrive}` → falla de red al **streamear** un PDF que sí existe.

## Impacto

La automotora no puede descargar el PDF de un informe puntual (o de varios, si la generación
está caída en general). El listado (`GET /v1/informes`) y el alta no se ven afectados.

## Diagnóstico

1. `correlationId` del `404` → `audit_log`: `endpoint = "informes-pdf"`,
   `error_code = "PDF_NOT_AVAILABLE"`, `http_status = 404`.
2. Confirmar que **no** es tenancy: el código `PDF_NOT_AVAILABLE` implica que el informe se
   resolvió para la Cuenta del token (si fuera de otra Cuenta sería `NOT_FOUND`).
3. ⚙️ Inspeccionar el informe en Creator: ¿`Analisis.pdf_url` está vacío (nunca se generó) o
   apunta a un archivo de WorkDrive inexistente/borrado?
4. ⚙️ Si `pdf_url` vacío ⇒ el paso de **generación + write-back** falló o no está implementado
   (OQ-N1). Si apunta a un archivo faltante ⇒ problema de WorkDrive
   ([outage-creator-workdrive.md](outage-creator-workdrive.md)).

## Resolución

1. ⚙️ **`pdf_url` vacío, generación disponible:** re-disparar la generación del PDF (mecanismo
   a definir en OQ-N1) → write-back a `Analisis.pdf_url` → reintentar el `GET`.
2. ⚙️ **Generación caída:** escalar N2/N3 según el generador elegido (Creator nativo /
   Catalyst / servicio externo). Contención: informar a la automotora que el PDF está en
   preparación; el resto del servicio sigue.
3. **Archivo de WorkDrive faltante** con `pdf_url` lleno → seguir
   [outage-creator-workdrive.md](outage-creator-workdrive.md).

## Verificación

`GET /v1/informes/:id/pdf` del informe afectado → `200 application/pdf`
(`Cache-Control: no-store`, cuerpo `%PDF`). En `audit_log`, el `PDF_NOT_AVAILABLE` de ese
informe no se repite.

## Dry-run

- **Hoy:** el `MockReportsSource` **siempre** entrega un PDF (`pdf_url` lleno) → el camino
  `PDF_NOT_AVAILABLE` **no es reproducible en local** todavía (el stub `ZohoCreatorReportsSource`
  lanza `NotImplementedError`, no `PdfNotAvailableError`).
- ⚙️ **E-03:** con el adapter real y OQ-N1 cerrado, forzar un informe con `Analisis.pdf_url`
  vacío + generación deshabilitada → esperar `404 PDF_NOT_AVAILABLE`; habilitar generación →
  `200`. Registrar. **Sin este dry-run, el runbook no está probado.**

## Prevención / follow-up

- **Cerrar OQ-N1 (generación del PDF) y OQ-N2 (relación `Informes`↔`Analisis`)** — bloquean
  tanto el adapter como este runbook ([OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md)).
- Monitorear informes con `Analisis.pdf_url` vacío de forma sostenida (backlog de generación).
- Alerta sobre tasa de `PDF_NOT_AVAILABLE` por `account_id`.
