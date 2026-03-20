# Sistema de Cotización y Gestión para Servicio Técnico

Aplicación de escritorio según la **Propuesta v1.0** (Opción B): cotización de refacciones, mano de obra, incidentes, bitácoras y mantenimiento de equipos.

## Base de datos: SQLite (100% gratuito)

- **No usa Supabase.** Todo se guarda en un archivo local: `cotizacion.db`.
- Sin servidor, sin costos, sin conexión obligatoria.

## Inicio rápido

1. Tener **Python 3.8+** instalado.
2. En esta carpeta:
   ```bash
   pip install -r requirements.txt
   python main.py
   ```
3. Editar `config.py` para poner nombre, RFC y dirección de tu empresa (opcional).

## Instrucciones detalladas

Ver **[INSTRUCCIONES_PASO_A_PASO.md](INSTRUCCIONES_PASO_A_PASO.md)** para:

- Instalación paso a paso (incluido entorno virtual).
- Uso de cada pestaña (Catálogos, Cotizaciones, Incidentes, Bitácoras, Mantenimientos, Historial).
- Exportar Excel/PDF y respaldar la base de datos.
- Crear un acceso directo en el escritorio.

## Estructura del proyecto

| Archivo | Descripción |
|---------|-------------|
| `main.py` | Aplicación principal (ventana y todos los módulos) |
| `database.py` | Creación de tablas SQLite y conexión |
| `busquedas.py` | Búsquedas para autocompletado (clientes, refacciones, máquinas) |
| `widgets.py` | Widget de autocompletado reutilizable |
| `exportar.py` | Exportación a Excel (openpyxl) y PDF (reportlab) |
| `config.py` | IVA, nombre y datos de la empresa |
| `requirements.txt` | openpyxl, reportlab |
| `cotizacion.db` | Base de datos (se crea al ejecutar la primera vez) |

## Tecnologías (todas gratuitas)

- **Python** + **tkinter** (interfaz)
- **SQLite** (base de datos)
- **openpyxl** (Excel)
- **reportlab** (PDF)
