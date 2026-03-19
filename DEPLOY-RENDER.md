# GitHub + Render + servidor Windows — Suminregio / Microsip API

## 1. Carpeta lista para Git

En PowerShell (desde el repo `microsip-api`):

```powershell
.\scripts\export-suminregio-deploy.ps1
```

Se crea `suminregio-microsip-deploy\` con `server_corregido.js`, `public\` (HTML, `nav.js`, `ai-widget.css`, `ai-assistant.js`, …), `package.json`, `AGENTS.md`, `.env.example`, etc. (sin `node_modules`, sin carpetas *Respaldo*).

## 2. Nuevo repositorio en GitHub

1. GitHub → **New repository** → nombre ej. `suminregio-microsip-api` → **sin** README/.gitignore si vas a hacer `git init` local (evita conflicto en el primer push).
2. En la carpeta generada:

```powershell
cd suminregio-microsip-deploy
git init
git add .
git commit -m "Initial deploy bundle"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/suminregio-microsip-api.git
git push -u origin main
```

**Siguientes cambios:** editas en `microsip-api_Beto\...\microsip-api (Del Remoto)\`, vuelves a ejecutar `export-suminregio-deploy.ps1`, entras a `suminregio-microsip-deploy`, `git add .`, `git commit`, `git push`.

## 3. Render — qué hacer en la página (crear el Web Service)

Abre [dashboard.render.com](https://dashboard.render.com) e inicia sesión.

### 3.1 Conectar GitHub (solo la primera vez)

1. Menú de tu cuenta (arriba a la derecha) → **Account Settings** (o al crear el servicio te lo pedirá).
2. Busca **Connected accounts** / **GitHub** → **Connect**.
3. Autoriza a Render en GitHub y elige si compartes **todos** los repos o solo los que selecciones.

### 3.2 Crear el servicio

1. En el dashboard: botón **New +** → **Web Service**.
2. Si aparece la lista de repos, elige el repositorio que subiste (ej. `suminregio-microsip-api`). Si no sale, pulsa **Configure account** y revisa permisos de GitHub.
3. Completa el formulario:

| Campo en Render | Qué poner |
|-----------------|-----------|
| **Name** | Cualquier nombre (ej. `suminregio-api`). La URL será `https://NOMBRE.onrender.com`. |
| **Region** | El más cercano a tus usuarios (o a tu servidor Firebird si aplica latencia). |
| **Branch** | `main` (o la rama desde la que despliegas). |
| **Root Directory** | **Déjalo vacío** si el `package.json` está en la raíz del repo (caso del bundle `suminregio-microsip-deploy`). Si el código viviera en una subcarpeta, pondrías aquí esa carpeta. |
| **Runtime** | **Node** |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance type** | Free / Starter según presupuesto. Free puede “enfriarse” tras inactividad (primer request lento). |

4. Desplázate a **Environment** (mismo formulario inicial) y añade las variables del **apartado 4** (puedes añadir las mínimas primero, guardar, y completar después).
5. Pulsa **Create Web Service**. Render clonará el repo, ejecutará `npm install` y luego `npm start`.

### 3.3 Después del primer deploy

- Pestaña **Logs**: ves la salida de Node; si falla el build o el arranque, el error aparece ahí.
- Pestaña **Events**: historial de despliegues.
- Si cambias código: **Manual Deploy** → **Clear build cache & deploy** solo si sospechas caché corrupta; lo normal es un push a Git.
- **Settings** → **Custom Domain** si más adelante quieres tu propio dominio (aparte de `*.onrender.com`).

---

## 4. Variables de entorno en Render (pestaña Environment)

### 4.1 Dónde están

1. En el dashboard, entra a tu **Web Service**.
2. Menú lateral → **Environment**.
3. **Add environment variable** → **Key** = nombre exacto (ej. `FB_HOST`), **Value** = valor.
4. Para contraseñas y API keys, marca **Secret** si Render lo ofrece (oculta el valor en la UI).
5. **Save Changes**. Render suele **reiniciar el servicio solo** para aplicar cambios (espera a que termine el deploy).

### 4.2 Lista de variables (copia desde tu `.env` local; no las subas a Git)

| Key | Obligatorio | Notas |
|-----|-------------|--------|
| `FB_HOST` | Sí (si usas Firebird) | IP o hostname **alcanzable desde internet** donde escucha Firebird (no `127.0.0.1` de tu PC a menos que uses túnel/VPN). |
| `FB_PORT` | Sí | Casi siempre `3050`. |
| `FB_USER` | Sí | Ideal: usuario **solo lectura** en Firebird. |
| `FB_PASSWORD` | Sí | Marca como **Secret**. |
| `FB_DATABASE` | Sí* | Ruta del `.fdb` **tal como la ve el servidor Firebird** (ej. `C:/Microsip datos/ARCHIVO.FDB`). *O usa solo `FB_DATABASES_JSON` multi-empresa. |
| `FB_DATABASES_JSON` | Opcional | JSON en **una línea** en el campo Value (varias empresas `.fdb` en el mismo host). |
| `EMPRESA_NOMBRE` | Opcional | Texto para `/api/ping` y mensajes. |
| `CORS_ORIGIN` | Opcional | Ej. `https://tu-servicio.onrender.com` o `*` en pruebas (más permisivo). |
| `READ_ONLY_MODE` | Opcional | `1` para bloquear `POST /api/email/enviar`. |
| `OPENAI_API_KEY` | Opcional | Necesaria para el **Agente de Soporte** (chat IA). **Secret**. |
| `OPENAI_API_BASE` | Opcional | Por defecto API de OpenAI; otro proveedor compatible si aplica. |
| `OPENAI_MODEL` | Opcional | Ej. `gpt-4o-mini`. |
| `PORT` | **No hace falta definirla** | Render asigna `PORT` automáticamente; el código ya usa `process.env.PORT`. |

