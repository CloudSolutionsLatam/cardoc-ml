# Runbook — Outage de Zoho Creator / WorkDrive (informes y PDF)

> Diagnóstico siempre desde el `correlationId` (`X-Correlation-Id`) → `audit_log`.
> Ver [OPERACIONES.md §5](../../OPERACIONES.md).

> ⚙️ **Parcialmente forward-looking (E-03).** El adapter real `ZohoCreatorReportsSource`
> todavía es un stub (`NotImplementedError` → hoy se traduce a `500 INTERNAL_ERROR`, no a
> `502`). El camino `502 UPSTREAM_ERROR{creator|workdrive}` y `404 PDF_NOT_AVAILABLE` se
> activa cuando el adapter Creator/WorkDrive entra en E-03. En modo `mock` los GET responden
> normal. Los pasos marcados ⚙️ se cierran y se dry-runean en E-03.

## Cuándo se dispara

`GET /v1/informes` y/o `GET /v1/informes/:id/pdf` fallan de forma sostenida:
- **`502 UPSTREAM_ERROR`** con `details.upstream = "creator"` (listado / lectura) o
  `"workdrive"` (stream del PDF) — ⚙️ con el adapter real.
- **`404 PDF_NOT_AVAILABLE`** cuando el informe existe pero su PDF no está disponible ni se
  pudo generar (ver también [pdf-no-disponible.md](pdf-no-disponible.md)).

En `audit_log` se ve por `endpoint` (`informes-list` / `informes-pdf`) + `error_code`; el
label opaco (`creator`/`workdrive`) va en la respuesta al consumidor, no en la auditoría.

## Impacto

Las automotoras no pueden consultar informes ni descargar PDFs. **No afecta** el alta
(`POST /v1/opportunity-contact`, upstream CRM distinto) ni la notificación OUTBOUND a ML.
Degradación de la consulta; el alta sigue operativa.

## Diagnóstico

1. `correlationId` del request fallido → `audit_log`: `endpoint`, `error_code`, `http_status`.
2. `502{creator}` vs `502{workdrive}`: `creator` = falla al resolver/leer el informe;
   `workdrive` = falla al **streamear** el archivo del PDF. Distinguir acota el upstream.
3. `404 PDF_NOT_AVAILABLE` (no 502) ⇒ no es outage de red: el informe existe pero el PDF no
   está / no se generó → ver [pdf-no-disponible.md](pdf-no-disponible.md).
4. Estado de Zoho Creator / WorkDrive (consola/status Zoho) — plataforma vs credencial.
5. **Recordatorio anti-cross-tenant:** un `404 NOT_FOUND` (no `PDF_NOT_AVAILABLE`) puede ser
   tenancy, no outage — el recurso es de **otra** Cuenta. Verificar primero que el `accountId`
   del token sea el correcto (ver [OPERACIONES.md §5](../../OPERACIONES.md)).

## Resolución

1. **Outage de plataforma (Creator/WorkDrive)** → sin fix local. Escalar **N3 (Zoho)**.
   Comunicar a las automotoras; el alta sigue funcionando.
2. **Credencial** ⚙️ → rotar las credenciales de Creator/WorkDrive en Environment Variables →
   redeploy (mismo modelo que CRM, ver [secretos-y-connections.md](../playbooks/secretos-y-connections.md)).
3. **PDF puntual no disponible** → seguir [pdf-no-disponible.md](pdf-no-disponible.md).
4. Mitigación temporal: el PDF se sirve de forma perezosa con caché (`Analisis.pdf_url`); un
   informe ya cacheado en WorkDrive puede seguir sirviéndose aunque la generación esté caída ⚙️.

## Verificación

`GET /v1/informes` → `200` con `data[]`; `GET /v1/informes/:id/pdf` de un informe propio →
`200 application/pdf` (`Cache-Control: no-store`, cuerpo `%PDF`). Tasa de `502` vuelta a 0.

## Dry-run

- **Hoy (mock):** `pnpm smoke` cubre `GET /v1/informes → 200 data[]` y
  `GET /v1/informes/:id/pdf → 200 application/pdf`, y el cross-tenant `→ 404 NOT_FOUND`.
- ⚙️ **E-03 (adapter real):** en dev, inducir el fallo del upstream (credencial inválida de
  Creator/WorkDrive) → esperar `502` con el label correcto; restaurar → `200`. Registrar.

## Prevención / follow-up

- Alerta sobre tasa de `502` en `endpoint IN (informes-list, informes-pdf)`.
- Cerrar la **generación del PDF** (OQ-N1) y la relación `Informes`↔`Analisis` (OQ-N2) — ver
  [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md); sin eso, `pdf-no-disponible` no es operable.
- **Streaming/tope de payload** en Advanced I/O (CAT-Q1) — ⚠️ verificar (docs/consola).
