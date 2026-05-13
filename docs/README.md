# Documentación

Toda la documentación del proyecto vive aquí, categorizada para no abrumar la raíz del repo.

## Estructura

### `deploy/`
Despliegue, hosting, runners de GitHub, PM2, configuración de servidores Windows.

- [DEPLOY-RENDER.md](deploy/DEPLOY-RENDER.md) — Setup completo en Render
- [DESPLIEGUE-GIT-Y-SERVIDOR.md](deploy/DESPLIEGUE-GIT-Y-SERVIDOR.md) — Flujo Git → servidor
- [GIT_Y_SERVIDOR.md](deploy/GIT_Y_SERVIDOR.md) — Manejo de branches y servidor
- [PM2-GITHUB.md](deploy/PM2-GITHUB.md) — PM2 con GitHub Actions
- [GITHUB-RUNNER-WINDOWS.md](deploy/GITHUB-RUNNER-WINDOWS.md) — Runner en Windows
- [GITHUB-RUNNER-WINDOWS-PASO-A-PASO.md](deploy/GITHUB-RUNNER-WINDOWS-PASO-A-PASO.md) — Guía paso a paso

### `operations/`
Configuración de subsistemas, manejo de Microsip, troubleshooting operativo.

- [CONFIGURACION_CHATBOT.md](operations/CONFIGURACION_CHATBOT.md) — Setup del asistente IA + alertas
- [LOGICA_CXC_Y_FILTROS.md](operations/LOGICA_CXC_Y_FILTROS.md) — Lógica de CxC y filtros
- [REFERENCIA_MICROSIP_FUENTES.md](operations/REFERENCIA_MICROSIP_FUENTES.md) — Mapa de tablas Firebird/DuckDB
- [SERVER_TIMEOUTS.md](operations/SERVER_TIMEOUTS.md) — Timeouts y diagnóstico

### `changelog/`
Bitácora histórica de cambios significativos / diagnósticos pasados.

- [CORRECCIONES_SERVER.md](changelog/CORRECCIONES_SERVER.md)
- [DIAGNOSTICO_DISCREPANCIAS.md](changelog/DIAGNOSTICO_DISCREPANCIAS.md)

## Documentos en la raíz

- [README.md](../README.md) — Quickstart + variables de entorno
- [ARCHITECTURE.md](../ARCHITECTURE.md) — Arquitectura del sistema y plan de migración
- [AGENTS.md](../AGENTS.md) — Convenciones para agentes
