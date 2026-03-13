// ═══════════════════════════════════════════════════════════
//  VENTAS — RESÚMENES
// ═══════════════════════════════════════════════════════════

get('/api/ventas/resumen', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const sql = `SELECT COUNT(*) AS NUM_FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}`;
  const rows = await query(sql, f.params).catch(() => [{ NUM_FACTURAS: 0, TOTAL: 0 }]);
  return rows[0] || { NUM_FACTURAS: 0, TOTAL: 0 };
});

get('/api/ventas/cotizaciones/resumen', async (req) => {
  const f = buildFiltros(req, 'd');
  const sql = `SELECT COUNT(*) AS NUM_COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM DOCTOS_VE d WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' ${f.sql}`;
  const rows = await query(sql, f.params).catch(() => [{ NUM_COTIZACIONES: 0, TOTAL: 0 }]);
  return rows[0] || { NUM_COTIZACIONES: 0, TOTAL: 0 };
});

get('/api/ventas/diarias', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params).catch(() => []);
});

get('/api/ventas/semanales', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/mensuales', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/cotizaciones/diarias', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM DOCTOS_VE d WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params).catch(() => []);
});

get('/api/ventas/cotizaciones/semanales', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM DOCTOS_VE d WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/cotizaciones/mensuales', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM DOCTOS_VE d WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/top-clientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  return query(`
    SELECT d.CLIENTE_ID, c.NOMBRE AS CLIENTE, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL DESC
    FETCH FIRST ${limit} ROWS ONLY
  `, f.params).catch(() => []);
});

get('/api/ventas/por-vendedor', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE AS VENDEDOR, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.VENDEDOR_ID > 0 ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE ORDER BY TOTAL DESC
  `, f.params).catch(() => []);
});

get('/api/ventas/por-vendedor/cotizaciones', async (req) => {
  const f = buildFiltros(req, 'd');
  const anio = req.query.anio ? parseInt(req.query.anio) : null;
  const mes = req.query.mes ? parseInt(req.query.mes) : null;
  const y = anio || new Date().getFullYear();
  const m = mes || (new Date().getMonth() + 1);
  const condPeriodo = `EXTRACT(YEAR FROM d.FECHA) = ${y} AND EXTRACT(MONTH FROM d.FECHA) = ${m}`;
  const condVend = req.query.vendedor ? ` AND d.VENDEDOR_ID = ${parseInt(req.query.vendedor)}` : '';
  return query(`
    SELECT v.NOMBRE AS VENDEDOR, d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS COTIZACIONES_HOY,
      SUM(CASE WHEN ${condPeriodo} THEN d.IMPORTE_NETO ELSE 0 END) AS COTIZACIONES_MES,
      COUNT(CASE WHEN ${condPeriodo} THEN 1 END) AS NUM_COTI_MES
    FROM DOCTOS_VE d
    JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' AND ${condPeriodo} ${condVend}
    GROUP BY v.NOMBRE, d.VENDEDOR_ID ORDER BY COTIZACIONES_MES DESC
  `).catch(() => []);
});

get('/api/ventas/recientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  return query(`
    SELECT d.FECHA, d.FOLIO, d.IMPORTE_NETO, d.CLIENTE_ID, c.NOMBRE AS CLIENTE, d.VENDEDOR_ID
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE 1=1 ${f.sql}
    ORDER BY d.FECHA DESC FETCH FIRST ${limit} ROWS ONLY
  `, f.params).catch(() => []);
});

get('/api/ventas/vs-cotizaciones', async (req) => {
  const f = buildFiltros(req, 'd');
  const [ventas, cotiz] = await Promise.all([
    query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL FROM ${ventasSub(getTipo(req))} d WHERE 1=1 ${f.sql}`, f.params).catch(() => [{ TOTAL: 0 }]),
    query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL FROM DOCTOS_VE d WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' ${f.sql}`, f.params).catch(() => [{ TOTAL: 0 }]),
  ]);
  return { ventas: +(ventas[0] && ventas[0].TOTAL) || 0, cotizaciones: +(cotiz[0] && cotiz[0].TOTAL) || 0 };
});

