# GitHub Actions — runner autohospedado en Windows (deploy automático)

> **Guía ultra detallada (cada clic y comando):** abre **`GITHUB-RUNNER-WINDOWS-PASO-A-PASO.md`** en el mismo repo.

Objetivo: cada `git push` a la rama **`main`** hace en el servidor: `git pull` (reset a `main`), `npm ci` y `pm2 restart microsip-api`.

---

## Requisitos previos

- Repo en GitHub (el mismo que subes con el bundle `suminregio-microsip-deploy` o equivalente).
- En el **servidor Windows**: Node, npm, Git, PM2, y el proceso `microsip-api` ya creado con PM2.
- Rama por defecto del repo: **`main`** (si usas `master`, cambia `branches` en `.github/workflows/deploy.yml` o renombra la rama en GitHub).

---

## Parte 1 — Carpeta fija del API en el servidor (un solo `git clone`)

1. Entra al servidor (RDP).
2. Crea una carpeta, por ejemplo:

   `C:\apps\suminregio-microsip-api`

3. Abre **CMD** o **PowerShell** como el usuario con el que sueles trabajar (idealmente el mismo que usará el runner).

4. Clona **el mismo repositorio** de GitHub:

   ```powershell
   cd C:\apps
   git clone https://github.com/TU_USUARIO/TU_REPO.git suminregio-microsip-api
   cd suminregio-microsip-api
   ```

5. Copia tu archivo **`.env`** (no está en Git) dentro de `C:\apps\suminregio-microsip-api` con `FB_*`, etc.

6. Instala dependencias y arranca PM2 **desde esa carpeta**:

   ```powershell
   npm install
   pm2 start npm --name microsip-api -- start
   ```

   (Si ya tenías otro `pm2 start` apuntando a otra ruta, ajusta: `pm2 delete microsip-api` y vuelve a crear desde esta carpeta, o edita el workflow para usar tu ruta real.)

7. **Anota la ruta exacta** (ej. `C:\apps\suminregio-microsip-api`). Debe coincidir con la variable `$AppDir` en `.github/workflows/deploy.yml` del repo (edítala en tu PC, haz commit y push).

8. Para que `git pull` no pida contraseña en cada deploy:
   - **HTTPS:** inicia sesión una vez con Git Credential Manager al hacer `git pull`, o
   - **SSH:** clona con `git@github.com:...` y pon la clave SSH del usuario del servidor en GitHub (Deploy keys o tu usuario).

---

## Parte 2 — Registrar el runner en GitHub

1. En el navegador: tu repo en GitHub → **Settings** → **Actions** → **Runners** → **New self-hosted runner**.
2. Elige **Windows** y la arquitectura (64-bit).
3. GitHub muestra comandos; en el **servidor** (PowerShell):

   ```powershell
   mkdir C:\actions-runner
   cd C:\actions-runner
   ```

4. Descarga el zip que indica la página (línea `Invoke-WebRequest` …), descomprime en `C:\actions-runner` (sustituye la URL y el nombre del zip por los que te muestre GitHub).

5. Configura (usa el **token** que te da la página; caduca en poco tiempo):

   ```powershell
   .\config.cmd --url https://github.com/TU_USUARIO/TU_REPO --token COPIA_EL_TOKEN_AQUI
   ```

   Preguntas típicas:
   - **Runner group:** Enter (default).
   - **Name del runner:** por ejemplo `servidor-suminregio`.
   - **Labels:** Enter (acepta `self-hosted`, `Windows`, `X64`).
   - **Work folder:** Enter (default `_work`).

6. **Probar** una vez en primer plano:

   ```powershell
   .\run.cmd
   ```

   Deja la ventana abierta; en GitHub el runner debe aparecer **Idle** (verde). Haz un push a `main` y comprueba que el job corre.

7. **Instalar como servicio** (recomendado, para que no dependa de una ventana abierta):

   - Cierra `run.cmd` (Ctrl+C).
   - En la **misma** carpeta:

   ```powershell
   .\svc install
   .\svc start
   ```

   El servicio queda en ejecución automática al reiniciar el servidor (revisa en `services.msc` el nombre tipo `actions.runner.*`).

**Importante:** el servicio del runner suele ejecutarse como **NT AUTHORITY\NETWORK SERVICE** o la cuenta que elijas. Esa cuenta debe poder:
- Leer/escribir `C:\apps\suminregio-microsip-api`
- Ejecutar `git`, `node`, `npm`, `pm2` (a veces hace falta poner en el PATH del sistema las rutas de Node y `npm` global, o instalar el runner con un usuario que ya tenga todo en PATH).

Si `pm2` no se encuentra en el job, en el workflow puedes sustituir por la ruta completa, por ejemplo:

`& "$env:ProgramFiles\nodejs\npm.cmd" exec pm2 restart microsip-api`

(ajusta según `where.exe pm2` en el servidor.)

---

## Parte 3 — Subir el workflow al repo (desde tu PC)

1. En tu PC, en el proyecto Del Remoto o en la carpeta exportada, debe existir `.github/workflows/deploy.yml` (ya viene en el bundle si exportaste después de añadirlo).
2. Ajusta **una vez** la línea `$AppDir = 'C:\apps\suminregio-microsip-api'` a la ruta real del servidor.
3. Commit y push a **`main`**:

   ```powershell
   git add .github/workflows/deploy.yml
   git commit -m "ci: deploy self-hosted Windows"
   git push origin main
   ```

4. En GitHub → pestaña **Actions**: debería aparecer el workflow **Deploy Windows (self-hosted)** ejecutándose. Si falla, abre el job y lee el log (ruta incorrecta, `pm2` no encontrado, git sin permiso, etc.).

---

## Comportamiento del deploy

- En cada push a `main`, el job hace en el servidor:
  - `git fetch` + `checkout main` + `reset --hard origin/main` (la carpeta del clone queda **igual** que GitHub; los archivos no commiteados en el servidor se pierden en esa carpeta).
  - `npm ci --omit=dev`
  - `pm2 restart microsip-api`
- El archivo **`.env`** en el servidor **no** se toca (está en `.gitignore`).

---

## Resumen

| Dónde | Qué haces |
|-------|------------|
| Servidor | `git clone` en `C:\apps\...`, `.env`, `npm install`, PM2, instalar runner + `svc install` |
| Repo | `deploy.yml` con `$AppDir` correcto |
| Tu PC | Trabajas, `git push` a `main` → el servidor se actualiza solo |

Si algo falla, copia el mensaje del job en **Actions** y revísalo junto con `pm2 logs microsip-api` en el servidor.
