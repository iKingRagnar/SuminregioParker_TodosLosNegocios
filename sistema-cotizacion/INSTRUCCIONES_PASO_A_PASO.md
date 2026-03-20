# Sistema de Cotización y Gestión para Servicio Técnico

## Base de datos 100% gratuita: SQLite

Este sistema **no usa Supabase**. Usa **SQLite**, que viene incluido con Python: un archivo local (`cotizacion.db`) donde se guarda toda la información. No hay servidor, no hay costos, no hay internet necesario para usarlo.

---

## Requisitos previos

- **Python 3.8 o superior** instalado en tu PC.
- Si no lo tienes: descarga desde [python.org](https://www.python.org/downloads/) y durante la instalación marca la opción **"Add Python to PATH"**.

---

## Paso 1: Verificar que Python está instalado

Abre **PowerShell** o **Símbolo del sistema** (Win+R → escribe `cmd` → Enter) y ejecuta:

```bash
python --version
```

Debe mostrar algo como `Python 3.11.x` o `Python 3.12.x`. Si dice "no reconocido", reinstala Python y marca "Add to PATH".

---

## Paso 2: Ir a la carpeta del proyecto

En la misma ventana, navega a la carpeta donde está el sistema:

```bash
cd c:\Users\ragna\Downloads\microsip-api\sistema-cotizacion
```

( Ajusta la ruta si guardaste el proyecto en otra ubicación. )

---

## Paso 3: Crear un entorno virtual (recomendado)

Así las librerías no se mezclan con otros proyectos:

```bash
python -m venv venv
```

Luego **activar** el entorno:

- En **PowerShell**:
  ```powershell
  .\venv\Scripts\Activate.ps1
  ```
- En **CMD**:
  ```cmd
  venv\Scripts\activate.bat
  ```

Verás `(venv)` al inicio de la línea cuando esté activo.

---

## Paso 4: Instalar dependencias

Con el entorno virtual activado (o sin él, si prefieres):

```bash
pip install -r requirements.txt
```

Esto instala:

- **openpyxl**: para exportar cotizaciones a Excel (.xlsx)
- **reportlab**: para exportar cotizaciones a PDF

Ambas son gratuitas y de código abierto.

---

## Paso 5: Configurar datos de tu empresa (opcional)

Abre el archivo **`config.py`** con un editor de texto y cambia:

- `EMPRESA_NOMBRE`: nombre de tu empresa (aparece en PDF/Excel).
- `EMPRESA_RFC`: tu RFC (si quieres que salga en documentos).
- `EMPRESA_DIRECCION`: dirección (para membrete en PDF/Excel).

Guarda el archivo. Si no lo tocas, el sistema igual funciona; solo saldrá "Servicio Técnico" por defecto.

---

## Paso 6: Ejecutar el sistema

En la misma carpeta y con el entorno activado (si lo usas):

```bash
python main.py
```

Se abrirá la ventana del **Sistema de Cotización**. La primera vez se creará automáticamente el archivo **`cotizacion.db`** en la misma carpeta (base de datos SQLite). No tienes que instalar ningún servidor ni crear bases de datos a mano.

---

## Paso 7: Uso básico por pestañas

### Pestaña **Catálogos**

1. **Clientes**: botón "+ Nuevo cliente" para agregar. Puedes editar desde la lista.
2. **Refacciones**: "+ Nueva refacción" (código, descripción, precio). Se usan en cotizaciones.
3. **Máquinas**: "+ Nueva máquina" (asociada a un cliente). Se usan en incidentes y mantenimientos.

En **Cotización** y otros módulos, al escribir en el campo "Cliente" o "Refacción" aparecerá el **autocompletado** desde el primer carácter.

### Pestaña **Cotización Refacciones**

1. Escribe en **Cliente** y elige de la lista → se completan RFC y dirección.
2. Opcional: cambia folio y fecha.
3. "+ Agregar refacción": busca por código o descripción, elige cantidad y precio.
4. **Guardar cotización** para guardar en la base de datos.
5. **Exportar Excel** o **Exportar PDF** para generar el documento (elige dónde guardar).

### Pestaña **Cotización Mano de Obra**

1. Elige **Cliente** (autocompletado).
2. Folio y fecha se pueden ajustar.
3. Técnico, horas, tarifa por hora, descuento % y descripción.
4. "+ Agregar línea" y luego **Guardar cotización**. También puedes **Exportar Excel**.

### Pestaña **Incidentes**

- "+ Nuevo incidente": cliente, máquina (opcional), descripción, prioridad, técnico, fecha.
- La lista muestra todos los incidentes; puedes refrescar.

### Pestaña **Bitácoras de Trabajo**

- "+ Nueva bitácora": vinculas a un **incidente** o a una **cotización**, fecha, técnico, actividades, tiempo en horas, materiales usados.

### Pestaña **Mantenimiento de Equipos**

- **Plan preventivo por máquina**: eliges máquina, tipo (diario/semanal/mensual/anual), días entre mantenimientos.
- **Registrar mantenimiento**: preventivo o correctivo; descripción de falla, causa raíz, acción tomada, técnico, horas, costo de refacciones.
- En la parte inferior se muestran **alertas** de mantenimientos próximos o vencidos (cuando haya planes con fechas).

### Pestaña **Historial por Cliente**

- Escribe un **Cliente** y pulsa **Ver historial**: se muestran sus cotizaciones, incidentes y bitácoras.
- **Exportar mantenimientos de máquina a Excel**: eliges una máquina y se genera un Excel con el historial de mantenimientos.

---

## Paso 8: Dónde está la base de datos

- Archivo: **`cotizacion.db`** en la carpeta `sistema-cotizacion`.
- Es un solo archivo; puedes **copiarlo** para hacer respaldos (cierra el programa antes).
- Para restaurar: pon de nuevo ese archivo en la carpeta y abre el sistema.

---

## Paso 9: Crear un acceso directo (opcional)

Para no tener que abrir la terminal cada vez:

1. Clic derecho en el escritorio → Nuevo → Acceso directo.
2. En "Ubicación" pon algo como (ajusta la ruta si cambiaste de carpeta):

   ```text
   C:\Users\ragna\AppData\Local\Programs\Python\Python311\python.exe c:\Users\ragna\Downloads\microsip-api\sistema-cotizacion\main.py
   ```

   (Sustituye `Python311` por tu versión, por ejemplo `Python312`).
3. Si usas entorno virtual:

   ```text
   c:\Users\ragna\Downloads\microsip-api\sistema-cotizacion\venv\Scripts\python.exe c:\Users\ragna\Downloads\microsip-api\sistema-cotizacion\main.py
   ```
4. Ponle nombre al acceso directo (ej. "Sistema Cotización") y aceptar.

---

## Resumen de tecnología (todo gratuito)

| Componente      | Tecnología | Costo   |
|-----------------|-----------|--------|
| Base de datos   | SQLite    | Gratis  |
| Interfaz        | Python + tkinter | Gratis (viene con Python) |
| Excel           | openpyxl  | Gratis  |
| PDF             | reportlab | Gratis  |

No se usa Supabase ni ningún servicio en la nube. Todo corre en tu PC y el archivo `cotizacion.db` es tuyo.

Si algo no te abre o da error, copia el mensaje que sale en la ventana (o en PowerShell) y con eso se puede revisar el siguiente paso.
