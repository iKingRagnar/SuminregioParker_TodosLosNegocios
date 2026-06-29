# Instrucciones para agentes — microsip-api

## Alcance

Este repositorio es la API / backend y estáticos asociados (Suminregio). Los agentes deben seguir las reglas en **`.cursor/rules/`** y, para trabajo de datos/BI/automatización, leer también el skill **`.cursor/skills/data-ai-ecosystem-copilot/SKILL.md`**.

## Reglas Cursor (orden sugerido de relevancia)

1. **`data-ai-core-standards.mdc`** — estándares de desarrollo, BI, IA y comunicación (`alwaysApply: true`).
2. **`siempre-comandos.mdc`** — ante git, Render, PM2 o `/api/ping`: comandos PowerShell completos con `cd` al workspace.
3. **`suminregio-git-deploy.mdc`** — tras cambios listos: commit + push a `main`; el usuario hace `pull` + `pm2` en el servidor.

## Comandos listos para copiar

**`.cursor/COMANDOS.md`**

## Skill local (Data & AI Ecosystem Co-Pilot)

- Ruta: `.cursor/skills/data-ai-ecosystem-copilot/SKILL.md`
- Úsalo cuando el usuario trabaje en BI, dashboards, SQL (Firebird/SQL Server), ETL, Python, n8n, agentes o analítica financiera/operativa.

## Seguridad

No commitear secretos. Credenciales vía variables de entorno o gestor de secretos del entorno de despliegue.
