# 👥 Gestión de usuarios (login)

Los usuarios **NO se guardan en el código** (sería inseguro: quedaría público en
GitHub). Se configuran en la variable de entorno **`AUTH_USERS`** del servicio en
**Render**. Aquí está el paso a paso.

---

## ✅ Agregar a Ximena (admin — ve y edita TODO)

1. Entra a **Render** → tu servicio web → pestaña **Environment**.
2. Busca la variable **`AUTH_USERS`** (o créala si no existe).
3. Pega esta línea y **solo** cambia `AQUI_TU_CONTRASENA` por una contraseña real:

   ```
   ximenarodriguez@suminregio.com:AQUI_TU_CONTRASENA:admin
   ```

   - Si **ya hay** otros usuarios en `AUTH_USERS`, no la borres: agrégala al final
     separada con **`;`**. Ejemplo:

     ```
     robertog@suminregio.com:Pass1:admin;ximenarodriguez@suminregio.com:AQUI_TU_CONTRASENA:admin
     ```

4. Asegúrate de tener también estas variables (para que el login funcione):

   | Variable          | Valor                                            |
   |-------------------|--------------------------------------------------|
   | `AUTH_PROVIDER`   | `session`                                        |
   | `SESSION_SECRET`  | un texto largo aleatorio (genera uno, ver abajo) |

5. **Guarda** → Render reinicia solo.
6. Ximena entra en **`/login`** (la página de inicio de sesión) con su **correo**
   y la **contraseña** que pusiste. Como es `admin`, verá y editará **todo**
   (metas, admin, P&L, finanzas, IA, etc.).

> Genera un `SESSION_SECRET` seguro con:
> ```
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## 📋 Formato de `AUTH_USERS`

```
correo:contraseña:rol ; correo2:contraseña2:rol2 ; ...
```

- Separador entre usuarios: **`;`**
- Separador de campos: **`:`**
- La **contraseña no debe contener** `:` ni `;`.
- El correo se trata en **minúsculas**.

### Roles disponibles

| Rol        | Qué ve                                                                    |
|------------|---------------------------------------------------------------------------|
| `admin`    | **Todo**: dashboards, P&L/Finanzas, Admin, edición de Metas, IA, etc.     |
| `gerente`  | Casi todo (ventas, CxC, inventario, clientes) **sin** P&L/Finanzas ni Admin. |
| `vendedor` | Solo sus ventas (vista acotada). Requiere `AUTH_VENDEDOR_MAP`.            |

- Varios roles a la vez: sepáralos con coma → `admin,gerente`.

### Ejemplo completo (NO uses estas claves reales)

```
AUTH_USERS=robertog@suminregio.com:SuPassFuerte1:admin;ximenarodriguez@suminregio.com:SuPassFuerte2:admin;ana.v@suminregio.com:SuPassFuerte3:vendedor
AUTH_VENDEDOR_MAP=ana.v@suminregio.com:42
```
(`AUTH_VENDEDOR_MAP` solo es necesario para cuentas **solo-vendedor**: mapea el
correo al `VENDEDOR_ID` de Microsip; sin él, sus APIs devuelven 403.)

---

## 🔁 Quitar o cambiar un usuario

- **Quitar**: borra su tramo `correo:pass:rol;` de `AUTH_USERS` y guarda.
- **Cambiar contraseña**: edita su `:contraseña:` en la línea y guarda.
- **Cambiar rol**: edita el último campo (`:admin` / `:gerente` / `:vendedor`).

Cualquier cambio en `AUTH_USERS` se aplica tras el reinicio automático de Render.
