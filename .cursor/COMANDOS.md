# Comandos — microsip-api (PowerShell, Windows)

Raíz del workspace: `C:\Users\ragna\Downloads\microsip-api`

Las reglas Cursor **siempre-comandos** y **suminregio-git-deploy** obligan a usar rutas explícitas y comandos completos cuando haya git, deploy o verificación.

---

## Ir al proyecto

```powershell
cd C:\Users\ragna\Downloads\microsip-api
```

---

## Git (subir cambios a `main`)

```powershell
cd C:\Users\ragna\Downloads\microsip-api; git status; git add -A; git commit -m "mensaje claro"; git push origin main
```

Solo archivos concretos:

```powershell
cd C:\Users\ragna\Downloads\microsip-api; git add ruta\archivo.ext; git commit -m "mensaje claro"; git push origin main
```

---

## Verificación API (Render / producción)

```powershell
curl.exe -s "https://suminregioparker-todoslosnegocios.onrender.com/api/ping"
```

Comprobar en el JSON el campo `build` u otros que uses.

---

## Servidor remoto (después del `git pull` — lo ejecuta el usuario en la máquina servidor)

```powershell
cd C:\microsip-api
git pull origin main
pm2 restart all
```

(Ajusta `C:\microsip-api` si el clon está en otra ruta.)

---

## Desarrollo local (Node)

`npm start` ejecuta `node server_corregido.js` (ver `package.json`).

```powershell
cd C:\Users\ragna\Downloads\microsip-api; npm install
```

```powershell
cd C:\Users\ragna\Downloads\microsip-api; npm start
```

PM2 local (opcional):

```powershell
cd C:\Users\ragna\Downloads\microsip-api; npm run pm2:api
```

---

## Cursor / agentes — dónde está qué

| Qué | Ruta |
|-----|------|
| Reglas siempre activas | `.cursor/rules/*.mdc` |
| Estándares Data/AI | `.cursor/rules/data-ai-core-standards.mdc` |
| Skill Data & AI (copia repo) | `.cursor/skills/data-ai-ecosystem-copilot/SKILL.md` |
| Índice para agentes | `AGENTS.md` (raíz del repo) |
