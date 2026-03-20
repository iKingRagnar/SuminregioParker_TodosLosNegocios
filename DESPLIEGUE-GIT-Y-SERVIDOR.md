# Git + servidor: por qué “no pasa nada” y qué revisar

## 1. ¿Tu PC tiene remoto de Git?

En la carpeta del clon:

```cmd
git remote -v
```

Si **no sale nada**, `git push` **no sube a GitHub** (no hay `origin`). Crea el remoto una vez:

```cmd
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin master
```

(Ajusta URL y rama: `main` si tu repo usa `main`.)

---

## 2. Dos copias del API: la que editamos ≠ la de la raíz del repo

En tu disco hay al menos:

| Ubicación | `server_corregido.js` (aprox.) |
|-----------|--------------------------------|
| Raíz del repo `microsip-api\` | ~78 KB (más viejo) |
| `microsip-api_Beto\...\microsip-api (Del Remoto)\` | ~135 KB (**código nuevo**: multi-empresa, CxC, registry, etc.) |

El servidor en `C:\microsip-api` suele ser la **raíz del proyecto** (un solo `server_corregido.js` al lado de `package.json`).

Si en tu PC haces `commit`/`push` solo de la **raíz** y **nunca copias** (o no versionas) la carpeta **Del Remoto**, el `git pull` en el servidor **no trae** esos cambios.

**Opciones (elige una):**

**A – Una sola fuente de verdad (recomendado)**  
Copia desde **Del Remoto** hacia la carpeta que sí despliegas (la misma estructura que en el servidor: `server_corregido.js`, `public\`, `nav.js`, `filters.js`, `fb-databases.registry.json`, etc.) y **haz commit ahí** antes del `push`.

**B – Versionar la carpeta Del Remoto**  
Añade y commitea `microsip-api_Beto\...\(Del Remoto)\` al repo (o mueve ese contenido a la raíz del repo y unifica). En el servidor, el `cd` del API debe ser **esa** carpeta al arrancar PM2.

---

## 3. La carpeta `microsip-api_Beto` estaba sin seguimiento

Si `git status` mostraba `?? microsip-api_Beto\`, Git **ignoraba** todo lo de dentro hasta que hagas:

```cmd
git add microsip-api_Beto
git commit -m "..."
git push
```

Si no añades esa ruta (o no copias los archivos a la raíz), **nunca suben**.

---

## 4. Servidor: mismo repo, misma rama

Después del `pull`:

```cmd
cd C:\microsip-api
git status
git log -1 --oneline
```

Comprueba que el último commit es el que acabas de subir. Si hay **conflictos** o cambios locales en el servidor, el `pull` puede fallar o mezclar mal; a veces hace falta `git stash` o resolver conflictos.

---

## 5. PM2: nombre del proceso y carpeta de trabajo

Lista procesos:

```cmd
pm2 list
```

El nombre puede **no** ser `microsip-api`. Reinicia el que corresponda:

```cmd
pm2 restart all
```

o

```cmd
pm2 restart ID_O_NOMBRE
```

Confirma en `ecosystem.config.cjs` (o como lo tengas) que **`cwd`** apunta a la carpeta donde está el `server_corregido.js` que acabas de actualizar.

---

## 6. `.env` no va en Git

El `.env` del servidor **no** se actualiza con `git pull`. Tienes que editarlo **en el servidor** (OpenAI, `FB_DATABASE`, `FB_DATABASE_DIR`, etc.).

---

## 7. Comprobación rápida de que el deploy funcionó

En el servidor, tras el restart:

```cmd
findstr /C:"fb-databases.registry" server_corregido.js
```

(o abre el archivo y mira la fecha/tamaño).  
En el navegador: `https://TU_HOST/api/universe/databases` debe listar las bases que configuraste.

---

## Resumen

1. `git remote -v` debe mostrar **origin**.  
2. Lo que **commiteas y pusheas** debe ser **el mismo árbol** que el servidor ejecuta.  
3. Hoy el código nuevo está sobre todo en **`microsip-api (Del Remoto)`**: hay que **unificar** con la carpeta del servidor o **versionar** esa ruta.  
4. `pm2 restart` con el **nombre correcto** y **cwd** correcto.
