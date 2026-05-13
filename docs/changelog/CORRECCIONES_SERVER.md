# Correcciones para server_corregido.js

Aplica estos cambios en tu `server_corregido.js` para que **Vendedores** y **Clientes** muestren datos correctamente y respeten los filtros (año, mes, vendedor).

**Importante:** El archivo `filters.js` ya está creado en el proyecto (antes estaba el código dentro de `env`). Las páginas deben abrirse desde **http://localhost:7000** (arrancando el servidor con `node server_corregido.js`). Si no tienes `server_corregido.js`, renombra o copia tu servidor a ese nombre y aplica estos parches.

---

## 1. `/api/ventas/cumplimiento` — Aplicar filtros (anio, mes, desde, hasta, vendedor)

**Problema:** El endpoint ignoraba los parámetros que envía el front (anio, mes, vendedor), por eso al filtrar no cambiaban los datos.

**Sustituir** todo el bloque `get('/api/ventas/cumplimiento', async (req) => { ... });` por el siguiente (hasta el cierre `});` de ese get):

```javascript
get('/api/ventas/cumplimiento', async (req) => {
  const f = buildFiltros(req, 'd');
  const anioQ = req.query.anio ? parseInt(req.query.anio) : null;
  const mesQ  = req.query.mes  ? parseInt(req.query.mes)  : null;
  const vendedorQ = req.query.vendedor ? parseInt(req.query.vendedor) : null;
  const desde = req.query.desde;
  const hasta = req.query.hasta;

  const [metas]  = await query(`SELECT COALESCE(MAX(META_DIARIA_POR_VENDEDOR),0) AS META_DIA, COALESCE(MAX(META_IDEAL_POR_VENDEDOR),0) AS META_IDEAL FROM CONFIGURACIONES_GEN`).catch(()=>[{META_DIA:5650,META_IDEAL:6500}]);
  const metaDia  = +(metas?.META_DIA  || 5650);
  const metaIdeal= +(metas?.META_IDEAL|| 6500);

  // Periodo: si hay desde/hasta usamos eso; si no, anio/mes o año actual
  let condAnioMes = 'EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)';
  let diasTranscurridos = 22;
  if (desde && hasta && /^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    condAnioMes = `CAST(d.FECHA AS DATE) >= CAST('${desde}' AS DATE) AND CAST(d.FECHA AS DATE) <= CAST('${hasta}' AS DATE)`;
    diasTranscurridos = Math.ceil((new Date(hasta) - new Date(desde)) / 86400000) + 1;
    diasTranscurridos = Math.min(Math.max(diasTranscurridos, 1), 31);
  } else if (anioQ) {
    condAnioMes = `EXTRACT(YEAR FROM d.FECHA) = ${anioQ}`;
    if (mesQ) {
      condAnioMes += ` AND EXTRACT(MONTH FROM d.FECHA) = ${mesQ}`;
      const daysInMonth = new Date(anioQ, mesQ, 0).getDate();
      const today = new Date();
      diasTranscurridos = (anioQ === today.getFullYear() && mesQ === today.getMonth() + 1)
        ? today.getDate() : daysInMonth;
    } else {
      const today = new Date();
      if (anioQ === today.getFullYear()) {
        const jan1 = new Date(anioQ, 0, 1);
        diasTranscurridos = Math.ceil((today - jan1) / 86400000) + 1;
      } else {
        diasTranscurridos = 365;
      }
    }
  }

  const condVendedor = vendedorQ ? ` AND d.VENDEDOR_ID = ${vendedorQ}` : '';

  const ventas = await query(`
    SELECT
      d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_HOY,
      SUM(CASE WHEN ${condAnioMes.replace(/EXTRACT\(YEAR FROM d\.FECHA\)|EXTRACT\(MONTH FROM d\.FECHA\)|CAST\(d\.FECHA AS DATE\)/g, (m)=>m)} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_MES,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = ${anioQ || 'EXTRACT(YEAR FROM CURRENT_DATE)'} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_YTD,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS FACTURAS_HOY,
      SUM(CASE WHEN ${condAnioMes.replace(/EXTRACT\(YEAR FROM d\.FECHA\)|EXTRACT\(MONTH FROM d\.FECHA\)|CAST\(d\.FECHA AS DATE\)/g, (m)=>m)} THEN 1 ELSE 0 END) AS FACTURAS_MES
    FROM ${ventasSub()} d
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    GROUP BY d.VENDEDOR_ID
  `).catch(()=>[]);

  const ventaMap = {};
  ventas.forEach(v => { ventaMap[v.VENDEDOR_ID] = v; });

  const rows = await query(`
    SELECT DISTINCT d.VENDEDOR_ID,
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS NOMBRE
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    ORDER BY 2
  `, []).catch(async () => {
    return query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES ORDER BY NOMBRE`).catch(()=>[]);
  });

  const metaMes = metaDia * Math.max(diasTranscurridos, 1);
  const rowsMapped = rows.map(v => {
    const d = ventaMap[v.VENDEDOR_ID] || {};
    return {
      NOMBRE       : v.NOMBRE,
      VENDEDOR_ID  : v.VENDEDOR_ID,
      VENTA_HOY    : +d.VENTA_HOY    || 0,
      VENTA_MES    : +d.VENTA_MES    || 0,
      VENTA_YTD    : +d.VENTA_YTD    || 0,
      FACTURAS_HOY : +d.FACTURAS_HOY || 0,
      FACTURAS_MES : +d.FACTURAS_MES || 0,
    };
  }).sort((a,b) => b.VENTA_MES - a.VENTA_MES);

  return rowsMapped.map(r => ({
    ...r,
    META_DIA          : metaDia,
    META_MES          : metaMes,
    META_IDEAL        : metaIdeal,
    PCT_HOY           : metaDia  > 0 ? Math.round(+r.VENTA_HOY / metaDia  * 100) : 0,
    PCT_MES           : metaMes  > 0 ? Math.round(+r.VENTA_MES / metaMes  * 100) : 0,
    DIAS_TRANSCURRIDOS: diasTranscurridos,
    STATUS_HOY        : metaDia  > 0 ? (+r.VENTA_HOY >= metaDia  ? 'OK' : +r.VENTA_HOY >= metaDia  * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
    STATUS_MES        : metaMes  > 0 ? (+r.VENTA_MES >= metaMes  ? 'OK' : +r.VENTA_MES >= metaMes  * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
  }));
});
```

**Nota:** La consulta SQL anterior es compleja. Usa mejor la **1b** siguiente.

---

## 1b. Cumplimiento — versión simple (recomendada): respetar anio, mes y vendedor

En tu `server_corregido.js`, **localiza** el handler `get('/api/ventas/cumplimiento', async (req) => {` y **justo después** de la línea que define `metaIdeal` (algo como `const metaIdeal= +(metas?.META_IDEAL|| 6500);`), **añade** estas líneas:

```javascript
  const anio = req.query.anio ? parseInt(req.query.anio) : null;
  const mes  = req.query.mes  ? parseInt(req.query.mes)  : null;
  const vendedorId = req.query.vendedor ? parseInt(req.query.vendedor) : null;
  const y = anio ?? new Date().getFullYear();
  const m = mes  ?? (new Date().getMonth() + 1);
  const condPeriodo = `EXTRACT(YEAR FROM d.FECHA) = ${y} AND EXTRACT(MONTH FROM d.FECHA) = ${m}`;
  const condVend = vendedorId ? ` AND d.VENDEDOR_ID = ${vendedorId}` : '';
```

Luego **sustituye** en ese mismo handler:

- La línea que dice algo como:  
  `WHERE EXTRACT(YEAR  FROM d.FECHA) = EXTRACT(YEAR  FROM CURRENT_DATE)`  
  por:  
  `WHERE ${condPeriodo}`  

- Y la parte que agrupa/filtra por vendedor, añade al final del WHERE: `${condVend}`  

- Donde calculas `diasTranscurridos` (por ejemplo con `diasMes`), si usas el mes actual del servidor, déjalo; si quieres que sea el mes filtrado, puedes usar:  
  `const diasTranscurridos = (y === new Date().getFullYear() && m === new Date().getMonth() + 1) ? new Date().getDate() : new Date(y, m, 0).getDate();`

---

## 2. `/api/ventas/por-vendedor/cotizaciones` — Aplicar filtros

**Sustituir** el handler completo por:

```javascript
get('/api/ventas/por-vendedor/cotizaciones', async (req) => {
  const f = buildFiltros(req, 'd');
  const anio = req.query.anio ? parseInt(req.query.anio) : null;
  const mes  = req.query.mes  ? parseInt(req.query.mes)  : null;
  const y = anio || new Date().getFullYear();
  const m = mes  || (new Date().getMonth() + 1);
  const condPeriodo = `EXTRACT(YEAR FROM d.FECHA) = ${y} AND EXTRACT(MONTH FROM d.FECHA) = ${m}`;
  const condVend = f.params.some((p, i) => f.sql.includes('VENDEDOR_ID') && i === f.params.length - 1)
    ? '' : (req.query.vendedor ? ` AND d.VENDEDOR_ID = ${parseInt(req.query.vendedor)}` : '');
  return query(`
    SELECT
      v.NOMBRE AS VENDEDOR,
      d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS COTIZACIONES_HOY,
      SUM(CASE WHEN ${condPeriodo} THEN d.IMPORTE_NETO ELSE 0 END) AS COTIZACIONES_MES,
      COUNT(CASE WHEN ${condPeriodo} THEN 1 END) AS NUM_COTI_MES
    FROM DOCTOS_VE d
    JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C'
      AND ${condPeriodo} ${condVend}
    GROUP BY v.NOMBRE, d.VENDEDOR_ID
    ORDER BY COTIZACIONES_MES DESC
  `);
});
```

---

## 3. `/api/clientes/resumen-riesgo` — Siempre devolver objeto con claves

**Sustituir** el return por uno que garantice todas las claves:

```javascript
get('/api/clientes/resumen-riesgo', async () => {
  const defaultRes = {
    TOTAL_EN_RIESGO: 0,
    MONTO_CRITICO: 0,
    MONTO_ALTO: 0,
    MONTO_MEDIO: 0,
    MONTO_LEVE: 0,
  };
  try {
    const [totales] = await query(`
      SELECT
        COUNT(DISTINCT cd.CLIENTE_ID) AS TOTAL_EN_RIESGO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 90  THEN cd.SALDO ELSE 0 END) AS MONTO_CRITICO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 60 AND cd.DIAS_VENCIDO <= 90 THEN cd.SALDO ELSE 0 END) AS MONTO_ALTO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 30 AND cd.DIAS_VENCIDO <= 60 THEN cd.SALDO ELSE 0 END) AS MONTO_MEDIO,
        SUM(CASE WHEN cd.DIAS_VENCIDO <= 30 THEN cd.SALDO ELSE 0 END) AS MONTO_LEVE
      FROM ${cxcCargosSQL()} cd
      WHERE cd.DIAS_VENCIDO > 0
    `).catch(() => [null]);
    return { ...defaultRes, ...(totales || {}) };
  } catch (e) {
    return defaultRes;
  }
});
```

---

## 4. `/api/clientes/riesgo` — Devolver [] en error

Asegúrate de que al final del handler tengas:

```javascript
}).catch(()=>[]);
```

y que si la query falla, devuelvas `[]` (no undefined). Si ya tienes `.catch(()=>[])` en el `query()`, está bien; si no, envuelve todo el handler en try/catch y en catch haz `return [];`.

---

## 5. `/api/clientes/inactivos` — Devolver [] en error

Igual: al final del `query(...).catch(()=>[])` ya devuelves array. Si en algún punto haces otro await sin catch, envuelve en try/catch y `return [];` en catch.

---

## 6. Frontend: usar el mismo origen que el servidor

En **vendedores.html** y **clientes.html**, asegúrate de que la variable `API` apunte al servidor cuando abras los HTML por archivo (file://). Por ejemplo:

```javascript
// Si abres por file://, no hay API; si abres por http://localhost:7000, API = ''
const API = (function(){
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  if (origin.startsWith('http') && (origin.includes('7000') || origin.includes('localhost'))) return '';
  if (origin === 'file://' || origin === 'null') return 'http://localhost:7000';
  return '';
})();
```

Así, al abrir `http://localhost:7000/vendedores.html` las peticiones van a `/api/...` (mismo origen) y verás datos.

---

## Resumen

| Qué | Dónde | Acción |
|-----|--------|--------|
| Filtros en cumplimiento | `get('/api/ventas/cumplimiento'` | Usar anio, mes, desde, hasta, vendedor en las consultas |
| Filtros en cotizaciones | `get('/api/ventas/por-vendedor/cotizaciones'` | Añadir anio, mes, vendedor |
| Resumen riesgo siempre objeto | `get('/api/clientes/resumen-riesgo'` | Devolver defaultRes con 0 y merge con totales |
| Riesgo / inactivos sin romper | clientes/riesgo e inactivos | Asegurar .catch(()=>[]) o try/catch return [] |
| API base en HTML | vendedores.html, clientes.html | Definir API para file:// → localhost:7000 |

Después de aplicar las correcciones, reinicia el servidor (`node server_corregido.js`) y abre las páginas desde `http://localhost:7000/vendedores.html` y `http://localhost:7000/clientes.html`.