get('/api/ventas/ranking-clientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT d.CLIENTE_ID, c.NOMBRE, COALESCE(SUM(d.IMPORTE_NETO),0) AS VENTA
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY VENTA DESC
  `, f.params).catch(() => []);
});

get('/api/ventas/cobradas', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE, COUNT(DISTINCT d.FOLIO) AS FACTURAS_COBRADAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.VENDEDOR_ID > 0 ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE
  `, f.params).catch(() => []);
});

get('/api/ventas/margen', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COALESCE(SUM(det.PRECIO_TOTAL - COALESCE(det.COSTO_TOTAL, 0)), 0) AS MARGEN,
      COALESCE(SUM(det.PRECIO_TOTAL), 0) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
  `, f.params).catch(() => []);
});

get('/api/ventas/margen-articulos', async (req) => {
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION, SUM(det.PRECIO_TOTAL - COALESCE(det.COSTO_TOTAL, 0)) AS MARGEN, SUM(det.PRECIO_TOTAL) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY a.ARTICULO_ID, a.DESCRIPCION ORDER BY MARGEN DESC
    FETCH FIRST ${limit} ROWS ONLY
  `, f.params).catch(() => []);
});

get('/api/ventas/cotizaciones', async (req) => {
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  return query(`
    SELECT d.DOCTO_VE_ID, d.FECHA, d.FOLIO, d.IMPORTE_NETO, d.CLIENTE_ID, c.NOMBRE AS CLIENTE, d.VENDEDOR_ID
    FROM DOCTOS_VE d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.TIPO_DOCTO = 'C' AND d.ESTATUS <> 'C' ${f.sql}
    ORDER BY d.FECHA DESC FETCH FIRST ${limit} ROWS ONLY
  `, f.params).catch(() => []);
});