### 4.3 Firebird y Render (muy importante)

El contenedor de Render está en la nube: para conectar a Microsip tiene que existir un camino de red hasta tu Firebird (IP pública del servidor, reglas de firewall abriendo `FB_PORT`, o VPN/túnel tipo Tailscale/Cloudflare Tunnel). Si dejas `FB_HOST=127.0.0.1` en Render, estarías apuntando al **propio contenedor**, no a tu oficina.

### 4.4 Probar que las variables aplicaron

Tras guardar y redeploy, en el navegador:

- `https://TU-SERVICIO.onrender.com/api/ping` → debe responder JSON con `ok: true`.
- Si Firebird no conecta, en **Logs** verás errores de `node-firebird` al primer endpoint que toque la base.

## 5. Actualizar la app

```powershell
git add .
git commit -m "Descripción"
git push
```

Render redeploy automático si está enlazado a la rama `main`.

## 6. Probar

- `GET https://TU_SERVICIO.onrender.com/api/ping`
- Abrir `https://TU_SERVICIO.onrender.com/index.html` o `.../resultados.html` (Express sirve `public/` en la raíz de la URL, **no** hace falta `/public/`).

---

## 7. Servidor propio (Windows): manipular por CMD o PowerShell

Aquí Node y Firebird corren **en tu máquina o VPS Windows** (no Render). La idea es: el código vive en una carpeta clonada o copiada desde Git; actualizas con `git pull` y reinicias el proceso.

### 7.1 Primera instalación (una sola vez)

1. Instalar [Node.js LTS](https://nodejs.org) y [Git para Windows](https://git-scm.com/download/win).
2. Clonar el repo (HTTPS o SSH):

```cmd
cd C:\
mkdir apps
cd apps
git clone https://github.com/TU_USUARIO/suminregio-microsip-api.git
cd suminregio-microsip-api
```

3. Crear `.env` a partir de `.env.example` (Bloc de notas o `notepad .env`) y poner rutas reales de Firebird, usuario de solo lectura, etc.

4. Instalar dependencias:

```cmd
npm install
```

5. Probar en consola:

```cmd
npm start
```

Deberías ver algo como `Suminregio API escuchando en http://localhost:7000`. En otra ventana:

```cmd
curl http://127.0.0.1:7000/api/ping
```

(En PowerShell también puedes usar `Invoke-RestMethod http://127.0.0.1:7000/api/ping`.)

### 7.2 Actualizar cuando subes cambios a GitHub

```cmd
cd C:\apps\suminregio-microsip-api
git pull
npm install
```

Luego **reinicia** el proceso Node (cierra la ventana donde corría `npm start` y vuelve a ejecutarlo, o reinicia el servicio si usas NSSM/PM2 abajo).

### 7.3 Dejarlo corriendo “como servicio” (opciones)

| Opción | Idea breve |
|--------|------------|
| **Ventana fija** | `npm start` en una sesión que no cierres (simple, poco formal). |
| **NSSM** | Instala Node como servicio Windows que ejecuta `node server_corregido.js` en la carpeta del proyecto. |
| **PM2** (`npm i -g pm2`) | `pm2 start server_corregido.js --name suminregio` y `pm2 save` / `pm2 startup` (en Windows suele usarse el módulo de inicio que indica PM2). |
| **Programador de tareas** | Tarea al inicio que ejecute `node C:\apps\...\server_corregido.js` con “Iniciar en” = carpeta del proyecto. |

En todos los casos, las variables pueden leerse de un archivo `.env` en esa misma carpeta (el servidor ya usa `dotenv`).

### 7.4 Firebird en el mismo servidor

- Rutas en `.env` tipo `FB_DATABASE=C:\Microsip datos\ARCHIVO.FDB` son rutas **vistas por el proceso Firebird en ese equipo**, no por tu PC de casa.
- Reiniciar el servicio Firebird (ejemplo, nombre típico del servicio; el tuyo puede variar):

```cmd
net stop FirebirdServerDefaultInstance
net start FirebirdServerDefaultInstance
```

(Abrí **services.msc** para ver el nombre exacto.) Herramientas como **isql** o **FlameRobin** son aparte del API Node; el dashboard solo **consulta** por TCP al puerto `FB_PORT` (3050 por defecto).

### 7.5 Render vs servidor Windows

| | **Render (nube)** | **Windows en tu oficina** |
|--|-------------------|---------------------------|
| Actualizar código | `git push` → redeploy automático | `git pull` + reiniciar Node |
| Variables | Panel Environment de Render | Archivo `.env` o variables del servicio |
| Firebird | Debe ser IP/hostname **público o VPN** hacia tu servidor Firebird | `127.0.0.1` o localhost si Firebird está en la misma máquina |
| “Entrar por CMD” | No hay SSH en el plan gratuito típico; usas logs en el panel | Sí: RDP o consola local, `git`, `node`, `npm` |
