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

## Prohibido (a menos que el usuario lo pida EXPLÍCITAMENTE)

- ❌ Cambiar la lógica del P&L / Estado de Resultados (fuente, filtros PV, conta vs docs).
  Un cambio así rompió las cifras (mostró $9M consolidado) y se tuvo que revertir TODO.
- ❌ Tocar queries, filtros de DOCTOS_VE/DOCTOS_PV, consolidación de empresas.
- ❌ Cambios "de mejora" no pedidos (vendorizar libs, layout, cards, etc.).
- ❌ Afirmar cifras de memoria. No tengo acceso a los datos en vivo (la red bloquea el
  dominio de producción), así que NUNCA confirmar un número exacto sin que el usuario lo valide.

## Antes de entregar
- Hacer SOLO lo pedido, mínimo y superficial. Si dudo del alcance, **preguntar**, no asumir.
