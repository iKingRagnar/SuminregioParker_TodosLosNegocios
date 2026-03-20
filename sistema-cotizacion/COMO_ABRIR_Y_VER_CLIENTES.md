# Cómo abrir el sistema de escritorio y ver tus clientes

## Abrir el sistema (en tu PC)

1. **Abre PowerShell o CMD**  
   - Tecla Windows → escribe `PowerShell` o `cmd` → Enter.

2. **Ve a la carpeta del sistema**  
   ```powershell
   cd c:\Users\ragna\Downloads\microsip-api\sistema-cotizacion
   ```

3. **Instala dependencias (solo la primera vez)**  
   ```powershell
   pip install -r requirements.txt
   ```

4. **Ejecuta la aplicación**  
   ```powershell
   python main.py
   ```  
   Se abrirá una ventana con el sistema.

---

## Dónde ver la información de clientes

1. En la ventana del sistema, haz clic en la **pestaña "Catálogos"** (la primera).
2. Ahí verás la sección **"Clientes"** con una tabla: Id, Código, Nombre, RFC, Dirección.
3. Para **agregar un cliente**: clic en **"+ Nuevo cliente"**, llena los datos y Guardar.
4. Para **editar**: selecciona un cliente en la tabla y clic en **"Editar"**.

Tu información de clientes está guardada en el archivo **`cotizacion.db`** en la misma carpeta `sistema-cotizacion`. Si quieres respaldo, copia ese archivo (con el programa cerrado).

---

## Si no se abre la ventana

- Comprueba que Python está instalado: `python --version`
- Si da error al ejecutar `python main.py`, copia el mensaje que sale y revísalo (por ejemplo, falta `pip install -r requirements.txt`).
