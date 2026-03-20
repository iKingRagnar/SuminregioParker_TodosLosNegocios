# Git + servidor remoto (una sola fuente de verdad)

## Repo en GitHub

- **Remoto:** `https://github.com/iKingRagnar/SuminregioParker_TodosLosNegocios.git`
- **Rama:** `main`

## Identidad Git (commits con tu nombre en GitHub)

Ejecuta **una vez** en tu PC (donde haces `git push`):

```bat
git config --global user.name "iKingRagnar."
git config --global user.email "guillermorc44@gmail.com"
```

Comprobar:

```bat
git config --global --list
```

*(Solo en este proyecto, sin `--global`, también vale: `git config user.name "..."` dentro de la carpeta del repo.)*

## Carpeta donde trabajamos en desarrollo (tu OneDrive)

Ejemplo (ajusta si tu ruta cambia):

`...\Cursor IA\microsip-api\Capeta microsip-api_20_03_2026\microsip-api\`

Ahí están `server_corregido.js`, `public\ventas.html`, etc.

## Servidor remoto (producción)

Tu flujo habitual:

```bat
cd C:\microsip-api
git pull origin main
pm2 restart all
```

**Importante:** `C:\microsip-api` debe ser **el mismo repositorio** clonado desde GitHub (`git clone ...`). Si esa carpeta es una copia manual vieja o otro proyecto, **`git pull` no traerá** lo que subimos desde la PC de desarrollo.

### Comprobar en el servidor que llegó lo nuevo

Después de `git pull`:

```bat
git log -1 --oneline
```

Debería verse el último commit (mensaje reciente).

### Si no ves "IA Suprema" en la web

1. **Forzar recarga:** `Ctrl + F5` en el navegador (evita caché).
2. Abrir **`/ventas.html`** (o la URL que uses) y mirar la **pestaña** y la **etiqueta amarilla** arriba a la derecha.
3. Clic derecho → **Ver código fuente** y buscar `BUILD_CHECK: IA-SUPREMA-v4`.
4. En el servidor, confirmar que PM2 arranca Node desde **`C:\microsip-api`** (misma carpeta donde hiciste `pull`). Si PM2 apunta a otra ruta, seguirás viendo archivos viejos.

## Resumen

| Lugar | Acción |
|--------|--------|
| PC desarrollo | `git add` / `commit` / `push origin main` |
| Servidor `C:\microsip-api` | `git pull origin main` → `pm2 restart all` |
