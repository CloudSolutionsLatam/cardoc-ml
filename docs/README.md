---
title: cardoc-ml — Índice de documentación
status: scaffolding
last_reviewed: 2026-06-25
---

# Documentación de cardoc-ml

Documentación de plataforma y operación. Los documentos de **método** (arquitectura,
calidad, operaciones, plan, contratos) viven en la raíz del repo; acá están los
**playbooks** (cómo funciona la plataforma) y los **runbooks** (qué hacer cuando algo falla).

> **Puerta de entrada para sesiones de IA:** [ASSISTANT.md](ASSISTANT.md) — árbol de
> decisión por tarea, vocabulario y reglas duras. Fijala con `@docs/ASSISTANT.md`.

## Canon — decisiones y preguntas abiertas

| Documento | Contenido |
|-----------|-----------|
| [decisions/README.md](decisions/README.md) | Log de **ADRs** (decisiones de arquitectura, irreversibles sin nueva ADR) |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | **Registro único** de preguntas abiertas (negocio + plataforma) |
| [reference/crm-data-model.md](reference/crm-data-model.md) | **api_names reales del CRM** (Contacts/Deals/Accounts/Products) que toca el adapter + hallazgos estructurales |

## Método (raíz del repo)

| Documento | Contenido |
|-----------|-----------|
| [../ARQUITECTURA.md](../ARQUITECTURA.md) | Diseño técnico, hexagonal, modelo de datos, ADRs |
| [../CONTRATOS.md](../CONTRATOS.md) | Referencia de la API (entregable E-06) |
| [../ATRIBUTOS-DE-CALIDAD.md](../ATRIBUTOS-DE-CALIDAD.md) | Atributos de calidad + validaciones de plataforma |
| [../OPERACIONES.md](../OPERACIONES.md) | Manual operativo |
| [../PLAN-DE-DESARROLLO.md](../PLAN-DE-DESARROLLO.md) | Plan, milestones y estado |

## Playbooks — cómo funciona la plataforma

| Playbook | Para |
|----------|------|
| [playbooks/catalyst-artefactos.md](playbooks/catalyst-artefactos.md) | Qué es cada artefacto de Zoho Catalyst (Advanced I/O, DataStore, Cache, Connections, Env Vars) y cómo se usa acá |
| [playbooks/monorepo-build-y-bundling.md](playbooks/monorepo-build-y-bundling.md) | pnpm workspaces, TypeScript project references (`tsc -b`), bundling con esbuild |
| [playbooks/deploy-y-rollback.md](playbooks/deploy-y-rollback.md) | Pipeline de deploy (CI → dev → smoke → prod) y rollback |
| [playbooks/secretos-y-connections.md](playbooks/secretos-y-connections.md) | Secretos en Environment Variables + Connection OAuth a Zoho CRM + rotación de tokens |
| [playbooks/datastore-esquema.md](playbooks/datastore-esquema.md) | Esquema de tablas del DataStore + UNIQUE/índices a crear en consola |
| [playbooks/integracion-mlcenter.md](playbooks/integracion-mlcenter.md) | Integración con ML (MLCenter/AutoCheck): inbound + outbound (notificación de estados) |

## Runbooks — qué hacer cuando algo falla

| Runbook | Disparador | Dry-run |
|---------|-----------|---------|
| [runbooks/outage-crm.md](runbooks/outage-crm.md) | `502 UPSTREAM_ERROR{crm}` en el alta; oportunidades en `error` | ⚙️ en dev (credencial inválida) |
| [runbooks/outage-creator-workdrive.md](runbooks/outage-creator-workdrive.md) | `502{creator\|workdrive}` en informes/PDF | mock hoy; ⚙️ adapter real (E-03) |
| [runbooks/cap-mal-configurado.md](runbooks/cap-mal-configurado.md) | `429 CAP_EXCEEDED` a automotora legítima | ✅ local (probado 2026-07-01) |
| [runbooks/idempotencia-conflicto.md](runbooks/idempotencia-conflicto.md) | `409 IDEMPOTENCY_CONFLICT` (clave reusada, payload distinto) | ✅ smoke (local + Catalyst) |
| [runbooks/token-comprometido.md](runbooks/token-comprometido.md) | Fuga de token → rotación de emergencia | ⚙️ en dev (revoke) |
| [runbooks/pdf-no-disponible.md](runbooks/pdf-no-disponible.md) | `404 PDF_NOT_AVAILABLE` (`Analisis.pdf_url` vacío) | 🔴 bloqueado (OQ-N1, E-03) |
| [runbooks/_template.md](runbooks/_template.md) | Plantilla para nuevos runbooks | — |

> Pendiente: `restore-datastore` — bloqueado por el mecanismo de backup/export (OQ-P7,
> ⚠️ sin confirmar); no se escribe con pasos inventados.

> Convención (heredada del método de cfe-catalyst): un runbook se escribe **antes** de
> necesitarlo y se prueba con un dry-run — un runbook sin dry-run es una expresión de deseo.
