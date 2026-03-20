# Runner de GitHub en Windows — guía con pinzas (cada clic y cada comando)

Lee esto de arriba abajo **una vez** para entender el orden. Luego vuelve a ejecutar cada bloque en tu PC o en el servidor según indique la columna **Dónde**.

**Qué vas a lograr al final:** en tu **PC personal** haces cambios y `git push` a la rama `main`. El **servidor Windows** donde corre el API se actualiza solo (descarga el código de GitHub, instala dependencias y reinicia PM2).

**Necesitas tener:**
- Una cuenta de **GitHub** y un **repositorio** (puede ser el que ya creaste para el API).
- **Node.js** instalado en el **servidor** (ya lo tienes si `node -v` funciona).
- **Git para Windows** instalado en el **servidor**. Si no: descarga desde https://git-scm.com/download/win → siguiente, siguiente, instalar. Cierra y abre PowerShell después.
- Acceso **RDP** (Escritorio remoto) al servidor o estar físicamente frente a él.
- **PM2** instalado en el servidor (`npm install -g pm2`). Si no estás seguro: en el servidor abre PowerShell y ejecuta `pm2 -v`. Si da error, ejecuta `npm install -g pm2`.

---

# PARTE 0 — Nombres que vas a sustituir (anótalos en un papel)

Antes de empezar, escribe en un papel (o bloc de notas):

| Qué | Ejemplo | Tu valor real |
|-----|---------|----------------|
| Usuario de GitHub | `ragna` | _______________ |
| Nombre del repo | `suminregio-microsip-api` | _______________ |
| URL HTTPS del repo | `https://github.com/ragna/suminregio-microsip-api.git` | _______________ |

La URL la ves en GitHub: botón verde **Code** → pestaña **HTTPS** → copiar.

También decide la **carpeta** donde vivirá el API en el servidor. Recomendación:

`C:\apps\suminregio-microsip-api`

Si usas otra, **la misma ruta** la pondrás más adelante en el archivo `deploy.yml`.

---

# PARTE 1 — En tu PC PERSONAL (preparar el archivo que manda a desplegar)

## 1.1 Abrir PowerShell en la carpeta del proyecto

1. Pulsa **Windows + E** (Explorador de archivos).
2. Ve a la carpeta donde tienes el monorepo, por ejemplo:  
   `C:\Users\ragna\Downloads\microsip-api`
3. Haz clic en la **barra de direcciones** (donde dice la ruta).
4. Escribe: `powershell` y pulsa **Enter**.  
   Se abre una ventana negra/azul: esa es PowerShell **ya dentro** de esa carpeta.

## 1.2 Generar la carpeta lista para subir a Git (export)

1. En esa ventana de PowerShell, escribe **exactamente** (y pulsa Enter):

```powershell
.\scripts\export-suminregio-deploy.ps1
```

2. Si sale error de **política de ejecución**, ejecuta **una vez**:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Escribe `S` si pregunta Sí/No. Luego repite el `.\scripts\export-suminregio-deploy.ps1`.

3. Debe crearse la carpeta:

`C:\Users\ragna\Downloads\microsip-api\suminregio-microsip-deploy`

4. Comprueba que dentro exista la carpeta `.github` y dentro de ella `workflows` y el archivo `deploy.yml`.  
   Ruta completa típica:  
   `...\suminregio-microsip-deploy\.github\workflows\deploy.yml`

## 1.3 Editar la ruta del servidor en deploy.yml

1. Abre el **Explorador de archivos**.
2. Entra a:  
   `C:\Users\ragna\Downloads\microsip-api\suminregio-microsip-deploy\.github\workflows`
3. Haz **clic derecho** en `deploy.yml` → **Abrir con** → **Bloc de notas** (o Visual Studio Code).
4. Busca la línea que dice:

```powershell
$AppDir = 'C:\apps\suminregio-microsip-api'
```

5. Si en el servidor **vas a usar otra carpeta**, cambia **solo** lo que está entre comillas simples por tu ruta real, por ejemplo:

`$AppDir = 'D:\Proyectos\suminregio-api'`

6. Guarda el archivo (**Ctrl + S**) y cierra el editor.