get('/api/ventas/vendedores', async () => {
  return query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`).catch(() => []);
});

get('/api/ventas/diario', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  VENTAS — CUMPLIMIENTO (con filtros anio, mes, vendedor)
// ═══════════════════════════════════════════════════════════

get('/api/ventas/cumplimiento', async (req) => {
  const f = buildFiltros(req, 'd');
  const anioQ = req.query.anio ? parseInt(req.query.anio) : null;
  const mesQ = req.query.mes ? parseInt(req.query.mes) : null;
  const vendedorQ = req.query.vendedor ? parseInt(req.query.vendedor) : null;
  const desde = req.query.desde;
  const hasta = req.query.hasta;

  const [metas] = await query(`SELECT COALESCE(MAX(META_DIARIA_POR_VENDEDOR),0) AS META_DIA, COALESCE(MAX(META_IDEAL_POR_VENDEDOR),0) AS META_IDEAL FROM CONFIGURACIONES_GEN`).catch(() => [{ META_DIA: 5650, META_IDEAL: 6500 }]);
  const metaDia = +(metas && metas.META_DIA) || 5650;
  const metaIdeal = +(metas && metas.META_IDEAL) || 6500;

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
      diasTranscurridos = (anioQ === today.getFullYear() && mesQ === today.getMonth() + 1) ? today.getDate() : daysInMonth;
    } else {
      const today = new Date();
      diasTranscurridos = (anioQ === today.getFullYear()) ? Math.ceil((today - new Date(anioQ, 0, 1)) / 86400000) + 1 : 365;
    }
  }

  const condVendedor = vendedorQ ? ` AND d.VENDEDOR_ID = ${vendedorQ}` : '';
  const anioExpr = anioQ || 'EXTRACT(YEAR FROM CURRENT_DATE)';

  const ventas = await query(`
    SELECT d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_HOY,
      SUM(CASE WHEN ${condAnioMes} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_MES,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = ${anioExpr} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_YTD,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS FACTURAS_HOY,
      SUM(CASE WHEN ${condAnioMes} THEN 1 ELSE 0 END) AS FACTURAS_MES
    FROM ${ventasSub()} d
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    GROUP BY d.VENDEDOR_ID
  `).catch(() => []);

  const ventaMap = {};
  (ventas || []).forEach(v => { ventaMap[v.VENDEDOR_ID] = v; });

  const rows = await query(`
    SELECT DISTINCT d.VENDEDOR_ID, COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS NOMBRE
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    ORDER BY 2
  `).catch(() => []);

  const metaMes = metaDia * Math.max(diasTranscurridos, 1);
  const rowsMapped = (rows || []).map(v => {
    const d = ventaMap[v.VENDEDOR_ID] || {};
    return {
      NOMBRE: v.NOMBRE,
      VENDEDOR_ID: v.VENDEDOR_ID,
      VENTA_HOY: +d.VENTA_HOY || 0,
      VENTA_MES: +d.VENTA_MES || 0,
      VENTA_YTD: +d.VENTA_YTD || 0,
      FACTURAS_HOY: +d.FACTURAS_HOY || 0,
      FACTURAS_MES: +d.FACTURAS_MES || 0,
    };
  }).sort((a, b) => b.VENTA_MES - a.VENTA_MES);

  return rowsMapped.map(r => ({
    ...r,
    META_DIA: metaDia,
    META_MES: metaMes,
    META_IDEAL: metaIdeal,
    PCT_HOY: metaDia > 0 ? Math.round(+r.VENTA_HOY / metaDia * 100) : 0,
    PCT_MES: metaMes > 0 ? Math.round(+r.VENTA_MES / metaMes * 100) : 0,
    DIAS_TRANSCURRIDOS: diasTranscurridos,
    STATUS_HOY: metaDia > 0 ? (+r.VENTA_HOY >= metaDia ? 'OK' : +r.VENTA_HOY >= metaDia * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
    STATUS_MES: metaMes > 0 ? (+r.VENTA_MES >= metaMes ? 'OK' : +r.VENTA_MES >= metaMes * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
  }));
});

// ═══════════════════════════════════════════════════════════
//  DIRECTOR
// ═══════════════════════════════════════════════════════════

get('/api/director/resumen', async () => {
  const [ventas, cxcSaldo, cxcAging] = await Promise.all([
    query(`SELECT COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL FROM ${ventasSub()} d WHERE EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)`).catch(() => [{ FACTURAS: 0, TOTAL: 0 }]),
    query(`SELECT COALESCE(SUM(s.SALDO),0) AS SALDO_TOTAL FROM ${cxcClienteSQL()} s`).catch(() => [{ SALDO_TOTAL: 0 }]),
    query(`SELECT COALESCE(SUM(cd.SALDO),0) AS VENCIDO FROM ${cxcCargosSQL()} cd WHERE cd.DIAS_VENCIDO > 0`).catch(() => [{ VENCIDO: 0 }]),
  ]);
  const saldo = +(cxcSaldo[0] && cxcSaldo[0].SALDO_TOTAL) || 0;
  const vencido = +(cxcAging[0] && cxcAging[0].VENCIDO) || 0;
  return {
    ventas_mes: +(ventas[0] && ventas[0].TOTAL) || 0,
    facturas_mes: +(ventas[0] && ventas[0].FACTURAS) || 0,
    cxc_saldo_total: saldo,
    cxc_vencido: vencido,
    cxc_vigente: saldo - vencido,
  };
});

get('/api/director/ventas-diarias', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub()} d WHERE 1=1 ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params).catch(() => []);
});

get('/api/director/top-clientes', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 15, 50);
  return query(`
    SELECT d.CLIENTE_ID, c.NOMBRE, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub()} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 AND EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE)
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL DESC
    FETCH FIRST ${limit} ROWS ONLY
  `).catch(() => []);
});

get('/api/director/vendedores', async () => {
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.VENDEDOR_ID > 0 AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
    GROUP BY d.VENDEDOR_ID, v.NOMBRE ORDER BY TOTAL DESC
  `).catch(() => []);
});

