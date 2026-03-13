# Código para Claude — Suminregio Parker ERP

Copia este archivo y los 5 archivos listados abajo (abre cada uno y copia todo el contenido) y pásaselos a Claude en texto plano.

---

## LO QUE AÚN NO SE HA PODIDO SOLUCIONAR (decirle esto a Claude)

- **ventas.html:** Las gráficas **Ventas Diarias** y **Cotizaciones Diarias** siguen sin mostrar datos reales (o se ven vacías / ejes raros). Se añadieron fallbacks con 30 días en cero cuando la API devuelve vacío; el usuario reporta que las gráficas "no se ven".
- **cobradas.html:** La página se queda en "Cargando" o muestra "Sin datos de facturas cobradas" aunque existan datos. Se usó fwt() con timeout y siempre renderAll(); el problema persiste.
- **vendedores.html:** **Tendencia Diaria del Equipo (30 días)** y **TENDENCIA DE COBROS (6 MESES)** siguen sin mostrar datos en las gráficas; solo "% Cumplimiento vs Meta Mensual" muestra datos.
- **resultados.html:** El P&L sigue sin dar datos útiles: Costo de ventas "Sin datos", Utilidad Bruta = Ventas Netas, Margen al 100%. En el servidor se añadió costo desde DOCTOS_IN con TIPO_DOCTO STARTING WITH 'S' y PRECIO_UNITARIO*UNIDADES; si en Microsip el esquema es distinto (p. ej. TIPO_MOV en vez de TIPO_DOCTO, o costo en otra tabla), hay que ajustar la consulta.

**Base de datos:** Firebird 3.0. Contexto en el mensaje del usuario (tablas DOCTOS_VE, DOCTOS_PV, DOCTOS_IN, IMPORTES_DOCTOS_CC, etc.). **No usar defaultPreset:'mes'** en initFilters para no filtrar por mes actual en la primera carga.

---

## Archivos con el código (copiar todo el contenido de cada uno)

1. **ventas.html** — ruta: `ventas.html`
2. **cobradas.html** — ruta: `cobradas.html`
3. **vendedores.html** — ruta: `vendedores.html`
4. **inventario.html** — ruta: `inventario.html`
5. **server_corregido.js** — ruta: `server_corregido.js`

Abre cada archivo en el editor, selecciona todo (Ctrl+A) y copia. Pega en el chat con Claude después de la nota de arriba.
