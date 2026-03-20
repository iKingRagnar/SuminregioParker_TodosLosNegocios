# Handoff Cursor — Microsip API / ventas en cero

Documento para abrir en **otra computadora** con Cursor: pega este archivo en el chat o `@CURSOR_HANDOFF_VENTAS.md` y pide continuar el diagnóstico.

---

## Objetivo del usuario

- Los **KPI de ventas** (Ventas, Inicio, Director, cobradas “facturación”, etc.) muestran **$0 / 0 facturas** aunque en Microsip/Power BI sí hay movimiento.
- Hubo un intento de alinear con **DAX de Power BI** (líneas, filtros agresivos); **rompió** columnas (`PRECIO_UNITARIO`, etc.) y se **revirtió** a lógica por **cabecera `IMPORTE_NETO`** y tipos clásicos **F / V / R**.

---

## Repo y rutas clave

| Qué | Ruta |
|-----|------|
| Servidor principal | `server_corregido.js` |
| Filtros fecha/mes + `?db=` | `filters.js` (`filterBuildQS`, `getSelectedDbId`, `sessionStorage` `microsip_erp_db`) |
| Dashboard ventas | `public/ventas.html` |
| Inicio (KPI ventas) | `public/index.html` |
| Registro multi-FDB | `getReqDbOpts(req)`, `DATABASE_REGISTRY` / `fb-databases.registry.json`, env `FB_DATABASE`, `FB_DATABASE_DIR` |

---

## Diseño actual de ventas (backend)

- **`ventasSub(tipo)`** — `tipo`: `''` = VE+PV (`UNION ALL`), `'VE'`, `'PV'`.
- Fuentes: `DOCTOS_VE` y `DOCTOS_PV`, **una fila por documento**.
- Importe: **`sqlVentaImporteBaseExpr('d')`** sobre `IMPORTE_NETO`; divisor `.env` **`MICROSIP_VENTAS_SIN_IVA_DIVISOR`** (default ~1.16; `1` = sin dividir).
- **Documento válido** — `sqlWhereVentasDocumentoValido`:
  - `TIPO_DOCTO`: primer carácter normalizado (`sqlExprTipoDoctoChar1`) para cubrir códigos largos o CHAR relleno.
  - `ESTATUS`: `sqlExprEstatusNorm` (NULL/vacío → `'N'`) porque en Firebird `NULL <> 'C'` excluye la fila.
  - Reglas: **F** y no cancelada; **V** y no C/T; **R** y no C.
- **Cotizaciones**: `sqlWhereCotizacionActiva` — primer carácter en **C, O, Q** + no cancelada.
- **Consumos** (`consumosSub`): solo **F y V** (sin R), misma normalización de tipo/estatus.
- Se quitió en varios endpoints el filtro **`VENDEDOR_ID > 0`** para no perder facturas sin vendedor (`COALESCE` + “Sin vendedor” donde aplica).

---

## Por qué “sigue mal” (causas probables)

1. **Filtro de periodo**  
   `/api/ventas/resumen` (y la barra de filtros) suele mandar **`anio` + `mes`** (preset “Este mes”). Si la base solo tiene datos en años/meses viejos, el resumen del **mes actual** es **0** aunque haya millones de filas en la tabla.

2. **Errores SQL tragados**  
   Muchos endpoints siguen usando **`.catch(() => [])`**: fallo de conexión, timeout, columna inexistente → respuesta vacía → UI en cero **sin error visible**.  
   **Excepción reciente:** `/api/ventas/resumen` ahora hace **`console.error('[ventas/resumen]', …)`** en el `catch`.

3. **`TIPO_DOCTO` numérico u otro esquema**  
   Si al castear a VARCHAR el tipo queda como `'1'`, `'2'`… el primer carácter **no** es F/V/R → **0 documentos** en `ventasSub`. Hay que ampliar el criterio según los valores reales (ver debug).

4. **Multi-DB**  
   Si el front no manda el **`db`** correcto (id del registry), el servidor usa **`FB_DATABASE` por defecto** → otra empresa vacía o distinta.

5. **Rutas / HTML viejos**  
   Asegurar que se sirve `public/` y que no queda un `index.html` en raíz que opaque el bueno (comentario ya en `server_corregido.js`).

---

## Herramienta de diagnóstico (usar primero en la otra PC)

**GET** `/api/debug/ventas`  
Opcional: `?db=id_del_chip` `&anio=2024` `&mes=6`

Campos útiles:

| Campo | Interpretación |
|--------|----------------|
| `count_ventas_sub_union` | Docs que pasan el filtro KPI (VE+PV). Si es **0** → tipos/estatus o SQL roto. |
| `count_ventas_sub_mes` | Mismo filtro pero **solo ese mes/año**. Si union > 0 y esto = 0 → **problema de periodo**, no de lógica global. |
| `ventas_sub_union_error` / `ventas_sub_mes_error` | Error Firebird real. |
| `tipos_docto_ve`, `tipos_docto_pv`, `estatus_*` | Valores reales en la base. |
| `fechas_ve` (MIN_F / MAX_F) | Rango de fechas; contrastar con el mes filtrado en la UI. |
| `legacy_fv_noC_*` | Conteo antiguo (sin COALESCE en ESTATUS); solo referencia. |

---

## Próximos pasos sugeridos (para el siguiente chat)

1. Ejecutar `/api/debug/ventas` con el mismo `?db=` que la UI y pegar JSON (sin credenciales).
2. Si hay **`ventas_sub_*_error`**: corregir SQL o esquema (columna/ruta FDB).
3. Si **`count_ventas_sub_union` = 0** pero hay filas en `DOCTOS_*`: ajustar **`sqlWhereVentasDocumentoValido`** según `tipos_docto_*` (p. ej. mapeo numérico o más códigos).
4. Si union > 0 y mes = 0: **UI o default de fechas** (preset año / rango) o documentar que el mes actual no tiene datos.
5. Opcional: sustituir gradualmente **`.catch(() => [])`** en rutas de ventas por log + respuesta `{ error }` o flag de diagnóstico para no “mentir” con ceros.

---

## Cómo usar esto en Cursor (otra máquina)

1. Clona/copia el mismo repo y el mismo `.env` (FB_* , puerto).
2. Abre la carpeta del proyecto en Cursor.
3. Nuevo chat: *“Lee `CURSOR_HANDOFF_VENTAS.md` y continúa: ventas siguen mal; adjunto salida de `/api/debug/ventas`.”*

---

## Estado emocional / contexto

El usuario está frustrado porque los ceros parecen un bug de código cuando a menudo es **periodo + silencio de errores + tipos en Firebird**. El handoff prioriza **hechos verificables** (debug endpoint) sobre más cambios a ciegas.

---

## Fix crítico (por-vendedor)

**`/api/ventas/por-vendedor`** tenía en el `WHERE` el mes/año del **servidor** (`CURRENT_DATE`) **y** el filtro de la barra (`buildFiltros`). Eso es imposible salvo que el periodo seleccionado sea exactamente el mes calendario actual → tabla de vendedores **siempre vacía** al elegir “Mes anterior”, otro año, etc. **Corregido:** solo `WHERE 1=1 ${f.sql}` y agregados totales del periodo (`SUM` / `COUNT(*)`), con el mismo default `anio`/`mes` que `/api/ventas/resumen`.

---

*Última actualización: ventasSub + debug ventas; fix por-vendedor; resumen devuelve `_queryError` si falla la query; banner en `ventas.html` y aviso en `index.html`.*