get('/api/director/recientes', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  return query(`
    SELECT d.FECHA, d.FOLIO, d.IMPORTE_NETO, c.NOMBRE AS CLIENTE
    FROM ${ventasSub()} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    ORDER BY d.FECHA DESC FETCH FIRST ${limit} ROWS ONLY
  `).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CXC
// ═══════════════════════════════════════════════════════════

get('/api/cxc/resumen', async () => {
  const [total, vencido] = await Promise.all([
    query(`SELECT COALESCE(SUM(s.SALDO),0) AS SALDO_TOTAL FROM ${cxcClienteSQL()} s`).catch(() => [{ SALDO_TOTAL: 0 }]),
    query(`SELECT COALESCE(SUM(cd.SALDO),0) AS VENCIDO FROM ${cxcCargosSQL()} cd WHERE cd.DIAS_VENCIDO > 0`).catch(() => [{ VENCIDO: 0 }]),
  ]);
  const st = +(total[0] && total[0].SALDO_TOTAL) || 0;
  const v = +(vencido[0] && vencido[0].VENCIDO) || 0;
  return { SALDO_TOTAL: st, VENCIDO: v, POR_VENCER: st - v };
});

get('/api/cxc/aging', async () => {
  return query(`
    SELECT cd.CLIENTE_ID, c.NOMBRE,
      SUM(CASE WHEN cd.DIAS_VENCIDO <= 0 THEN cd.SALDO ELSE 0 END) AS VIGENTE,
      SUM(CASE WHEN cd.DIAS_VENCIDO > 0 AND cd.DIAS_VENCIDO <= 30 THEN cd.SALDO ELSE 0 END) AS VENC_30,
      SUM(CASE WHEN cd.DIAS_VENCIDO > 30 AND cd.DIAS_VENCIDO <= 60 THEN cd.SALDO ELSE 0 END) AS VENC_60,
      SUM(CASE WHEN cd.DIAS_VENCIDO > 60 AND cd.DIAS_VENCIDO <= 90 THEN cd.SALDO ELSE 0 END) AS VENC_90,
      SUM(CASE WHEN cd.DIAS_VENCIDO > 90 THEN cd.SALDO ELSE 0 END) AS VENC_90_MAS,
      SUM(cd.SALDO) AS TOTAL
    FROM ${cxcCargosSQL()} cd
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = cd.CLIENTE_ID
    GROUP BY cd.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL DESC
  `).catch(() => []);
});

get('/api/cxc/vencidas', async () => {
  return query(`
    SELECT cd.CLIENTE_ID, c.NOMBRE, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO, cd.SALDO
    FROM ${cxcCargosSQL()} cd
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = cd.CLIENTE_ID
    WHERE cd.DIAS_VENCIDO > 0 ORDER BY cd.DIAS_VENCIDO DESC
  `).catch(() => []);
});

get('/api/cxc/top-deudores', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  return query(`
    SELECT s.CLIENTE_ID, c.NOMBRE, s.SALDO
    FROM ${cxcClienteSQL()} s
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = s.CLIENTE_ID
    ORDER BY s.SALDO DESC FETCH FIRST ${limit} ROWS ONLY
  `).catch(() => []);
});

get('/api/cxc/historial', async (req) => {
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO, cd.SALDO
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ?
    ORDER BY cd.FECHA_VENCIMIENTO
  `, [cliente]).catch(() => []);
});

get('/api/cxc/por-condicion', async () => {
  return query(`
    SELECT cp.COND_PAGO_ID, cp.NOMBRE AS CONDICION, COUNT(DISTINCT cd.CLIENTE_ID) AS CLIENTES, SUM(cd.SALDO) AS SALDO
    FROM ${cxcCargosSQL()} cd
    JOIN CLIENTES c ON c.CLIENTE_ID = cd.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = c.COND_PAGO_ID
    GROUP BY cp.COND_PAGO_ID, cp.NOMBRE ORDER BY SALDO DESC
  `).catch(() => []);
});

get('/api/cxc/historial-pagos', async (req) => {
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT dc.FECHA, dc.FOLIO, i.TIPO_IMPTE, i.IMPORTE, i.IMPUESTO
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    WHERE dc.CLIENTE_ID = ? AND COALESCE(i.CANCELADO,'N') = 'N'
    ORDER BY dc.FECHA DESC
  `, [cliente]).catch(() => []);
});

