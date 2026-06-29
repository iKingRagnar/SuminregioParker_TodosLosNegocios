# CLAUDE.md — Reglas del proyecto (LEER ANTES DE TOCAR NADA)

> Memoria operativa. El usuario fue MUY claro: solo quiere cambios **superficiales**.
> NO tocar lógica, cifras, queries ni nada interno salvo que lo pida explícitamente.

## Lo único que el usuario pidió (y su alcance EXACTO)

1. **Etiqueta del filtro — SOLO display, SOLO el dropdown.**
   - La base de datos **`SUMINREGIO-PARKER.FDB`** (registro `id: "default"`) debe **MOSTRARSE
     como "Mangueras y Conexiones"** en el selector de unidad de negocio de los dashboards.
   - **NINGÚN negocio se llama así de verdad.** El negocio real es **Suminregio Parker**.
     "Mangueras y Conexiones" es un nombre de pantalla, nada más.
   - Implementado en `public/nav.js` → `buildDbSelector` → `dbDisplayLabel(d)`:
     si `d.id === 'default'` devuelve `"Mangueras y Conexiones"`; si no, el label real.
   - **NO** cambiar `EMPRESA_NOMBRE` (lo usan alertas y el asistente IA — deben seguir
     diciendo "Suminregio Parker"). **NO** cambiar `fb-databases.registry.json` ni el
     servidor: el API, datos, alertas, IA y la lógica quedan IGUAL.
   - Las demás unidades (Grupo Suminregio, Agua, Cartón, Maderas, Reciclaje, Suministros
     Médicos, los respaldos Parker `_ant`/`23jun`/`320`, PARKER-MFG, etc.) **NO se tocan**.

2. **Sin IVA en todo el proyecto.**
   - Ya es el **default** del código: `MICROSIP_VENTAS_INCLUIR_IMPUESTOS` vale `0` salvo que
     alguien lo ponga en `1`. Las cifras salen netas (IMPORTE_NETO). **No hay que cambiar nada.**

## Fuente de ventas — OPERATIVA (autorizado explícitamente por el usuario)

- El usuario confirmó que el valor CORRECTO de ventas es el **operativo (DOCTOS_VE + DOCTOS_PV)**:
  para **Mangueras y Conexiones, jun-2026 = $1,573,815.65** (VE $1,321,812.75 + PV $252,002.9).
- Por eso **Finanzas (P&L), Director y `/api/ventas/resumen` usan la fuente OPERATIVA por default**
  (`useConta = false`), y el PV del P&L está alineado con `ventasSub()`. **NO revertir a contable**
  (SALDOS_CO 4*); el contable daba $1,232,141.32 y NO cuadraba. El contable queda solo bajo
  `?pnl_ventas=conta` / `MICROSIP_PNL_USAR_VENTAS_CONTA=1`.
- ⚠️ La vista **CONSOLIDADA** (suma de las 6 empresas) muestra ~**$9M** operativo: **es la suma
  de todos los negocios, NO un error**. Cada negocio por separado muestra su número. NO confundir
  el consolidado con una sola unidad. (El $9M con "unidad seleccionada" del pasado fue un bug de
  scope/nav, ya revertido — NO volver a tocar el scope ni nav.js para esto.)

## Prohibido (a menos que el usuario lo pida EXPLÍCITAMENTE)

- ❌ Tocar el SCOPE del P&L (single-unit vs consolidado) ni la resolución de `db` en nav.js:
  eso fue lo que mostró $9M con una unidad seleccionada y se tuvo que revertir TODO.
- ❌ Tocar queries, filtros de DOCTOS_VE/DOCTOS_PV, consolidación de empresas.
- ❌ Cambios "de mejora" no pedidos (vendorizar libs, layout, cards, etc.).
- ❌ Afirmar cifras de memoria. No tengo acceso a los datos en vivo (la red bloquea el
  dominio de producción), así que NUNCA confirmar un número exacto sin que el usuario lo valide.

## Antes de entregar
- Hacer SOLO lo pedido, mínimo y superficial. Si dudo del alcance, **preguntar**, no asumir.
