/**
 * Fragmento para pegar en server_corregido.js
 * Reemplaza solo la lógica de filtro de periodo y vendedor dentro de get('/api/ventas/cumplimiento', ...)
 *
 * Después de:
 *   const metaIdeal= +(metas?.META_IDEAL|| 6500);
 *
 * Pega estas líneas:
 */
function _snippet_cumplimiento_filtros(req) {
  const anio = req.query.anio ? parseInt(req.query.anio) : null;
  const mes  = req.query.mes  ? parseInt(req.query.mes)  : null;
  const vendedorId = req.query.vendedor ? parseInt(req.query.vendedor) : null;
  const y = anio ?? new Date().getFullYear();
  const m = mes  ?? (new Date().getMonth() + 1);
  const condPeriodo = `EXTRACT(YEAR FROM d.FECHA) = ${y} AND EXTRACT(MONTH FROM d.FECHA) = ${m}`;
  const condVend = vendedorId ? ` AND d.VENDEDOR_ID = ${vendedorId}` : '';
  const today = new Date();
  const diasTranscurridos = (y === today.getFullYear() && m === today.getMonth() + 1)
    ? today.getDate()
    : new Date(y, m, 0).getDate();
  return { condPeriodo, condVend, diasTranscurridos: Math.max(diasTranscurridos, 1) };
}

// En la query de "ventas", cambia el WHERE a:
//   WHERE ${condPeriodo} AND d.VENDEDOR_ID > 0 ${condVend}
// En la query de "rows" (vendedores con ventas), mismo WHERE.
// Usa diasTranscurridos del snippet para metaMes = metaDia * diasTranscurridos.

module.exports = { _snippet_cumplimiento_filtros };
