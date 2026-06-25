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

## Runbooks — qué hacer cuando algo falla

| Runbook | Estado |
|---------|--------|
| [runbooks/_template.md](runbooks/_template.md) | Plantilla. Los runbooks concretos se escriben como dry-run pre-producción (ver [../OPERACIONES.md](../OPERACIONES.md) §5). |

> Convención (heredada del método de cfe-catalyst): un runbook se escribe **antes** de
> necesitarlo y se prueba con un dry-run — un runbook sin dry-run es una expresión de deseo.