get('/api/cxc/comportamiento-pago', async (req) => {
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, AVG(cd.DIAS_VENCIDO) AS PROMEDIO_DIAS_VENCIDO, COUNT(*) AS DOCS_VENCIDOS
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ? AND cd.DIAS_VENCIDO > 0
    GROUP BY cd.CLIENTE_ID
  `, [cliente]).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  INVENTARIO
// ═══════════════════════════════════════════════════════════

get('/api/inv/resumen', async () => {
  const rows = await query(`
    SELECT COUNT(DISTINCT a.ARTICULO_ID) AS ARTICULOS, COALESCE(SUM(l.CANTIDAD),0) AS UNIDADES
    FROM ARTICULOS a
    LEFT JOIN (
      SELECT ARTICULO_ID, SUM(CANTIDAD) AS CANTIDAD FROM LINES_EXISTENCIA GROUP BY ARTICULO_ID
    ) l ON l.ARTICULO_ID = a.ARTICULO_ID
  `).catch(() => [{ ARTICULOS: 0, UNIDADES: 0 }]);
  return rows[0] || { ARTICULOS: 0, UNIDADES: 0 };
});

get('/api/inv/bajo-minimo', async () => {
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION, a.EXISTENCIA_MINIMA AS MINIMO,
      COALESCE(l.CANTIDAD, 0) AS EXISTENCIA
    FROM ARTICULOS a
    LEFT JOIN (SELECT ARTICULO_ID, SUM(CANTIDAD) AS CANTIDAD FROM LINES_EXISTENCIA GROUP BY ARTICULO_ID) l ON l.ARTICULO_ID = a.ARTICULO_ID
    WHERE a.EXISTENCIA_MINIMA > 0 AND COALESCE(l.CANTIDAD, 0) < a.EXISTENCIA_MINIMA
    ORDER BY l.CANTIDAD
  `).catch(() => []);
});

get('/api/inv/existencias', async (req) => {
  const almacen = req.query.almacen ? parseInt(req.query.almacen) : null;
  const sub = almacen
    ? `SELECT ARTICULO_ID, SUM(CANTIDAD) AS CANTIDAD FROM LINES_EXISTENCIA WHERE ALMACEN_ID = ${almacen} GROUP BY ARTICULO_ID`
    : `SELECT ARTICULO_ID, SUM(CANTIDAD) AS CANTIDAD FROM LINES_EXISTENCIA GROUP BY ARTICULO_ID`;
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION, COALESCE(l.CANTIDAD, 0) AS EXISTENCIA
    FROM ARTICULOS a
    LEFT JOIN (${sub}) l ON l.ARTICULO_ID = a.ARTICULO_ID
    ORDER BY a.DESCRIPCION
  `).catch(() => []);
});

get('/api/inv/top-stock', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION, COALESCE(l.CANTIDAD, 0) AS EXISTENCIA
    FROM ARTICULOS a
    LEFT JOIN (SELECT ARTICULO_ID, SUM(CANTIDAD) AS CANTIDAD FROM LINES_EXISTENCIA GROUP BY ARTICULO_ID) l ON l.ARTICULO_ID = a.ARTICULO_ID
    ORDER BY EXISTENCIA DESC FETCH FIRST ${limit} ROWS ONLY
  `).catch(() => []);
});

get('/api/inv/consumo-semanal', async () => {
  return query(`
    SELECT det.ARTICULO_ID, a.DESCRIPCION, SUM(det.CANTIDAD) AS CONSUMO
    FROM DOCTOS_IN d
    JOIN DOCTOS_IN_DET det ON det.DOCTO_IN_ID = d.DOCTO_IN_ID
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    WHERE d.TIPO_MOV = 'S' AND d.FECHA >= (CURRENT_DATE - 7)
    GROUP BY det.ARTICULO_ID, a.DESCRIPCION ORDER BY CONSUMO DESC
  `).catch(() => []);
});

get('/api/inv/consumo', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 30, 365);
  return query(`
    SELECT det.ARTICULO_ID, a.DESCRIPCION, SUM(det.CANTIDAD) AS CONSUMO
    FROM DOCTOS_IN d
    JOIN DOCTOS_IN_DET det ON det.DOCTO_IN_ID = d.DOCTO_IN_ID
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    WHERE d.TIPO_MOV = 'S' AND d.FECHA >= (CURRENT_DATE - ?)
    GROUP BY det.ARTICULO_ID, a.DESCRIPCION ORDER BY CONSUMO DESC
  `, [dias]).catch(() => []);
});