## 1.4 Subir (o actualizar) el repo en GitHub desde el PC

> Si **nunca** subiste esta carpeta: sigue 1.4A.  
> Si **ya** tienes el repo y solo quieres añadir el workflow: sigue 1.4B.

### 1.4A — Primera vez (no existe git en suminregio-microsip-deploy)

1. PowerShell:

```powershell
cd C:\Users\ragna\Downloads\microsip-api\suminregio-microsip-deploy
```

2. Inicializar git:

```powershell
git init
git add .
git commit -m "Initial commit con workflow deploy"
git branch -M main
```

3. Enlazar con GitHub (sustituye la URL por la tuya del papel):

```powershell
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
```

4. Subir:

```powershell
git push -u origin main
```

5. Si pide usuario/contraseña: en GitHub ya no se usa la contraseña de la cuenta; usa un **Personal Access Token** como contraseña (GitHub → tu foto → **Settings** → **Developer settings** → **Personal access tokens** → generar uno con permiso **repo**).

### 1.4B — Ya tenías el repo clonado en otra carpeta del PC

Trabaja en la carpeta que sea tu **clon real** del mismo repo, o copia los archivos `.github` y `GITHUB-RUNNER-*.md` al clon, luego:

```powershell
cd RUTA_DE_TU_CLON
git add .github GITHUB-RUNNER-WINDOWS.md GITHUB-RUNNER-WINDOWS-PASO-A-PASO.md
git commit -m "Añade workflow deploy Windows"
git push origin main
```

---

# PARTE 2 — En el SERVIDOR Windows (RDP o local)

> Haz esta parte **conectado al servidor** (Escritorio remoto). Todo lo siguiente es **en el servidor**, no en tu PC.

## 2.1 Abrir PowerShell en el servidor

1. Clic en **Inicio** (Windows).
2. Escribe: `PowerShell`
3. Clic en **Windows PowerShell**.  
   (Opcional: clic derecho → **Ejecutar como administrador** — no siempre es obligatorio, pero ayuda si Git o permisos fallan.)

## 2.2 Comprobar Node, npm, Git, PM2

Escribe **cada línea** y pulsa Enter. Anota si alguna falla.

```powershell
node -v
npm -v
git --version
pm2 -v
```

- Si `git` no se reconoce: instala Git for Windows en **este servidor** y vuelve a abrir PowerShell.
- Si `pm2` falla: `npm install -g pm2` y cierra y abre PowerShell.

## 2.3 Crear la carpeta donde vivirá el código (si no existe)

```powershell
New-Item -ItemType Directory -Path C:\apps -Force
```

Si no quieres `C:\apps`, usa otra ruta, pero entonces **debe coincidir** con `$AppDir` en `deploy.yml` (vuelve al PC y edita `deploy.yml` si hace falta, commit, push).

## 2.4 Clonar el repositorio de GitHub en el servidor

1. Ve a la carpeta padre:

```powershell
cd C:\apps
```

2. Si **ya existe** una carpeta vieja con el mismo nombre y quieres empezar limpio, **solo si estás seguro** de que no necesitas nada de dentro:

```powershell
Remove-Item -Recurse -Force .\suminregio-microsip-api
```

(Si no existe, Git te dirá error en Remove-Item: ignóralo.)

3. Clona (sustituye la URL por la de tu repo):

```powershell
git clone https://github.com/TU_USUARIO/TU_REPO.git suminregio-microsip-api
```

4. Entra a la carpeta:

```powershell
cd C:\apps\suminregio-microsip-api
```

5. Comprueba que ves archivos como `package.json` y `server_corregido.js`:

```powershell
dir
```

## 2.5 Poner el archivo .env en el servidor

1. El archivo **`.env` no está en GitHub** (es secreto). Debes **crearlo o copiarlo** dentro de:

`C:\apps\suminregio-microsip-api`

2. Si ya tienes un `.env` en otra carpeta del servidor, **cópialo**:
   - Explorador de archivos → copia el archivo → pégalo en `C:\apps\suminregio-microsip-api`
3. Si no tienes, copia `.env.example` a `.env` y edítalo con Bloc de notas:
   - En PowerShell:

```powershell
cd C:\apps\suminregio-microsip-api
copy .env.example .env
notepad .env
```

4. Guarda (`Ctrl+S`) y cierra Notepad.

## 2.6 Instalar dependencias y arrancar el API con PM2

1. En PowerShell (en la carpeta del proyecto):

```powershell
cd C:\apps\suminregio-microsip-api
npm install
```

2. Si **ya** tenías un proceso PM2 llamado `microsip-api` apuntando a **otra** carpeta, bórralo primero:

```powershell
pm2 delete microsip-api
```

(Si dice que no existe, no pasa nada.)

3. Arranca el servidor con PM2 usando el script `start` del `package.json`:

```powershell
pm2 start npm --name microsip-api -- start
```

4. Ver estado:

```powershell
pm2 status
```

Debe verse `microsip-api` **online**.

5. Probar en el **navegador del servidor**:

`http://127.0.0.1:7000/api/ping`

(Si el puerto es otro, mira en `.env` la variable `PORT`.)

## 2.7 Guardar la lista de PM2 (recomendado)

```powershell
pm2 save
```

---

# PARTE 3 — En el SERVIDOR: instalar el “runner” de GitHub

## 3.1 En el navegador (puede ser en tu PC o en el servidor)

1. Abre **Chrome** o **Edge**.
2. Entra a: `https://github.com`
3. Inicia sesión.
4. Abre **tu repositorio** (el del API).
5. Arriba haz clic en **Settings** (Configuración del repo).
6. Menú izquierdo: haz clic en **Actions**.
7. Submenú: haz clic en **Runners**.
8. Botón **New self-hosted runner** (Nuevo ejecutor autohospedado).

## 3.2 Elegir sistema en la página de GitHub

1. En **Runner image** elige **Windows**.
2. En **Architecture** elige **x64** (64-bit).

## 3.3 Copiar los comandos que muestra GitHub

La página muestra varios bloques. **No cierres esa pestaña** hasta terminar la configuración.

Verás algo como:

1. **Download** — un comando `Invoke-WebRequest` con una URL larga y un `Expand-Archive`.
2. **Configure** — un comando `.\config.cmd` con `--url` y `--token`.

El **token** es de un solo uso y **caduca en pocos minutos**. Si tardas mucho, vuelve a la página y genera otro runner para obtener token nuevo.

## 3.4 En el SERVIDOR: carpeta del runner

En **PowerShell del servidor**:

```powershell
mkdir C:\actions-runner -Force
cd C:\actions-runner
```

## 3.5 En el SERVIDOR: descargar el zip del runner

1. En la página de GitHub, **selecciona con el mouse** el comando completo de **Download** (Invoke-WebRequest + Expand-Archive).
2. **Copia** (Ctrl+C).
3. Pégalo en PowerShell del servidor (**clic derecho** pega) y pulsa **Enter**.
4. Espera a que termine sin errores.

Si la página da **dos pasos** separados (primero descargar, luego extraer), ejecútalos **en orden** tal cual los copias.

## 3.6 En el SERVIDOR: configurar el runner (config.cmd)

1. En la página de GitHub, copia la línea que empieza por:

`.\config.cmd --url https://github.com/... --token XXXXX`

2. Pégala en PowerShell **estando en** `C:\actions-runner` y pulsa Enter.

3. Te hará preguntas en la consola:

| Pregunta (resumen) | Qué poner |
|--------------------|-----------|
| Runner group | Pulsa **Enter** (default). |
| Name of the runner | Escribe por ejemplo `servidor-suminregio` y Enter. |
| Labels | Pulsa **Enter** (deja las etiquetas por defecto). |
| Work folder | Pulsa **Enter** (default `_work`). |

4. Al final debe decir que la configuración terminó correctamente.

## 3.7 Probar el runner (ventana abierta)

1. En PowerShell, **sigue** en `C:\actions-runner`.
2. Ejecuta:

```powershell
.\run.cmd
```

3. **No cierres** esta ventana todavía.
4. Ve a GitHub → **Settings** → **Actions** → **Runners**.
5. Debe aparecer tu runner en verde con estado **Idle** (inactivo esperando).

