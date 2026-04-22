/**
 * export-utils.js — Exportación PDF/Excel client-side sin dependencias
 * ──────────────────────────────────────────────────────────────────────────────
 * Expone window.SumiExport con:
 *   · exportTableToCSV(table, filename)
 *   · exportTableToXLSX(table, filename)   (CSV con BOM UTF-8; Excel lo abre)
 *   · exportSectionToPDF(element, filename) (usa window.print scoped a la sección)
 *   · mountExportButtons(container, opts)  (inyecta botones en una card/section)
 *
 * Botones se auto-inyectan en toda card que tenga atributo data-export="true".
 */
(function () {
  'use strict';

  function toCSV(table) {
    var rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
    return rows.map(function (tr) {
      return Array.prototype.slice.call(tr.children).map(function (cell) {
        var txt = (cell.innerText || cell.textContent || '').trim().replace(/\s+/g, ' ');
        if (/[",\n;]/.test(txt)) txt = '"' + txt.replace(/"/g, '""') + '"';
        return txt;
      }).join(',');
    }).join('\r\n');
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }

  function ts() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '_' +
      String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  function exportTableToCSV(table, filename) {
    if (!table) return;
    var BOM = '\uFEFF';
    var blob = new Blob([BOM + toCSV(table)], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, (filename || 'export_' + ts()) + '.csv');
  }

  // CSV con BOM funciona en Excel correctamente con acentos
  function exportTableToXLSX(table, filename) {
    exportTableToCSV(table, filename);
  }

  /** Exporta una sección usando el diálogo de impresión del navegador (save as PDF) */
  function exportSectionToPDF(section, filename) {
    if (!section) return;
    var clone = section.cloneNode(true);
    var w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return alert('Permite pop-ups para exportar PDF');
    var styles = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"],style'))
      .map(function (s) { return s.outerHTML; }).join('\n');
    w.document.write(
      '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>' +
      (filename || 'Reporte Suminregio') + '</title>' + styles +
      '<style>body{padding:32px;background:#fff;color:#0F172A}@media print{body{padding:0}}</style>' +
      '</head><body></body></html>'
    );
    w.document.body.appendChild(clone);
    w.document.close();
    setTimeout(function () { w.focus(); w.print(); }, 350);
  }

  function mountExportButtons(host, opts) {
    opts = opts || {};
    if (!host || host.dataset.exportMounted === '1') return;
    host.dataset.exportMounted = '1';

    var wrap = document.createElement('div');
    wrap.className = 'sumi-export-btns';
    wrap.style.cssText = 'display:inline-flex;gap:6px;margin-left:auto;';

    function btn(label, icon, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sumi-export-btn';
      b.style.cssText = 'background:rgba(255,255,255,.95);border:1px solid rgba(230,168,0,.3);' +
        'color:#0F172A;font-size:.7rem;font-weight:600;padding:5px 10px;border-radius:8px;' +
        'cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .15s ease;';
      b.innerHTML = icon + ' ' + label;
      b.addEventListener('mouseenter', function () {
        b.style.background = 'linear-gradient(135deg,#F5C33C,#E6A800)';
        b.style.borderColor = '#B8860B';
      });
      b.addEventListener('mouseleave', function () {
        b.style.background = 'rgba(255,255,255,.95)';
        b.style.borderColor = 'rgba(230,168,0,.3)';
      });
      b.addEventListener('click', onClick);
      wrap.appendChild(b);
      return b;
    }

    var table = host.querySelector('table');
    var name  = opts.filename || (host.querySelector('h1,h2,h3,.card-title')?.textContent || 'reporte')
      .trim().slice(0, 40).replace(/[^\w-]+/g, '_');

    if (table) {
      btn('CSV', '📊', function () { exportTableToCSV(table, name + '_' + ts()); });
    }
    btn('PDF', '📄', function () { exportSectionToPDF(host, name + '_' + ts()); });

    // Intentar insertar en el header de la card; si no hay, al inicio
    var header = host.querySelector('h1,h2,h3,header,.card-header');
    if (header && header.parentNode === host) {
      header.style.display = header.style.display || 'flex';
      header.style.alignItems = 'center';
      header.appendChild(wrap);
    } else {
      host.insertBefore(wrap, host.firstChild);
    }
  }

  function autoMount() {
    try {
      document.querySelectorAll('[data-export="true"], [data-exportable]').forEach(function (el) {
        mountExportButtons(el);
      });
      // Autocandidatos: cards que contengan una table
      document.querySelectorAll('.card, .sc-card, section').forEach(function (el) {
        if (el.dataset.exportMounted) return;
        if (!el.querySelector('table')) return;
        // Evitar duplicar en containers anidados
        if (el.closest('[data-export-mounted="1"]')) return;
        mountExportButtons(el);
      });
    } catch (_) {}
  }

  window.SumiExport = {
    exportTableToCSV: exportTableToCSV,
    exportTableToXLSX: exportTableToXLSX,
    exportSectionToPDF: exportSectionToPDF,
    mountExportButtons: mountExportButtons,
    autoMount: autoMount,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }
  // Re-mount tras cambios dinámicos del DOM
  setTimeout(autoMount, 1200);
  setTimeout(autoMount, 3000);
})();