get('/api/inv/sin-movimiento', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 90, 365);
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION
    FROM ARTICULOS a
    WHERE NOT EXISTS (
      SELECT 1 FROM DOCTOS_IN_DET det
      JOIN DOCTOS_IN d ON d.DOCTO_IN_ID = det.DOCTO_IN_ID
      WHERE det.ARTICULO_ID = a.ARTICULO_ID AND d.FECHA >= (CURRENT_DATE - ?)
    )
    FETCH FIRST 200 ROWS ONLY
  `, [dias]).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CLIENTES (riesgo, inactivos, resumen-riesgo)
// ═══════════════════════════════════════════════════════════

get('/api/clientes/riesgo', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  return query(`
    SELECT cd.CLIENTE_ID, c.NOMBRE, SUM(cd.SALDO) AS SALDO, MAX(cd.DIAS_VENCIDO) AS MAX_DIAS_VENCIDO
    FROM ${cxcCargosSQL()} cd
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = cd.CLIENTE_ID
    WHERE cd.DIAS_VENCIDO > 0
    GROUP BY cd.CLIENTE_ID, c.NOMBRE ORDER BY MAX_DIAS_VENCIDO DESC
    FETCH FIRST ${limit} ROWS ONLY
  `).catch(() => []);
});

get('/api/clientes/inactivos', async (req) => {
  const meses = Math.min(parseInt(req.query.meses) || 12, 24);
  return query(`
    SELECT c.CLIENTE_ID, c.NOMBRE
    FROM CLIENTES c
    WHERE NOT EXISTS (
      SELECT 1 FROM DOCTOS_VE d
      WHERE d.CLIENTE_ID = c.CLIENTE_ID AND d.FECHA >= (CURRENT_DATE - ?)
    )
    FETCH FIRST 200 ROWS ONLY
  `, [meses * 31]).catch(() => []);
});

get('/api/clientes/resumen-riesgo', async () => {
  const defaultRes = { TOTAL_EN_RIESGO: 0, MONTO_CRITICO: 0, MONTO_ALTO: 0, MONTO_MEDIO: 0, MONTO_LEVE: 0 };
  try {
    const [totales] = await query(`
      SELECT COUNT(DISTINCT cd.CLIENTE_ID) AS TOTAL_EN_RIESGO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 90 THEN cd.SALDO ELSE 0 END) AS MONTO_CRITICO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 60 AND cd.DIAS_VENCIDO <= 90 THEN cd.SALDO ELSE 0 END) AS MONTO_ALTO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 30 AND cd.DIAS_VENCIDO <= 60 THEN cd.SALDO ELSE 0 END) AS MONTO_MEDIO,
        SUM(CASE WHEN cd.DIAS_VENCIDO <= 30 THEN cd.SALDO ELSE 0 END) AS MONTO_LEVE
      FROM ${cxcCargosSQL()} cd WHERE cd.DIAS_VENCIDO > 0
    `).catch(() => [null]);
    return { ...defaultRes, ...(totales || {}) };
  } catch (e) {
    return defaultRes;
  }
});

// ═══════════════════════════════════════════════════════════
//  RESULTADOS (P&L)
// ═══════════════════════════════════════════════════════════

get('/api/resultados/pnl', async (req) => {
  const f = buildFiltros(req, 'd');
  const [ventas, costos] = await Promise.all([
    query(`SELECT COALESCE(SUM(det.PRECIO_TOTAL),0) AS VENTA FROM DOCTOS_VE d JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C' ${f.sql}`, f.params).catch(() => [{ VENTA: 0 }]),
    query(`SELECT COALESCE(SUM(det.COSTO_TOTAL),0) AS COSTO FROM DOCTOS_VE d JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C' ${f.sql}`, f.params).catch(() => [{ COSTO: 0 }]),
  ]);
  const venta = +(ventas[0] && ventas[0].VENTA) || 0;
  const costo = +(costos[0] && costos[0].COSTO) || 0;
  return { venta, costo, margen: venta - costo, margen_pct: venta > 0 ? Math.round((venta - costo) / venta * 100) : 0 };
});

// ═══════════════════════════════════════════════════════════
//  DEBUG
// ═══════════════════════════════════════════════════════════

get('/api/debug/cxc', async () => {
  const [docs, importes, clientes] = await Promise.all([
    query(`SELECT COUNT(*) AS N FROM DOCTOS_CC`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM IMPORTES_DOCTOS_CC`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM CLIENTES`).catch(() => [{ N: 0 }]),
  ]);
  return { doctos_cc: docs[0].N, importes_cc: importes[0].N, clientes: clientes[0].N };
});