## 3.8 Disparar un job de prueba (opcional pero recomendable)

1. En tu **PC**, haz un cambio mínimo (por ejemplo un espacio en un README) y:

```powershell
git add .
git commit -m "prueba runner"
git push origin main
```

2. GitHub → pestaña **Actions**.
3. Debe aparecer un workflow ejecutándose. Entra al run y mira los pasos.
4. Si falla, lee el mensaje en rojo (ruta, pm2, git).

5. En el servidor, en la ventana donde corre `run.cmd`, verás líneas moviéndose cuando hay un job.

6. Cuando termines la prueba: en la ventana de `run.cmd` pulsa **Ctrl + C** para detener el runner en primer plano.

## 3.9 Instalar el runner como SERVICIO de Windows (para que no dependa de la ventana)

1. PowerShell **como administrador** (clic derecho Inicio → Windows PowerShell **Administrador**).
2. Ejecuta:

```powershell
cd C:\actions-runner
.\svc install
.\svc start
```

3. Abre **services.msc** (Win+R, escribe `services.msc`, Enter).
4. Busca un servicio cuyo nombre contenga **actions.runner** o **GitHub Actions**.
5. Comprueba que esté **En ejecución**.

Desde ahora el runner arranca con Windows y no necesitas `run.cmd` abierto.

---

# PARTE 4 — Asegurar que Git en el servidor puede hacer `pull` sin ti

Cuando el workflow corre, ejecuta `git fetch` / `git reset` en `C:\apps\suminregio-microsip-api`. Ese usuario (a veces **NETWORK SERVICE** si el servicio del runner no usa tu usuario) debe poder leer GitHub.

**Opción simple (mismo usuario):** instalaste el runner y el servicio con **tu usuario de dominio/local** que ya hizo `git clone` — a veces basta.

**Si el job falla en “git” o “permission denied”:**

1. Abre **services.msc**.
2. Clic derecho en el servicio del **GitHub Actions Runner** → **Propiedades** → pestaña **Iniciar sesión como**.
3. Pon **Esta cuenta** y usa el mismo usuario con el que hiciste `git clone` y que tiene credenciales guardadas, **o** configura **SSH** para ese usuario.

**Opción HTTPS con token:** en el servidor, una vez:

```powershell
cd C:\apps\suminregio-microsip-api
git config --global credential.helper manager
git pull
```

Inicia sesión cuando pida; así se guarda para futuros `pull` del mismo usuario.

---

# PARTE 5 — Tu rutina diaria (después de que todo funcione)

1. En tu **PC**: editas código o corres `export-suminregio-deploy.ps1` y trabajas en la carpeta del repo.
2. **Guardas** archivos.
3. En PowerShell en la carpeta del repo:

```powershell
git add .
git commit -m "Describe el cambio"
git push origin main
```

4. En GitHub → **Actions** → esperas a que el workflow termine en **verde**.
5. Pruebas el API en el navegador (local o URL pública).

---

# Si algo sale mal (dónde mirar)

| Síntoma | Dónde mirar |
|---------|-------------|
| El workflow no arranca | **Actions** → ¿aparece el workflow? ¿La rama es `main`? |
| Falla en “No existe la carpeta” | `deploy.yml` → `$AppDir` debe ser **exactamente** la ruta del clone en el servidor. |
| Falla `pm2` no reconocido | En el servidor: `where.exe pm2`. Pon esa ruta completa en el YAML en lugar de `pm2`. |
| Falla `git` | Instalar Git; o `safe.directory` (el workflow ya intenta añadirlo). |
| El sitio no cambia | `pm2 logs microsip-api` en el servidor. ¿El job fue verde? |

---

# Archivos de referencia en el repo

- `.github/workflows/deploy.yml` — lo que ejecuta GitHub en el servidor.
- `GITHUB-RUNNER-WINDOWS.md` — versión más corta y notas técnicas.
- Este archivo — versión **con pinzas**.

Cuando GitHub cambie la pantalla de “New self-hosted runner”, los nombres de los menús pueden variar un poco, pero el orden suele ser: **Settings → Actions → Runners → New self-hosted runner**.
