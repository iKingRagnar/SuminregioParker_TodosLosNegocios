/**
 * xlsx-export.js — Export a Excel real (.xlsx) con formato
 * Extiende window.SumiExport con exportTableToRealXLSX()
 * Usa SheetJS lazy-loaded desde CDN solo cuando se necesita.
 */
(function () {
  'use strict';

  let sheetjsPromise = null;
  function loadSheetJS() {
    if (sheetjsPromise) return sheetjsPromise;
    sheetjsPromise = new Promise(function (resolve, reject) {
      if (window.XLSX) return resolve(window.XLSX);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.20.3/dist/xlsx.full.min.js';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('No se pudo cargar SheetJS')); };
      document.head.appendChild(s);
    });
    return sheetjsPromise;
  }

  function tableToAOA(table) {
    const rows = [];
    table.querySelectorAll('tr').forEach(function (tr) {
      const row = [];
      tr.querySelectorAll('th,td').forEach(function (cell) {
        let v = (cell.innerText || cell.textContent || '').trim().replace(/\s+/g, ' ');
        // Intento de parse numérico (para que Excel los trate como número)
        if (/^-?\$?[\d,.]+$/.test(v)) {
          const n = parseFloat(v.replace(/[^\d.-]/g, ''));
          if (!isNaN(n)) v = n;
        }
        row.push(v);
      });
      rows.push(row);
    });
    return rows;
  }

  async function exportTableToRealXLSX(table, filename) {
    const XLSX = await loadSheetJS();
    const aoa = tableToAOA(table);
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Auto-width por columna
    const widths = [];
    aoa.forEach(function (row) {
      row.forEach(function (v, i) {
        const len = String(v == null ? '' : v).length;
        widths[i] = Math.max(widths[i] || 8, Math.min(40, len + 2));
      });
    });
    ws['!cols'] = widths.map(function (w) { return { wch: w }; });

    // Freeze header
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    XLSX.writeFile(wb, (filename || 'reporte') + '.xlsx');
  }

  if (window.SumiExport) {
    window.SumiExport.exportTableToRealXLSX = exportTableToRealXLSX;
  } else {
    window.SumiExport = { exportTableToRealXLSX: exportTableToRealXLSX };
  }
})();