get('/api/debug/ventas', async () => {
  const [ve, pv] = await Promise.all([
    query(`SELECT COUNT(*) AS N FROM DOCTOS_VE WHERE (TIPO_DOCTO = 'F' OR TIPO_DOCTO = 'V') AND ESTATUS <> 'C'`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM DOCTOS_PV WHERE (TIPO_DOCTO = 'F' OR TIPO_DOCTO = 'V') AND ESTATUS <> 'C'`).catch(() => [{ N: 0 }]),
  ]);
  return { doctos_ve: ve[0].N, doctos_pv: pv[0].N };
});

get('/api/debug/pv', async () => {
  const rows = await query(`SELECT COUNT(*) AS N FROM DOCTOS_PV`).catch(() => [{ N: 0 }]);
  return { doctos_pv: rows[0].N };
});

get('/api/debug/cumplimiento', async () => {
  const rows = await query(`SELECT * FROM CONFIGURACIONES_GEN FETCH FIRST 1 ROWS ONLY`).catch(() => []);
  return { config: rows[0] || null };
});

get('/api/debug/inv', async () => {
  const [art, lines] = await Promise.all([
    query(`SELECT COUNT(*) AS N FROM ARTICULOS`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM LINES_EXISTENCIA`).catch(() => [{ N: 0 }]),
  ]);
  return { articulos: art[0].N, lines_existencia: lines[0].N };
});

get('/api/debug/schema', async () => {
  const tables = ['DOCTOS_VE', 'DOCTOS_CC', 'IMPORTES_DOCTOS_CC', 'CLIENTES', 'VENDEDORES'];
  const out = {};
  for (const t of tables) {
    try {
      const r = await query(`SELECT FIRST 1 * FROM ${t}`);
      out[t] = r[0] ? Object.keys(r[0]) : [];
    } catch (e) {
      out[t] = e.message;
    }
  }
  return out;
});

get('/api/debug/costo', async () => {
  const rows = await query(`
    SELECT d.DOCTO_VE_ID, det.ARTICULO_ID, det.PRECIO_TOTAL, det.COSTO_TOTAL
    FROM DOCTOS_VE d JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C'
    FETCH FIRST 5 ROWS ONLY
  `).catch(() => []);
  return { sample: rows };
});

// ═══════════════════════════════════════════════════════════
//  EMAIL (preview, enviar, cron)
// ═══════════════════════════════════════════════════════════

function generarReporteHTML(data) {
  if (!data) data = {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte</title></head><body>
  <h1>Reporte Suminregio</h1>
  <p>Generado: ${new Date().toISOString()}</p>
  <pre>${JSON.stringify(data, null, 2)}</pre>
  </body></html>`;
}

get('/api/email/preview', async (req) => {
  const [ventas, cxc] = await Promise.all([
    query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS T FROM ${ventasSub()} d WHERE EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)`).catch(() => [{ T: 0 }]),
    query(`SELECT COALESCE(SUM(s.SALDO),0) AS T FROM ${cxcClienteSQL()} s`).catch(() => [{ T: 0 }]),
  ]);
  const html = generarReporteHTML({
    ventas_mes: +(ventas[0] && ventas[0].T) || 0,
    cxc_saldo: +(cxc[0] && cxc[0].T) || 0,
  });
  return { html };
});

app.post('/api/email/enviar', async (req, res) => {
  try {
    const { destinos, asunto, cuerpo } = req.body || {};
    const html = cuerpo || generarReporteHTML({ mensaje: 'Sin datos' });
    // Stub: no envía correo real sin nodemailer configurado
    res.json({ ok: true, mensaje: 'Envío simulado (configurar nodemailer para envío real)' });
  } catch (e) {
    console.error('[ERROR] /api/email/enviar', e.message);
    res.status(500).json({ error: e.message });
  }
});

function iniciarCronEmail() {
  // Stub: no programa tareas sin cron configurado
  try {
    if (typeof setInterval !== 'undefined') setInterval(() => {}, 86400000);
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
//  PING & SERVER
// ═══════════════════════════════════════════════════════════

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

iniciarCronEmail();

app.listen(PORT, () => {
  console.log(`Suminregio API escuchando en http://localhost:${PORT}`);
});
