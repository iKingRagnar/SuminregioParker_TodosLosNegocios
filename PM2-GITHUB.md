# PM2 + GitHub — qué va en el repo y qué no

## Archivos que **sí** se sincronizan con `git pull` / GitHub Actions

| Archivo | Para qué |
|---------|-----------|
| `ecosystem.config.cjs` | Arranque de **microsip-api** (`server_corregido.js`) |
| `ecosystem-ngrok.config.cjs` | Arranque de **ngrok-tunnel** (apunta al puerto de la API) |
| `scripts/levantar-pm2.cmd` | Opcional: sube API (+ ngrok si existe `ngrok.exe`) |

## Lo que **no** entra a Git (y por eso “desaparece” si borras la carpeta o no lo copias)

| Archivo | Qué hacer |
|---------|-----------|
| `ngrok.exe` | Descargar de [ngrok.com/download](https://ngrok.com/download) y ponerlo en la **raíz** del repo |
| `.env` | Crear en el servidor a partir de `PLANTILLA-ENV-SERVIDOR.txt` o tu plantilla (secretos, Firebird, etc.) |

**Importante:** `git clean -fd` borra archivos **no rastreados** por Git (incluido `ngrok.exe` y notas sueltas). **No lo uses** para “refrescar la web”; solo `git pull` / `git reset --hard origin/main` + `pm2 restart`.

---

## Primera vez en el **servidor** (Windows)

En CMD o PowerShell, en la carpeta del repo (ej. `C:\microsip-api` o la ruta de tu clone):

```cmd
cd /d C:\RUTA\AL\REPO
npm ci
pm2 start ecosystem.config.cjs
pm2 save
```

Comprueba: `http://127.0.0.1:7000/api/ping` (o el `PORT` de tu `.env`).

### Ngrok (opcional)

1. Copia `ngrok.exe` a la raíz del repo.  
2. `ngrok config add-authtoken TU_TOKEN`  
3. `pm2 start ecosystem-ngrok.config.cjs`  
4. `pm2 save`

Si cambias `PORT` en `.env`, ngrok usa la variable de entorno `PORT` al **generar** el archivo: en PM2 suele bastar con reiniciar tras editar `.env`; el `ecosystem-ngrok` por defecto usa `7000` si no hay `PORT` en el entorno del proceso. Para alinear siempre, puedes definir `PORT` en el mismo `.env` y reiniciar ambos procesos.

---

## Atajo desde CMD (repo ya clonado)

```cmd
scripts\levantar-pm2.cmd
```

Eso hace `pm2 start` de la API y, si existe `ngrok.exe`, del túnel; luego `pm2 save`.

---

## Después de cada `git pull` en el servidor

```cmd
npm ci
pm2 restart microsip-api
pm2 restart ngrok-tunnel
```

(Si no usas ngrok, omite la segunda línea.)

El workflow `.github/workflows/deploy.yml` hace `pull` + `npm ci` + `pm2 restart microsip-api`. Si quieres que también reinicie ngrok ahí, descomenta la línea indicada en ese YAML.

---

## Nombres en PM2

- `microsip-api` — debe coincidir con `ecosystem.config.cjs` y con `pm2 restart` del deploy.  
- `ngrok-tunnel` — coincide con `ecosystem-ngrok.config.cjs`.

Si alguna vez creaste el proceso con otro nombre, o bien `pm2 delete NOMBRE_VIEJO` y vuelve a `pm2 start ecosystem.config.cjs`, o ajusta el YAML a tu nombre actual.
