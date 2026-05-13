/* safe-dom.js - Helpers de escape para evitar XSS en interpolaciones de template strings.
 *
 * Uso:
 *   tb.innerHTML = `<td>${escHtml(r.NOMBRE)}</td>`;
 *   `<div title="${escAttr(r.NOMBRE)}">${escHtml(r.NOMBRE)}</div>`;
 */
(function (global) {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\//g, '&#x2F;');
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Uso en strings dentro de JS literal (poco recomendado, mejor pasar por data-attr).
  var LS = new RegExp('\\u2028', 'g');
  var PS = new RegExp('\\u2029', 'g');
  function escJs(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/</g, '\\u003C')
      .replace(/>/g, '\\u003E')
      .replace(LS, '\\u2028')
      .replace(PS, '\\u2029');
  }

  global.escHtml = escHtml;
  global.escAttr = escAttr;
  global.escJs = escJs;
})(typeof window !== 'undefined' ? window : globalThis);
