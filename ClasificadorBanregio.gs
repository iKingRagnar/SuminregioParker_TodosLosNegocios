// =============================================================
// CLASIFICADOR BANREGIO v11 — SOLO REGLAS CONFIGURADAS
// - Clasifica ÚNICAMENTE con lo que está configurado:
//   • PATRONES (texto en descripción/referencia)
//   • CONCEPTO_POR_PROVEEDOR (clave → concepto)
//   • Supabase (clasificaciones guardadas manualmente o por update)
//   • Histórico STEP2/STEP3 (descripciones ya vistas)
// - Lo que no coincida queda REVISAR / pendiente → MANUAL
// - NO se usa IA/Claude para clasificar automáticamente.
// - Pestaña semanal: 7 columnas, armada desde STEP3 por FILENAME.
// - update: refleja correcciones en STEP3 y pestaña semanal.
// =============================================================

var CONFIG = {
  DRIVE_FOLDER_ID:  '1yEeDq815puyjb3E2dBQva6V2UhNpWuK4',
  STEP2_SHEET_ID:   '14gNjxUXn_XQwPIZi7r_6W2Hf6y-Mm2rVtEQNMEchEUM',
  STEP3_SHEET_ID:   '1_SJINCfUxJCy9XgrUB5ZkN9Q1NEohQ1zbXA0WCs7whU',
  STEP2_TAB:        'IDENTIFICACION_SEMANAL',
  STEP3_TAB:        'LAYOUT_GASTOS',
  CSV_HEADER_ROW:   10,
  MIN_MATCH_SCORE:  0.5,

  // Idealmente mueve esto a Script Properties
  SUPABASE_URL:     'https://gpjnfijtluvphxftfrpf.supabase.co',
  SUPABASE_KEY:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdwam5maWp0bHV2cGh4ZnRmcnBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMTg1NDAsImV4cCI6MjA4NzY5NDU0MH0.94PrSg__OIGmrgFusbjgmvG_aZ9TWeflPSAxgRKtTIY'
};

var CENTRO_DEFAULT = 'PARKER';
var _supabaseCache = null;

function getSupabaseUrl() {
  return CONFIG.SUPABASE_URL || PropertiesService.getScriptProperties().getProperty('SUPABASE_URL') || '';
}

function getSupabaseKey() {
  return CONFIG.SUPABASE_KEY || PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY') || '';
}

// =============================================================
// CATÁLOGO Y PATRONES (solo referencia; no se usa para auto-clasificar)
// =============================================================

var CATALOGO = [
  'gasto de venta','Limpieza','compra','Gastos Varios','Reparaciones electricas',
  'Telefonía','Gastos de Envio','Articulos de Ferreteria','asistencia tecnica',
  'Combustibles y lubricantes','Mtto de eq de computo y Software','Agua',
  'Otros Gastos','Gastos Financieros','uniformes','Servicio de GPS',
  'Servicios Legales','polizas de seguros','consumibles de oficina',
  'Cuotas patronales IMSS','Propaganda y publicidad','Costos de operación',
  'Arrendamiento','Energía eléctrica','Capacitación al personal','Honorarios',
  'Servicios profesionales','Fletes','Papelería','Gasolina','Diesel','Lubricantes',
  'Mantenimiento','Reparaciones','Refacciones','Vigilancia','Seguridad',
  'Publicidad','Software','Licencias','Internet','Rentas','Seguros','Impuestos',
  'Predial','Tenencia','Viáticos','Pasajes','Hospedaje','Casetas',
  'Comisión bancaria','Comisión transferencia','Comisión cheque',
  'Intereses bancarios','Cargo automático','Diferencia cambiaria',
  'Flete proveedor','Maniobras','Despacho aduanal','Anticipo proveedor',
  'Pago proveedor','Honorarios externos','Ajustes contables','INTER EMPRESA',
  'Gastos financieros','Renta de Servidor y Licencias','Servicios de transporte',
  'Mantenimiento de Local','Gastos operativos'
].join('\n');

var PATRONES = [
  { p:'COMISION POR VENTAS', k:'BANREGIO',        c:'Comisión bancaria',          cc:'PARKER' },
  { p:'IVA COMISION',        k:'BANREGIO',        c:'Comisión bancaria',          cc:'PARKER' },
  { p:'ABONO VENTAS TDD',    k:'BANREGIO',        c:'Comisión bancaria',          cc:'PARKER' },
  { p:'ABONO VENTAS TDC',    k:'BANREGIO',        c:'Comisión bancaria',          cc:'PARKER' },
  { p:'CARGO AUTOMATICO',    k:'BANREGIO',        c:'Cargo automático',           cc:'PARKER' },
  { p:'INTERESES BANREGIO',  k:'BANREGIO',        c:'Intereses bancarios',        cc:'PARKER' },

  { p:'PASE PREPAGO',        k:'PASE',            c:'Casetas',                    cc:'PARKER' },
  { p:'TAGS PARKER',         k:'PASE',            c:'Casetas',                    cc:'PARKER' },
  { p:'TELEVIA',             k:'PASE',            c:'Casetas',                    cc:'PARKER' },

  { p:'INTER EMPRESA',       k:'INTER EMPRESA',   c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
  { p:'(BE) TRASPASO',       k:'INTER EMPRESA',   c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
  { p:'(NB) RECEPCION',      k:'INTER EMPRESA',   c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
  { p:'PRESTAMO',            k:'INTER EMPRESA',   c:'INTER EMPRESA',              cc:'INTER EMPRESA' },

  { p:'OXXO GAS',            k:'OXXOVALES',       c:'Gasolina',                   cc:'PARKER' },
  { p:'PETRO7',              k:'PETRO7',          c:'Combustibles y lubricantes', cc:'PARKER' },
  { p:'PETROSEVEN',          k:'PETROSEVEN',      c:'Combustibles y lubricantes', cc:'PARKER' },

  { p:'SUMERCA',             k:'REVISAR',         c:'consumibles de oficina',     cc:'PARKER' },
  { p:'WALMART',             k:'REVISAR',         c:'consumibles de oficina',     cc:'PARKER' },
  { p:'SAMS MTY',            k:'SAMS',            c:'consumibles de oficina',     cc:'PARKER' },
  { p:'COSTCO',              k:'REVISAR',         c:'consumibles de oficina',     cc:'PARKER' },

  { p:'FIX NUEVO LEON',      k:'FIX',             c:'Articulos de Ferreteria',    cc:'PARKER' },
  { p:'FERRETERIA',          k:'REVISAR',         c:'Articulos de Ferreteria',    cc:'PARKER' },

  { p:'PAQUETE EXPRESS',     k:'PAQUETE EXPRESS', c:'Gastos de Envio',            cc:'PARKER' },
  { p:'FEDEX',               k:'REVISAR',         c:'Gastos de Envio',            cc:'PARKER' },
  { p:'DHL',                 k:'REVISAR',         c:'Gastos de Envio',            cc:'PARKER' },
  { p:'ESTAFETA',            k:'REVISAR',         c:'Gastos de Envio',            cc:'PARKER' },

  { p:'NOMINA',              k:'EFECTIVO',        c:'Limpieza',                   cc:'PARKER' },
  { p:'TELCEL',              k:'REVISAR',         c:'Telefonía',                  cc:'PARKER' },
  { p:'MERCADO PAGO',        k:'MERCPAG',         c:'Telefonía',                  cc:'PARKER' },
  { p:'TELMEX',              k:'REVISAR',         c:'Internet',                   cc:'PARKER' },
  { p:'CFE',                 k:'REVISAR',         c:'Energía eléctrica',          cc:'PARKER' },
  { p:'IMSS',                k:'SECSS',           c:'Cuotas patronales IMSS',     cc:'PARKER' },
  { p:'ISSSTE',              k:'SECSS',           c:'Cuotas patronales IMSS',     cc:'PARKER' }
];

var CONCEPTO_POR_PROVEEDOR = {
  'BANREGIO':'Comisión bancaria',
  'BANORTE':'Comisión transferencia',
  'BBVA':'Comisión transferencia',
  'BANAMEX':'Comisión transferencia',
  'SANTANDER':'Comisión transferencia',
  'HSBC':'Comisión transferencia',
  'PASE':'Casetas',
  'OXXOVALES':'Gasolina',
  'PETRO7':'Combustibles y lubricantes',
  'PETROSEVEN':'Combustibles y lubricantes',
  'INTER EMPRESA':'INTER EMPRESA',
  'SECSS':'Cuotas patronales IMSS',
  'INFONAVIT':'Cuotas patronales IMSS',
  'SAT':'Impuestos',
  'CFE':'Energía eléctrica',
  'AGUASTAR':'Agua',
  'TELMEX':'Internet',
  'TELCEL':'Telefonía',
  'MERCPAG':'Telefonía',
  'SAMS':'consumibles de oficina',
  'WALMART':'consumibles de oficina',
  'COSTCO':'consumibles de oficina',
  'AMAZON':'consumibles de oficina',
  'FIX':'Articulos de Ferreteria',
  'FEDEX':'Gastos de Envio',
  'DHL':'Gastos de Envio',
  'ESTAFETA':'Gastos de Envio',
  'PAQUETE EXPRESS':'Gastos de Envio'
};

// =============================================================
// PESTAÑA SEMANAL
// =============================================================

function getNombrePestañaSemanal(fecha) {
  var d = fecha || new Date();
  var temp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var dia = (temp.getDay() + 6) % 7;
  temp.setDate(temp.getDate() - dia + 3);

  var pj = new Date(temp.getFullYear(), 0, 4);
  pj.setDate(pj.getDate() - ((pj.getDay() || 7) - 1));

  var sem = Math.round((temp - pj) / 604800000) + 1;
  return 'SEM_' + temp.getFullYear() + '-W' + (sem < 10 ? '0' + sem : sem);
}

var CABECERA_SEMANAL = [
  'CLAVE_PROVEEDOR',
  'CENTRO_COSTO',
  'CONCEPTO_GASTO',
  'FOLIO_O_FACTURA',
  'FECHA_CARGO',
  'IMPORTE',
  'DESCRIPCION'
];

function obtenerOCrearPestañaSemanal(nombreTab) {
  var ss = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID);
  var hoja = ss.getSheetByName(nombreTab);

  if (!hoja) {
    hoja = ss.insertSheet(nombreTab);
  } else {
    if (hoja.getLastRow() === 0) {
      hoja.clearContents();
      hoja.clearFormats();
    }
  }

  if (hoja.getLastRow() === 0) {
    hoja.getRange(1, 1, 1, CABECERA_SEMANAL.length).setValues([CABECERA_SEMANAL]);
    hoja.getRange(1, 1, 1, CABECERA_SEMANAL.length)
      .setBackground('#1A1A1A')
      .setFontColor('#F5B800')
      .setFontWeight('bold');
    hoja.setFrozenRows(1);
  }

  return hoja;
}

function claveSemanaDesdeFila7(r) {
  var folio   = String(r[3] || '').replace(/^_/, '').trim();
  var fecha   = String(r[4] || '').trim();
  var importe = String(r[5] || '').trim();
  var desc    = String(r[6] || '').trim();
  return folio ? 'F:' + folio + '|' + fecha + '|' + importe : 'D:' + desc + '|' + fecha + '|' + importe;
}

function obtenerFilasSemanaDesdeStep3PorArchivos(nombresArchivo, fechaEjecucion) {
  if (!nombresArchivo || nombresArchivo.length === 0) return [];

  var archivosSet = new Set(
    nombresArchivo.map(function(x) { return String(x || '').trim(); }).filter(String)
  );

  if (archivosSet.size === 0) return [];

  var hoja = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID).getSheetByName(CONFIG.STEP3_TAB);
  var datos = hoja.getDataRange().getValues();
  if (datos.length < 2) return [];

  var hdr = datos[0].map(function(h) { return norm(String(h)); });

  var C = {
    clave:    findCol(hdr, ['clave_proveedor','clave proveedor','claveproveedor']),
    centro:   findCol(hdr, ['centro_costo','centro costo','centrocosto']),
    concepto: findCol(hdr, ['concepto_gasto','concepto gasto','conceptogasto']),
    ref:      findCol(hdr, ['folio_o_factura','folio o factura','folioofactura','referencia']),
    fecha:    findCol(hdr, ['fecha_cargo','fecha cargo','fechacargo']),
    importe:  findCol(hdr, ['importe','cargo','cargos']),
    desc:     findCol(hdr, ['descripcion','description']),
    file:     findCol(hdr, ['filename'])
  };

  if (C.file < 0) throw new Error('No encuentro columna FILENAME en STEP3.');
  if (C.clave < 0 || C.centro < 0 || C.concepto < 0 || C.ref < 0 || C.fecha < 0 || C.importe < 0 || C.desc < 0) {
    throw new Error('Faltan columnas requeridas en STEP3 para generar semana.');
  }

  var filas = [];

  for (var i = 1; i < datos.length; i++) {
    var file = String(datos[i][C.file] || '').trim();
    if (!archivosSet.has(file)) continue;

    filas.push([
      datos[i][C.clave],
      datos[i][C.centro],
      datos[i][C.concepto],
      datos[i][C.ref],
      datos[i][C.fecha],
      datos[i][C.importe],
      datos[i][C.desc]
    ]);
  }

  return filas;
}

function escribirEnPestañaSemanalDesdeStep3PorArchivos(nombresArchivo, fechaEjecucion) {
  if (!nombresArchivo || nombresArchivo.length === 0) return;

  var nombreTab = getNombrePestañaSemanal(fechaEjecucion);
  var hojaSemana = obtenerOCrearPestañaSemanal(nombreTab);

  var clavesExistentes = new Set();
  var lr = hojaSemana.getLastRow();

  if (lr >= 2) {
    var existentes = hojaSemana.getRange(2, 1, lr, CABECERA_SEMANAL.length).getValues();
    existentes.forEach(function(r) {
      clavesExistentes.add(claveSemanaDesdeFila7(r));
    });
  }

  var candidatas = obtenerFilasSemanaDesdeStep3PorArchivos(nombresArchivo, fechaEjecucion);
  if (!candidatas || candidatas.length === 0) return;

  var nuevas = [];

  candidatas.forEach(function(r) {
    var clave = claveSemanaDesdeFila7(r);
    if (clavesExistentes.has(clave)) return;
    clavesExistentes.add(clave);
    nuevas.push(r);
  });

  if (nuevas.length === 0) return;

  var ini = hojaSemana.getLastRow() + 1;
  hojaSemana.getRange(ini, 1, ini + nuevas.length - 1, CABECERA_SEMANAL.length).setValues(nuevas);

  for (var i = 0; i < nuevas.length; i++) {
    hojaSemana.getRange(ini + i, 1, ini + i, CABECERA_SEMANAL.length)
      .setBackground(i % 2 === 0 ? '#FFFDE7' : '#FFFFFF');
  }

  SpreadsheetApp.flush();
}

// =============================================================
// DEDUPLICAR TRANSACCIONES
// =============================================================

function deduplicarTransacciones(txs, historico, step3Data) {
  var claves = new Set();

  (historico || []).forEach(function(r) {
    var f  = String(r['fecha'] || '').trim();
    var d  = String(r['descripcion'] || r['description'] || '').trim();
    var ca = String(r['cargos'] || r['cargo'] || '').trim();
    var ab = String(r['abonos'] || r['abono'] || '').trim();
    var re = String(r['referencia'] || r['folio'] || '').trim();
    if (f || d) claves.add('H:' + f + '|' + d + '|' + ca + '|' + ab + '|' + re);
  });

  (step3Data || []).forEach(function(r) {
    var f  = String(r['fecha cargo'] || r['fecha_cargo'] || r['fechacargo'] || '').trim();
    var d  = String(r['descripcion'] || r['description'] || '').trim();
    var im = String(r['importe'] || r['cargo'] || r['cargos'] || '').trim();
    var fo = String(r['folio_o_factura'] || r['folio o factura'] || r['folioofactura'] || r['referencia'] || '').trim();

    if (f && d)  claves.add('S3D:' + f + '|' + d + '|' + im);
    if (fo && f) claves.add('S3F:' + fo + '|' + f + '|' + im);
  });

  return txs.filter(function(tx) {
    var imp = tx.cargo > 0 ? String(tx.cargo) : String(tx.abono);

    var ch = 'H:' + tx.fecha + '|' + tx.desc + '|' + String(tx.cargo) + '|' + String(tx.abono) + '|' + tx.ref;
    if (claves.has(ch)) return false;

    var cd = 'S3D:' + tx.fecha + '|' + tx.desc + '|' + imp;
    if (claves.has(cd)) return false;

    if (tx.ref) {
      var cf = 'S3F:' + tx.ref + '|' + tx.fecha + '|' + imp;
      if (claves.has(cf)) return false;
      claves.add(cf);
    }

    claves.add(ch);
    claves.add(cd);
    return true;
  });
}

// =============================================================
// CLASIFICACIÓN (solo patrones + Supabase + histórico; lo demás → REVISAR)
// =============================================================

function clasificarRapido(tx, historico, layout) {
  var r = porPatron(tx.desc, tx.ref);
  if (r && r.k) return r;

  r = buscarSupabase(tx.desc);
  if (r) return r;

  r = buscarHistorico(tx.desc, tx.ref, historico, layout);
  if (r) return r;

  return { k:'REVISAR', c:'', cc:CENTRO_DEFAULT, f:'pendiente' };
}

function porPatron(desc, ref) {
  var txt = ((desc || '') + ' ' + (ref || '')).toUpperCase();

  for (var i = 0; i < PATRONES.length; i++) {
    if (txt.indexOf(PATRONES[i].p) >= 0) {
      return { k:PATRONES[i].k, c:PATRONES[i].c, cc:PATRONES[i].cc, f:'patron' };
    }
  }

  return parsearSPEI(desc);
}

function parsearSPEI(desc) {
  if (!desc || desc.toUpperCase().indexOf('SPEI') < 0) return null;

  var BANCOS = [
    'BBVA','BANAMEX','SANTANDER','HSBC','BANORTE','SCOTIABANK','INBURSA','AFIRME',
    'BANREGIO','STP','CITIBANAMEX','CITI MEXICO','BANBAJIO','BAJIO','INVEX','MULTIVA',
    'MIFEL','BANCA AFIRME','ABC CAPITAL'
  ];

  var partes = desc.split('.').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 1; });
  var posB = -1;

  for (var i = 0; i < partes.length; i++) {
    var pu = partes[i].toUpperCase();
    for (var b = 0; b < BANCOS.length; b++) {
      if (pu.indexOf(BANCOS[b]) >= 0) {
        posB = i;
        break;
      }
    }
    if (posB >= 0) break;
  }

  var emp = null;
  var si = posB >= 0 ? posB + 2 : 2;

  for (var j = si; j < partes.length; j++) {
    var p = partes[j].trim();

    if (!p || p.length < 3 || /^\d+$/.test(p) || /^[A-Z]{2,4}\d{5,}/.test(p.toUpperCase()) ||
        /^\d{2,4}[-\/]\d{2}/.test(p) || p.match(/^(FACT|FAC|INV|SPK|REF|OC|PO)\s/i)) {
      continue;
    }

    if (/[A-Za-záéíóúÁÉÍÓÚñÑ]{3,}/.test(p)) {
      emp = p;
      break;
    }
  }

  if (!emp) return null;

  var MAPA = [
    { b:'OXXO',          k:'OXXOVALES',     c:'Gasolina',                   cc:'PARKER' },
    { b:'PETRO',         k:'PETRO7',        c:'Combustibles y lubricantes', cc:'PARKER' },
    { b:'PASE',          k:'PASE',          c:'Casetas',                    cc:'PARKER' },
    { b:'TAGS',          k:'PASE',          c:'Casetas',                    cc:'PARKER' },
    { b:'PARKER',        k:'INTER EMPRESA', c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
    { b:'FACTORAJE',     k:'INTER EMPRESA', c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
    { b:'IMSS',          k:'SECSS',         c:'Cuotas patronales IMSS',     cc:'PARKER' },
    { b:'INFONAVIT',     k:'INFONAVIT',     c:'Cuotas patronales IMSS',     cc:'PARKER' },
    { b:'SAT',           k:'SAT',           c:'Impuestos',                  cc:'PARKER' },
    { b:'TELMEX',        k:'TELMEX',        c:'Internet',                   cc:'PARKER' },
    { b:'TELCEL',        k:'TELCEL',        c:'Telefonía',                  cc:'PARKER' },
    { b:'CFE',           k:'CFE',           c:'Energía eléctrica',          cc:'PARKER' },
    { b:'WALMART',       k:'WALMART',       c:'consumibles de oficina',     cc:'PARKER' },
    { b:'SAMS',          k:'SAMS',          c:'consumibles de oficina',     cc:'PARKER' },
    { b:'AMAZON',        k:'AMAZON',        c:'consumibles de oficina',     cc:'PARKER' },
    { b:'MERCADO PAGO',  k:'MERCPAG',       c:'Telefonía',                  cc:'PARKER' },
    { b:'FUD TRAILS',    k:'INTER EMPRESA', c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
    { b:'ADV STEEL',     k:'INTER EMPRESA', c:'INTER EMPRESA',              cc:'INTER EMPRESA' },
    { b:'CYMABA',        k:'INTER EMPRESA', c:'INTER EMPRESA',              cc:'INTER EMPRESA' }
  ];

  var eu = emp.toUpperCase();

  for (var m = 0; m < MAPA.length; m++) {
    if (eu.indexOf(MAPA[m].b) >= 0) {
      return { k:MAPA[m].k, c:MAPA[m].c, cc:MAPA[m].cc, f:'spei_patron' };
    }
  }

  return { k:null, c:null, cc:CENTRO_DEFAULT, f:'spei_extraido', nombreSugerido:emp };
}

// =============================================================
// doGet
// =============================================================

function doGet(e) {
  var accion = (e.parameter.accion || '').toLowerCase();

  if (accion === 'update') {
    try {
      var descripcion = e.parameter.descripcion || '';
      var clave = e.parameter.clave || '';
      var concepto = e.parameter.concepto || '';
      var centro = e.parameter.centro || 'PARKER';
      var folio = e.parameter.folio || '';

      if (!clave) return jsonOut({ ok:false, error:'Parametro requerido: clave' });

      var ss = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID);
      var hoja = ss.getSheetByName(CONFIG.STEP3_TAB);
      var datos = hoja.getDataRange().getValues();
      var hdr = datos[0].map(function(h) { return norm(String(h)); });

      var C = {
        clave: findCol(hdr, ['clave_proveedor','clave proveedor','claveproveedor']),
        concepto: findCol(hdr, ['concepto_gasto','concepto gasto','conceptogasto']),
        centro: findCol(hdr, ['centro_costo','centro costo','centrocosto']),
        desc: findCol(hdr, ['descripcion','description']),
        ref: findCol(hdr, ['folio_o_factura','folio o factura','folioofactura','referencia'])
      };

      if (C.clave < 0) return jsonOut({ ok:false, error:'No se encontró CLAVE_PROVEEDOR' });

      var fn = folio.replace(/^_/, '').trim();
      var dn = normSupa(descripcion);
      var act = 0;
      var metodo = '';

      if (fn && C.ref >= 0) {
        for (var i = 1; i < datos.length; i++) {
          if (String(datos[i][C.ref] || '').replace(/^_/, '').trim() === fn) {
            if (C.clave >= 0) hoja.getRange(i + 1, C.clave + 1).setValue(clave);
            if (C.concepto >= 0 && concepto) hoja.getRange(i + 1, C.concepto + 1).setValue(concepto);
            if (C.centro >= 0) hoja.getRange(i + 1, C.centro + 1).setValue(centro);
            act++;
          }
        }
        if (act > 0) metodo = 'folio';
      }

      if (act === 0 && descripcion && C.desc >= 0) {
        for (var j = 1; j < datos.length; j++) {
          if (similitud(dn, normSupa(String(datos[j][C.desc] || ''))) >= 0.6) {
            if (C.clave >= 0) hoja.getRange(j + 1, C.clave + 1).setValue(clave);
            if (C.concepto >= 0 && concepto) hoja.getRange(j + 1, C.concepto + 1).setValue(concepto);
            if (C.centro >= 0) hoja.getRange(j + 1, C.centro + 1).setValue(centro);
            act++;
          }
        }
        if (act > 0) metodo = 'similitud';
      }

      if (act > 0) {
        var ns = getNombrePestañaSemanal(new Date());
        var hs = ss.getSheetByName(ns);

        if (hs && hs.getLastRow() >= 2) {
          var ds = hs.getDataRange().getValues();
          var hh = ds[0].map(function(h) { return norm(String(h)); });

          var CS = {
            clave: findCol(hh, ['clave_proveedor','clave proveedor','claveproveedor']),
            concepto: findCol(hh, ['concepto_gasto','concepto gasto','conceptogasto']),
            centro: findCol(hh, ['centro_costo','centro costo','centrocosto']),
            ref: findCol(hh, ['folio_o_factura','folio o factura','folioofactura','referencia']),
            desc: findCol(hh, ['descripcion','description'])
          };

          for (var k = 1; k < ds.length; k++) {
            var fs = CS.ref >= 0 ? String(ds[k][CS.ref] || '').replace(/^_/, '').trim() : '';
            var ds2 = CS.desc >= 0 ? normSupa(String(ds[k][CS.desc] || '')) : '';

            if ((fn && fs && fs === fn) || (!fn && descripcion && similitud(dn, ds2) >= 0.6)) {
              if (CS.clave >= 0) hs.getRange(k + 1, CS.clave + 1).setValue(clave);
              if (CS.concepto >= 0 && concepto) hs.getRange(k + 1, CS.concepto + 1).setValue(concepto);
              if (CS.centro >= 0) hs.getRange(k + 1, CS.centro + 1).setValue(centro);
            }
          }
        }
      }

      SpreadsheetApp.flush();

      if (act > 0) {
        guardarSupabase(
          { descripcion:descripcion, referencia:folio },
          { clave_proveedor:clave, concepto_gasto:concepto, centro_costo:centro },
          true
        );
      }

      return jsonOut({
        ok: act > 0,
        actualizados: act,
        metodo: metodo,
        descripcion: descripcion,
        folio: folio,
        clave: clave,
        concepto: concepto,
        error: act === 0 ? 'No se encontró folio="' + folio + '" ni descripción similar' : null
      });

    } catch (err) {
      return jsonOut({ ok:false, error:err.message });
    }
  }

  if (accion === 'ejecutar') {
    try {
      _supabaseCache = null;

      var procesados = obtenerFilenames(CONFIG.STEP2_SHEET_ID, CONFIG.STEP2_TAB);
      var csvNuevos = buscarCSVsNuevos(procesados);

      var totalTx = 0;
      var fechaEjec = new Date();
      var nombresCsvProcesados = [];

      if (csvNuevos.length > 0) {
        var historico = leerSheet(CONFIG.STEP2_SHEET_ID, CONFIG.STEP2_TAB);
        var layout = leerSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB);

        for (var a = 0; a < csvNuevos.length; a++) {
          var arc = csvNuevos[a];
          var txs = deduplicarTransacciones(parsearCSV(arc), historico, layout);
          var f2 = [];
          var f3 = [];
          var fp = Utilities.formatDate(fechaEjec, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');

          for (var t = 0; t < txs.length; t++) {
            var tx = txs[t];
            var cl = clasificarRapido(tx, historico, layout);
            var cc = (cl.cc || CENTRO_DEFAULT).trim() || CENTRO_DEFAULT;

            f2.push([
              tx.fecha,
              tx.desc,
              tx.ref,
              tx.cargo || '',
              tx.abono || '',
              cc,
              tx.ref || '',
              cl.k || 'REVISAR',
              arc.getName()
            ]);

            f3.push([
              cl.k || 'REVISAR',
              cc,
              cl.c || '',
              tx.ref || '',
              tx.fecha,
              tx.cargo > 0 ? tx.cargo : tx.abono,
              tx.desc,
              arc.getName(),
              fp
            ]);

            totalTx++;
          }

          if (f2.length > 0) {
            appendSheet(CONFIG.STEP2_SHEET_ID, CONFIG.STEP2_TAB, f2);
            appendSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB, f3);
            nombresCsvProcesados.push(arc.getName());

            txs.forEach(function(tx) {
              historico.push({
                fecha: tx.fecha,
                descripcion: tx.desc,
                referencia: tx.ref,
                cargos: String(tx.cargo),
                abonos: String(tx.abono)
              });

              layout.push({
                'folio_o_factura': tx.ref,
                'fecha_cargo': tx.fecha,
                'importe': String(tx.cargo > 0 ? tx.cargo : tx.abono),
                'descripcion': tx.desc
              });
            });
          }
        }

        if (totalTx > 0) {
          colorearFilasNuevas(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB, totalTx);
        }
      }

      deduplicarStep3PorFolio();
      var resultado = limpiarStep3();

      if (nombresCsvProcesados.length > 0) {
        escribirEnPestañaSemanalDesdeStep3PorArchivos(nombresCsvProcesados, fechaEjec);
      }

      var nomSem = getNombrePestañaSemanal(fechaEjec);
      escribirLog(fechaEjec, csvNuevos.length, totalTx, resultado, nomSem);

      return jsonOut({
        ok: true,
        csvs_nuevos: csvNuevos.length,
        transacciones: totalTx,
        conceptos_rellenados: resultado.conceptos,
        revisar_resueltos: resultado.resueltos,
        pestaña_semanal: nomSem,
        mensaje: '✅ Solo reglas configuradas. Pestaña: ' + nomSem
      });

    } catch (err2) {
      return jsonOut({ ok:false, error:err2.message });
    }
  }

  if (accion === 'dashboard') {
    try {
      var datos = leerSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB);
      if (!datos || datos.length === 0) return jsonOut({ ok:false, error:'No hay datos en LAYOUT_GASTOS' });

      var pc = {}, pp = {}, total = 0, rev = 0;

      datos.forEach(function(r) {
        var con = String(r['concepto gasto'] || r['concepto_gasto'] || r['conceptogasto'] || '').trim() || 'Sin clasificar';
        var prov = String(r['clave proveedor'] || r['clave_proveedor'] || r['claveproveedor'] || '').trim() || 'REVISAR';
        var imp = limpiarNum(String(r['importe'] || r['cargo'] || r['cargos'] || '0'));

        if (prov === 'REVISAR') rev++;
        if (imp <= 0) return;

        pc[con] = (pc[con] || 0) + imp;
        pp[prov] = (pp[prov] || 0) + imp;
        total += imp;
      });

      function topN(o, n) {
        var a = [];
        for (var k in o) a.push([k, o[k]]);
        a.sort(function(x, y) { return y[1] - x[1]; });
        return a.slice(0, n);
      }

      var tc = topN(pc, 5), tp = topN(pp, 5);

      var res = '📊 *DASHBOARD BANREGIO*\n💰 Total: $' + Math.round(total).toLocaleString('es-MX') + ' MXN\n📋 Transacciones: ' + datos.length +
                '\n🔍 REVISAR: ' + rev +
                '\n\n*TOP 5 CONCEPTOS:*\n' + tc.map(function(x) { return '• ' + x[0] + ': $' + Math.round(x[1]).toLocaleString('es-MX'); }).join('\n') +
                '\n\n*TOP 5 PROVEEDORES:*\n' + tp.map(function(x) { return '• ' + x[0] + ': $' + Math.round(x[1]).toLocaleString('es-MX'); }).join('\n');

      return jsonOut({ ok:true, resumen:res, total:total, transacciones:datos.length, revisar:rev });

    } catch (err3) {
      return jsonOut({ ok:false, error:err3.message });
    }
  }

  if (accion === 'pendientes') {
    try {
      var ss = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID);
      var hoja = ss.getSheetByName(CONFIG.STEP3_TAB);
      var datos = hoja.getDataRange().getValues();
      var hdr = datos[0].map(function(h) { return norm(String(h)); });

      var C = {
        clave: findCol(hdr, ['clave_proveedor','clave proveedor','claveproveedor']),
        concepto: findCol(hdr, ['concepto_gasto','concepto gasto','conceptogasto']),
        centro: findCol(hdr, ['centro_costo','centro costo','centrocosto']),
        desc: findCol(hdr, ['descripcion','description']),
        ref: findCol(hdr, ['folio_o_factura','folio o factura','folioofactura','referencia']),
        fecha: findCol(hdr, ['fecha_cargo','fecha cargo','fechacargo']),
        importe: findCol(hdr, ['importe','cargo','cargos'])
      };

      var pend = [];

      for (var i = 1; i < datos.length; i++) {
        var cl = String(datos[i][C.clave] || '').trim().toUpperCase();
        var co = String(datos[i][C.concepto] || '').trim().toUpperCase();

        if (cl === 'REVISAR' || cl === '' || co === 'REVISAR' || co === 'PENDIENTE' || co === '') {
          pend.push({
            fila: i + 1,
            clave: String(datos[i][C.clave] || '').trim(),
            concepto: String(datos[i][C.concepto] || '').trim(),
            centro: C.centro >= 0 ? String(datos[i][C.centro] || 'PARKER').trim() : 'PARKER',
            descripcion: C.desc >= 0 ? String(datos[i][C.desc] || '').trim() : '',
            folio: C.ref >= 0 ? String(datos[i][C.ref] || '').trim() : '',
            fecha: C.fecha >= 0 ? String(datos[i][C.fecha] || '').trim() : '',
            importe: C.importe >= 0 ? String(datos[i][C.importe] || '').trim() : ''
          });
        }
      }

      return jsonOut({ ok:true, pendientes:pend, total:pend.length });

    } catch (err4) {
      return jsonOut({ ok:false, error:err4.message });
    }
  }

  return jsonOut({ ok:false, error:'Accion no reconocida. Usa: update | ejecutar | dashboard | pendientes' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// =============================================================
// MENÚ (solo reglas configuradas; pendientes = manual)
// =============================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Banregio')
    .addItem('▶ Clasificar (solo reglas configuradas)', 'clasificarTodo')
    .addItem('🔧 Aplicar reglas a existentes', 'limpiarExistentes')
    .addItem('🧹 Deduplicar STEP2 y STEP3', 'deduplicarTodo')
    .addItem('🧠 Sincronizar correcciones', 'sincronizarCorrecciones')
    .addItem('🔄 Sincronizar Supabase → Sheets', 'sincronizarSupabaseASheets')
    .addItem('⏰ Activar sync automático cada hora', 'configurarTriggerSincronizacion')
    .addSeparator()
    .addItem('📊 Actualizar Dashboard', 'actualizarDashboard')
    .addItem('⏰ Activar/desactivar trigger lunes', 'configurarTrigger')
    .addSeparator()
    .addItem('🔍 Debug: Ver cabeceras CSV', 'debugVerCabeceras')
    .addItem('🧪 Test: Ver archivos en Drive', 'testVerArchivos')
    .addToUi();
}

// =============================================================
// DEDUPLICAR STEP3
// =============================================================

function deduplicarStep3PorFolio() {
  try {
    var hoja3 = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID).getSheetByName(CONFIG.STEP3_TAB);
    var datos = hoja3.getDataRange().getValues();
    var hdr = datos[0].map(function(h) { return norm(String(h)); });

    var Cf  = findCol(hdr, ['folio_o_factura','folio o factura','folioofactura','referencia']);
    var Cfe = findCol(hdr, ['fecha_cargo','fecha cargo','fechacargo']);
    var Ci  = findCol(hdr, ['importe','cargo','cargos']);
    var Cd  = findCol(hdr, ['descripcion','description']);

    var vis = new Set(), bor = [];

    for (var i = 1; i < datos.length; i++) {
      var fo = Cf  >= 0 ? String(datos[i][Cf]  || '').trim() : '';
      var fe = Cfe >= 0 ? String(datos[i][Cfe] || '').trim() : '';
      var im = Ci  >= 0 ? String(datos[i][Ci]  || '').trim() : '';
      var de = Cd  >= 0 ? String(datos[i][Cd]  || '').trim() : '';

      var cv = fo ? 'F:' + fo + '|' + fe + '|' + im : 'D:' + de + '|' + fe + '|' + im;
      if (vis.has(cv)) bor.push(i + 1);
      else vis.add(cv);
    }

    for (var j = bor.length - 1; j >= 0; j--) hoja3.deleteRow(bor[j]);
    SpreadsheetApp.flush();
    return bor.length;

  } catch (e) {
    return 0;
  }
}

function deduplicarTodo() {
  var ui = SpreadsheetApp.getUi(), e2 = 0;

  try {
    var h2 = SpreadsheetApp.openById(CONFIG.STEP2_SHEET_ID).getSheetByName(CONFIG.STEP2_TAB);
    var d2 = h2.getDataRange().getValues(), v2 = new Set(), b2 = [];

    for (var i = 1; i < d2.length; i++) {
      var c2 = [0,1,2,3,4].map(function(j) { return String(d2[i][j] || '').trim(); }).join('|');
      if (v2.has(c2)) b2.push(i + 1);
      else v2.add(c2);
    }

    for (var j = b2.length - 1; j >= 0; j--) h2.deleteRow(b2[j]);
    SpreadsheetApp.flush();
    e2 = b2.length;

  } catch (e) {
    ui.alert('Error STEP2: ' + e.message);
    return;
  }

  var e3 = deduplicarStep3PorFolio();
  ui.alert('✅ Deduplicación\nSTEP2: ' + e2 + ' eliminadas\nSTEP3: ' + e3 + ' eliminadas');
}

// =============================================================
// CLASIFICAR TODO (solo reglas configuradas; sin IA)
// =============================================================

function clasificarTodo() {
  var ui = SpreadsheetApp.getUi();

  _supabaseCache = null;

  try {
    var procesados = obtenerFilenames(CONFIG.STEP2_SHEET_ID, CONFIG.STEP2_TAB);
    var csvNuevos = buscarCSVsNuevos(procesados);

    var totalTx = 0;
    var fechaEjec = new Date();
    var nombresCsvProcesados = [];

    if (csvNuevos.length > 0) {
      var historico = leerSheet(CONFIG.STEP2_SHEET_ID, CONFIG.STEP2_TAB);
      var layout = leerSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB);

      for (var a = 0; a < csvNuevos.length; a++) {
        var arc = csvNuevos[a];
        var txs = deduplicarTransacciones(parsearCSV(arc), historico, layout);
        var f2 = [], f3 = [];
        var fp = Utilities.formatDate(fechaEjec, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');

        for (var t = 0; t < txs.length; t++) {
          var tx = txs[t];
          var cl = clasificarRapido(tx, historico, layout);
          var cc = (cl.cc || CENTRO_DEFAULT).trim() || CENTRO_DEFAULT;

          f2.push([
            tx.fecha,
            tx.desc,
            tx.ref,
            tx.cargo || '',
            tx.abono || '',
            cc,
            tx.ref || '',
            cl.k || 'REVISAR',
            arc.getName()
          ]);

          f3.push([
            cl.k || 'REVISAR',
            cc,
            cl.c || '',
            tx.ref || '',
            tx.fecha,
            tx.cargo > 0 ? tx.cargo : tx.abono,
            tx.desc,
            arc.getName(),
            fp
          ]);

          totalTx++;
        }

        if (f2.length > 0) {
          appendSheet(CONFIG.STEP2_SHEET_ID, CONFIG.STEP2_TAB, f2);
          appendSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB, f3);
          nombresCsvProcesados.push(arc.getName());

          txs.forEach(function(tx) {
            historico.push({
              fecha: tx.fecha,
              descripcion: tx.desc,
              referencia: tx.ref,
              cargos: String(tx.cargo),
              abonos: String(tx.abono)
            });

            layout.push({
              'folio_o_factura': tx.ref,
              'fecha_cargo': tx.fecha,
              'importe': String(tx.cargo > 0 ? tx.cargo : tx.abono),
              'descripcion': tx.desc
            });
          });
        }
      }

      if (totalTx > 0) {
        colorearFilasNuevas(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB, totalTx);
      }
    }

    var dup = deduplicarStep3PorFolio();
    var res = limpiarStep3();
    sincronizarCorreccionesAuto();

    if (nombresCsvProcesados.length > 0) {
      escribirEnPestañaSemanalDesdeStep3PorArchivos(nombresCsvProcesados, fechaEjec);
    }

    var alr = verificarGastosInusuales();
    var nomSem = getNombrePestañaSemanal(fechaEjec);

    escribirLog(fechaEjec, csvNuevos.length, totalTx, res, nomSem);

    var msg = csvNuevos.length > 0 ? '✅ CSVs: ' + csvNuevos.length + ' (' + totalTx + ' tx)\n' : '📭 Sin CSVs nuevos\n';
    if (totalTx > 0) msg += '📅 Pestaña: ' + nomSem + '\n';
    if (dup > 0) msg += '🧹 Duplicados: ' + dup + '\n';

    msg += '🔧 Solo reglas configuradas.\nConceptos aplicados: ' + res.conceptos + '\nREVISAR resueltos: ' + res.resueltos;
    msg += '\n\n⚠️ Lo pendiente se clasifica MANUAL (update o Sheets).';

    if (alr.length > 0) msg += '\n\n🚨 Inusuales:\n' + alr.join('\n');

    ui.alert('Listo', msg, ui.ButtonSet.OK);

  } catch (e) {
    Logger.log('ERROR: ' + e.message);
    ui.alert('Error', e.message, ui.ButtonSet.OK);
  }
}

function limpiarExistentes() {
  var ui = SpreadsheetApp.getUi();

  try {
    var r = limpiarStep3();
    ui.alert('Solo reglas configuradas.\nConceptos: ' + r.conceptos + '\nREVISAR resueltos: ' + r.resueltos + '\n\nLo demás queda para revisión manual.');
  } catch (e) {
    ui.alert('Error', e.message, ui.ButtonSet.OK);
  }
}

// Limpia STEP3 solo con patrones + CONCEPTO_POR_PROVEEDOR + Supabase + histórico. Sin IA.
function limpiarStep3() {
  var hoja3 = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID).getSheetByName(CONFIG.STEP3_TAB);
  var datos = hoja3.getDataRange().getValues();
  var hdr = datos[0].map(function(h) { return norm(String(h)); });

  var C = {
    clave:    findCol(hdr, ['clave_proveedor','clave proveedor','claveproveedor']),
    centro:   findCol(hdr, ['centro_costo','centro costo','centrocosto']),
    concepto: findCol(hdr, ['concepto_gasto','concepto gasto','conceptogasto']),
    desc:     findCol(hdr, ['descripcion','description']),
    ref:      findCol(hdr, ['folio_o_factura','folio o factura','folioofactura','referencia'])
  };

  if (C.desc < 0) throw new Error('No encuentro DESCRIPCION en STEP3.');
  if (C.concepto < 0) throw new Error('No encuentro CONCEPTO_GASTO.');
  if (C.clave < 0) throw new Error('No encuentro CLAVE_PROVEEDOR.');

  var cambios = [], con = 0, res = 0;

  for (var i = 1; i < datos.length; i++) {
    var clave = String(datos[i][C.clave] || '').trim();
    var concepto = String(datos[i][C.concepto] || '').trim();
    var desc = String(datos[i][C.desc] || '').trim();
    var ref = C.ref >= 0 ? String(datos[i][C.ref] || '').trim() : '';

    if (!desc) continue;

    var nC = clave === 'REVISAR' || !clave;
    var nCo = !concepto;

    if (!nC && !nCo) continue;

    var pat = porPatron(desc, ref);

    if (pat && pat.k && pat.k !== 'REVISAR') {
      if (nC) {
        cambios.push({ fila:i + 1, col:C.clave + 1, val:pat.k });
        res++;
        clave = pat.k;
        nC = false;
      }

      if (nCo && pat.c) {
        cambios.push({ fila:i + 1, col:C.concepto + 1, val:pat.c });
        con++;
        nCo = false;
      }

      if (pat.cc && C.centro >= 0) cambios.push({ fila:i + 1, col:C.centro + 1, val:pat.cc });

      guardarSupabase(
        { descripcion:desc, referencia:ref },
        { clave_proveedor:pat.k, concepto_gasto:pat.c, centro_costo:pat.cc }
      );

      if (!nC && !nCo) continue;
    }

    if (!nC && nCo) {
      var cm = CONCEPTO_POR_PROVEEDOR[clave] || CONCEPTO_POR_PROVEEDOR[clave.toUpperCase()];
      if (!cm) {
        var cu = clave.toUpperCase();
        for (var mk in CONCEPTO_POR_PROVEEDOR) {
          if (cu.indexOf(mk) >= 0 || mk.indexOf(cu) >= 0) {
            cm = CONCEPTO_POR_PROVEEDOR[mk];
            break;
          }
        }
      }

      if (cm) {
        cambios.push({ fila:i + 1, col:C.concepto + 1, val:cm });
        con++;

        guardarSupabase(
          { descripcion:desc, referencia:ref },
          { clave_proveedor:clave, concepto_gasto:cm, centro_costo:CENTRO_DEFAULT }
        );

        continue;
      }
    }

    // Lo que queda sin coincidencia: queda REVISAR / pendiente para clasificación MANUAL.
    // No se llama a ninguna IA.
  }

  cambios.forEach(function(c) {
    if (c.col >= 1) hoja3.getRange(c.fila, c.col).setValue(c.val);
  });

  SpreadsheetApp.flush();
  return { conceptos:con, resueltos:res, tiempoAgotado:false };
}

// =============================================================
// HISTÓRICO Y SUPABASE
// =============================================================

function buscarHistorico(desc, ref, historico, layout) {
  var dn = norm(desc), rn = norm(ref);

  for (var i = 0; i < historico.length; i++) {
    var r = historico[i], dh = norm(String(r['descripcion'] || r['description'] || ''));

    if (dh && similitud(dn, dh) >= CONFIG.MIN_MATCH_SCORE) {
      var k = String(r['clave_proveedor'] || r['clave proveedor'] || '').trim();
      if (k && k !== 'REVISAR') {
        return {
          k:k,
          c:String(r['concepto_gasto'] || r['concepto gasto'] || '').trim(),
          cc:String(r['centro_costo'] || r['centro costo'] || CENTRO_DEFAULT).trim(),
          f:'historico'
        };
      }
    }
  }

  for (var j = 0; j < layout.length; j++) {
    var rr = layout[j], kn = norm(String(rr['clave_proveedor'] || rr['clave proveedor'] || ''));

    if (kn && kn.length > 2 && (dn.indexOf(kn) >= 0 || rn.indexOf(kn) >= 0)) {
      return {
        k:String(rr['clave_proveedor'] || rr['clave proveedor'] || ''),
        c:String(rr['concepto_gasto'] || rr['concepto gasto'] || ''),
        cc:String(rr['centro_costo'] || rr['centro costo'] || CENTRO_DEFAULT),
        f:'layout'
      };
    }
  }

  return null;
}

function buscarSupabase(desc) {
  try {
    var url = getSupabaseUrl(), key = getSupabaseKey();
    if (!url || !key) return null;

    var dn = normSupa(desc);
    if (!dn || dn.length < 3) return null;

    if (!_supabaseCache) {
      var r = UrlFetchApp.fetch(
        url + '/rest/v1/clasificaciones?select=clave_proveedor,concepto_gasto,centro_costo,descripcion_norm,veces_visto&clave_proveedor=neq.REVISAR&order=veces_visto.desc&limit=500',
        {
          method:'get',
          headers:{ 'apikey':key, 'Authorization':'Bearer ' + key },
          muteHttpExceptions:true
        }
      );

      if (r.getResponseCode() !== 200) return null;
      _supabaseCache = JSON.parse(r.getContentText());
    }

    var best = 0, found = null;

    _supabaseCache.forEach(function(row) {
      var s = similitudMejorada(dn, row.descripcion_norm || '') + Math.min((row.veces_visto || 1) * 0.01, 0.15);
      if (s > best) {
        best = s;
        found = row;
      }
    });

    if (best >= CONFIG.MIN_MATCH_SCORE && found) {
      return {
        k:found.clave_proveedor,
        c:found.concepto_gasto || '',
        cc:found.centro_costo || CENTRO_DEFAULT,
        f:'supabase'
      };
    }

  } catch (e) {}

  return null;
}

function guardarSupabase(tx, clas, forzar) {
  try {
    var url = getSupabaseUrl(), key = getSupabaseKey();
    if (!url || !key || !tx.descripcion) return;

    var dn = normSupa(tx.descripcion);
    if (!dn || dn.length < 3) return;

    UrlFetchApp.fetch(url + '/rest/v1/clasificaciones', {
      method:'post',
      headers:{
        'apikey':key,
        'Authorization':'Bearer ' + key,
        'Content-Type':'application/json',
        'Prefer':'resolution=merge-duplicates'
      },
      payload:JSON.stringify({
        descripcion: tx.descripcion.substring(0, 500),
        descripcion_norm: dn,
        referencia: (tx.referencia || '').substring(0, 100),
        clave_proveedor: clas.clave_proveedor || 'REVISAR',
        concepto_gasto: clas.concepto_gasto || '',
        centro_costo: clas.centro_costo || CENTRO_DEFAULT,
        fuente: forzar ? 'humano' : 'auto',
        confianza: forzar ? 1.0 : 0.8,
        veces_visto: forzar ? 3 : 1
      }),
      muteHttpExceptions:true
    });

  } catch (e) {}
}

// =============================================================
// SINCRONIZAR
// =============================================================

function sincronizarSupabaseASheets() {
  var ui = SpreadsheetApp.getUi(), url = getSupabaseUrl(), key = getSupabaseKey();
  if (!url || !key) {
    ui.alert('Faltan credenciales Supabase.');
    return;
  }

  try {
    var resp = UrlFetchApp.fetch(
      url + '/rest/v1/clasificaciones?select=descripcion_norm,clave_proveedor,concepto_gasto,centro_costo&order=veces_visto.desc&limit=1000',
      {
        method:'get',
        headers:{ 'apikey':key, 'Authorization':'Bearer ' + key },
        muteHttpExceptions:true
      }
    );

    if (resp.getResponseCode() !== 200) {
      ui.alert('Error: ' + resp.getContentText());
      return;
    }

    var mapa = {};
    JSON.parse(resp.getContentText()).forEach(function(c) {
      if (c.descripcion_norm) mapa[c.descripcion_norm] = c;
    });

    var hoja = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID).getSheetByName(CONFIG.STEP3_TAB);
    var datos = hoja.getDataRange().getValues(), hdr = datos[0].map(function(h) { return norm(String(h)); });

    var C = {
      clave: findCol(hdr, ['clave_proveedor','clave proveedor','claveproveedor']),
      centro: findCol(hdr, ['centro_costo','centro costo','centrocosto']),
      concepto: findCol(hdr, ['concepto_gasto','concepto gasto','conceptogasto']),
      desc: findCol(hdr, ['descripcion','description'])
    };

    var act = 0;

    for (var i = 1; i < datos.length; i++) {
      var dr = String(datos[i][C.desc] || '').trim(), cr = String(datos[i][C.clave] || '').trim();
      if (!dr || (cr && cr !== 'REVISAR')) continue;

      var dn = normSupa(dr), cl = mapa[dn];

      if (!cl) {
        var best = 0;
        for (var k2 in mapa) {
          var s = similitudMejorada(dn, k2);
          if (s > best && s >= 0.7) {
            best = s;
            cl = mapa[k2];
          }
        }
      }

      if (!cl || cl.clave_proveedor === 'REVISAR') continue;

      if (C.clave >= 0 && cl.clave_proveedor) hoja.getRange(i + 1, C.clave + 1).setValue(cl.clave_proveedor);
      if (C.concepto >= 0 && cl.concepto_gasto) hoja.getRange(i + 1, C.concepto + 1).setValue(cl.concepto_gasto);
      if (C.centro >= 0 && cl.centro_costo) hoja.getRange(i + 1, C.centro + 1).setValue(cl.centro_costo);
      act++;
    }

    SpreadsheetApp.flush();
    ui.alert('✅ Sincronización\nActualizadas: ' + act);

  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

function sincronizarCorrecciones() {
  var ui = SpreadsheetApp.getUi();

  try {
    var hoja = SpreadsheetApp.openById(CONFIG.STEP2_SHEET_ID).getSheetByName(CONFIG.STEP2_TAB);
    var datos = hoja.getDataRange().getValues(), hdr = datos[0].map(function(h) { return String(h).toLowerCase().trim(); });

    var cD = hdr.indexOf('descripcion'), cC = hdr.indexOf('correccion');

    if (cC < 0) {
      ui.alert('Agrega columna CORRECCION en STEP2.');
      return;
    }

    var n = 0;

    for (var i = 1; i < datos.length; i++) {
      var corr = String(datos[i][cC] || '').trim();
      if (!corr || corr.indexOf('OK:') === 0) continue;

      var p = corr.split('|');
      if (!p[0]) continue;

      guardarSupabase(
        { descripcion:String(datos[i][cD] || '').trim(), referencia:'' },
        { clave_proveedor:p[0] || '', concepto_gasto:p[1] || '', centro_costo:p[2] || CENTRO_DEFAULT },
        true
      );

      hoja.getRange(i + 1, cC + 1).setValue('OK:' + p[0]);
      n++;
    }

    ui.alert('Listo', 'Correcciones: ' + n, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Error', e.message, ui.ButtonSet.OK);
  }
}

function sincronizarCorreccionesAuto() {
  try {
    var hoja = SpreadsheetApp.openById(CONFIG.STEP2_SHEET_ID).getSheetByName(CONFIG.STEP2_TAB);
    var datos = hoja.getDataRange().getValues(), hdr = datos[0].map(function(h) { return String(h).toLowerCase().trim(); });

    var cD = hdr.indexOf('descripcion'),
        cC = hdr.indexOf('correccion'),
        cR = hdr.indexOf('referencia');

    if (cC < 0 || cD < 0) return;

    for (var i = 1; i < datos.length; i++) {
      var corr = String(datos[i][cC] || '').trim();
      if (!corr || corr.indexOf('OK:') === 0) continue;

      var p = corr.split('|');
      if (!p[0]) continue;

      guardarSupabase(
        {
          descripcion:String(datos[i][cD] || '').trim(),
          referencia:cR >= 0 ? String(datos[i][cR] || '').trim() : ''
        },
        {
          clave_proveedor:p[0].trim(),
          concepto_gasto:(p[1] || '').trim(),
          centro_costo:(p[2] || CENTRO_DEFAULT).trim()
        },
        true
      );

      hoja.getRange(i + 1, cC + 1).setValue('OK:' + p[0].trim());
    }

  } catch (e) {}
}

// =============================================================
// UTILIDADES SHEET
// =============================================================

function leerSheet(sheetId, tabName) {
  try {
    var hoja = SpreadsheetApp.openById(sheetId).getSheetByName(tabName);
    if (!hoja) return [];

    var datos = hoja.getDataRange().getValues();
    if (datos.length < 2) return [];

    var hdr = datos[0].map(function(h) { return norm(String(h)); });

    return datos.slice(1).map(function(row) {
      var o = {};
      hdr.forEach(function(h, i) { o[h] = row[i]; });
      return o;
    });

  } catch (e) {
    return [];
  }
}

function appendSheet(sheetId, tabName, filas) {
  var hoja = SpreadsheetApp.openById(sheetId).getSheetByName(tabName);
  if (!hoja) throw new Error('Pestaña no encontrada: ' + tabName);
  hoja.getRange(hoja.getLastRow() + 1, 1, hoja.getLastRow() + filas.length, filas[0].length).setValues(filas);
}

function obtenerFilenames(sheetId, tabName) {
  var s = new Set();

  [[sheetId, tabName], [CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB]].forEach(function(par) {
    try {
      var h = SpreadsheetApp.openById(par[0]).getSheetByName(par[1]);
      if (!h) return;

      var d = h.getDataRange().getValues();
      if (!d || d.length < 2) return;

      var col = d[0].map(function(hh) { return String(hh).toLowerCase().trim(); }).indexOf('filename');
      if (col >= 0) {
        for (var i = 1; i < d.length; i++) if (d[i][col]) s.add(String(d[i][col]).trim());
      }

    } catch (e) {}
  });

  return s;
}

function buscarCSVsNuevos(procesados) {
  var f = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).getFilesByType(MimeType.CSV), r = [];
  while (f.hasNext()) {
    var a = f.next();
    if (!procesados.has(a.getName())) r.push(a);
  }
  return r;
}

function parsearCSV(archivo) {
  var lineas = archivo.getBlob().getDataAsString('UTF-8')
    .split('\n')
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 0; });

  var hi = CONFIG.CSV_HEADER_ROW - 1;
  if (lineas.length <= hi) return [];

  var hdr = splitCSV(lineas[hi]).map(function(h) {
    return String(h).toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s_]/g, '')
      .trim();
  });

  var idx = {
    fecha: findCol(hdr, ['fecha','date','fecha operacion','fecha valor']),
    desc:  findCol(hdr, ['descripcion','description','concepto','detalle','movimiento']),
    ref:   findCol(hdr, ['referencia','no referencia','folio','clave rastreo']),
    cargo: findCol(hdr, ['cargo','cargos','debito','retiro','egreso']),
    abono: findCol(hdr, ['abono','abonos','credito','deposito','ingreso'])
  };

  var txs = [];

  for (var i = hi + 1; i < lineas.length; i++) {
    var cols = splitCSV(lineas[i]);

    var cargo = limpiarNum(idx.cargo >= 0 ? cols[idx.cargo] || '' : '');
    var abono = limpiarNum(idx.abono >= 0 ? cols[idx.abono] || '' : '');

    if (cargo === 0 && abono === 0) continue;

    txs.push({
      fecha: idx.fecha >= 0 ? (cols[idx.fecha] || '').trim() : '',
      desc: idx.desc >= 0 ? (cols[idx.desc] || '').trim() : '',
      ref: idx.ref >= 0 ? (cols[idx.ref] || '').trim() : '',
      cargo: cargo,
      abono: abono
    });
  }

  return txs;
}

// =============================================================
// NORMALIZACIÓN Y SIMILITUD
// =============================================================

function norm(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function normSupa(str) {
  var sw = ['de','la','el','en','sa','cv','por','del','al','los','las'];
  return norm(str).split(/\s+/).filter(function(w) {
    return w.length > 1 && sw.indexOf(w) < 0;
  }).join(' ');
}

function similitud(a, b) {
  return similitudMejorada(a, b);
}

function similitudMejorada(a, b) {
  if (!a || !b) return 0;

  var wa = a.split(/\s+/).filter(function(w) { return w.length > 2; });
  var wb = new Set(b.split(/\s+/).filter(function(w) { return w.length > 2; }));

  var wS = 0;
  if (wa.length > 0 && wb.size > 0) {
    var wn = 0;
    wa.forEach(function(w) { if (wb.has(w)) wn++; });
    wS = wn / Math.max(wa.length, wb.size);
  }

  function bg(s) {
    var x = new Set();
    for (var i = 0; i < s.length - 1; i++) x.add(s[i] + s[i + 1]);
    return x;
  }

  var ba = bg(a.replace(/\s/g, '')),
      bb = bg(b.replace(/\s/g, ''));

  var bS = 0;
  if (ba.size > 0 && bb.size > 0) {
    var bi = 0;
    ba.forEach(function(x) { if (bb.has(x)) bi++; });
    bS = bi / (ba.size + bb.size - bi);
  }

  var pw = wa.length >= 3 ? 0.7 : 0.4;
  return wS * pw + bS * (1 - pw);
}

function findCol(hdr, cands) {
  var ns = cands.map(function(c) { return norm(c); });

  for (var i = 0; i < ns.length; i++) {
    var x = hdr.indexOf(ns[i]);
    if (x >= 0) return x;
  }

  for (var a = 0; a < ns.length; a++) {
    for (var b = 0; b < hdr.length; b++) {
      if (hdr[b].indexOf(ns[a]) >= 0 || ns[a].indexOf(hdr[b]) >= 0) return b;
    }
  }

  return -1;
}

function limpiarNum(str) {
  return parseFloat(String(str || '').replace(/[$,\s]/g, '')) || 0;
}

function splitCSV(linea) {
  var r = [], a = '', q = false;

  for (var i = 0; i < linea.length; i++) {
    var c = linea[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) {
      r.push(a);
      a = '';
    } else {
      a += c;
    }
  }

  r.push(a);
  return r;
}

// =============================================================
// ALERTAS, LOG, COLORES
// =============================================================

function verificarGastosInusuales() {
  var alertas = [];

  try {
    var datos = leerSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB);
    if (!datos || datos.length < 10) return alertas;

    var pp = {};

    datos.forEach(function(r) {
      var k = String(r['clave proveedor'] || r['clave_proveedor'] || r['claveproveedor'] || '').trim();
      var imp = limpiarNum(String(r['importe'] || r['cargo'] || r['cargos'] || '0'));

      if (!k || k === 'REVISAR' || k === 'INTER EMPRESA' || k === 'BANREGIO' || imp <= 0) return;

      if (!pp[k]) pp[k] = [];
      pp[k].push(imp);
    });

    for (var k in pp) {
      var v = pp[k];
      if (v.length < 3) continue;

      var ult = v[v.length - 1];
      var prom = v.slice(0, -1).reduce(function(a, b) { return a + b; }, 0) / (v.length - 1);

      if (prom > 0 && ult > prom * 2.5) {
        alertas.push('• ' + k + ': $' + ult.toLocaleString() + ' (prom $' + Math.round(prom).toLocaleString() + ')');
      }
    }

  } catch (e) {}

  return alertas;
}

function escribirLog(fecha, archivos, transacciones, resultado, nomSem) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.STEP2_SHEET_ID);
    var log = ss.getSheetByName('LOG');

    if (!log) {
      log = ss.insertSheet('LOG');
      log.getRange(1, 1, 1, 8).setValues([[
        'FECHA','ARCHIVOS','TRANSACCIONES','CONCEPTOS','REVISAR_RESUELTOS','TIEMPO_AGOTADO','PESTAÑA_SEMANAL','NOTAS'
      ]]);
      log.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#1A1A1A').setFontColor('#F5B800');
    }

    log.appendRow([
      Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'),
      archivos,
      transacciones,
      resultado.conceptos,
      resultado.resueltos,
      resultado.tiempoAgotado ? 'SÍ' : 'NO',
      nomSem || '',
      'Solo reglas configuradas'
    ]);

  } catch (e) {}
}

function colorearFilasNuevas(sheetId, tabName, cantidad) {
  try {
    var hoja = SpreadsheetApp.openById(sheetId).getSheetByName(tabName);
    var ul = hoja.getLastRow(), ini = ul - cantidad + 1;
    if (ini < 2) ini = 2;
    hoja.getRange(ini, 1, ul, hoja.getLastColumn()).setBackground('#FFF9C4');
  } catch (e) {}
}

// =============================================================
// DASHBOARD
// =============================================================

function actualizarDashboard() {
  var ui = SpreadsheetApp.getUi();

  try {
    var ss = SpreadsheetApp.openById(CONFIG.STEP3_SHEET_ID);
    var dash = ss.getSheetByName('DASHBOARD') || ss.insertSheet('DASHBOARD');

    dash.clearContents();
    dash.clearFormats();

    var datos = leerSheet(CONFIG.STEP3_SHEET_ID, CONFIG.STEP3_TAB);
    if (!datos || datos.length === 0) {
      ui.alert('Sin datos.');
      return;
    }

    var pc = {}, pp = {}, total = 0;

    datos.forEach(function(r) {
      var con = String(r['concepto gasto'] || r['concepto_gasto'] || r['conceptogasto'] || '').trim() || 'Sin clasificar';
      var prov = String(r['clave proveedor'] || r['clave_proveedor'] || r['claveproveedor'] || '').trim() || 'REVISAR';
      var imp = limpiarNum(String(r['importe'] || r['cargo'] || r['cargos'] || '0'));

      if (imp <= 0) return;

      pc[con] = (pc[con] || 0) + imp;
      pp[prov] = (pp[prov] || 0) + imp;
      total += imp;
    });

    function toArr(o) {
      var a = [];
      for (var k in o) a.push([k, o[k]]);
      a.sort(function(x, y) { return y[1] - x[1]; });
      return a;
    }

    var ca = toArr(pc), pa = toArr(pp).slice(0, 15);

    dash.getRange('A1').setValue('DASHBOARD BANREGIO').setFontSize(16).setFontWeight('bold');
    dash.getRange('A2').setValue('Actualizado: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'));
    dash.getRange('A3').setValue('TOTAL: $' + Math.round(total).toLocaleString()).setFontSize(13).setFontWeight('bold').setFontColor('#B71C1C');

    ['A5','B5','C5'].forEach(function(r, i) {
      dash.getRange(r).setValue(['CONCEPTO','MONTO','%'][i]).setFontWeight('bold').setBackground('#1A1A1A').setFontColor('#F5B800');
    });

    ca.forEach(function(x, i) {
      dash.getRange(6 + i, 1).setValue(x[0]);
      dash.getRange(6 + i, 2).setValue(x[1]).setNumberFormat('$#,##0.00');
      dash.getRange(6 + i, 3).setValue(total > 0 ? (x[1] / total * 100).toFixed(1) + '%' : '0%');

      if (i % 2 === 0) dash.getRange(6 + i, 1, 6 + i, 3).setBackground('#FFF9C4');
    });

    ['E5','F5'].forEach(function(r, i) {
      dash.getRange(r).setValue(['TOP PROVEEDORES','MONTO'][i]).setFontWeight('bold').setBackground('#1A1A1A').setFontColor('#F5B800');
    });

    pa.forEach(function(x, j) {
      dash.getRange(6 + j, 5).setValue(x[0]);
      dash.getRange(6 + j, 6).setValue(x[1]).setNumberFormat('$#,##0.00');

      if (j % 2 === 0) dash.getRange(6 + j, 5, 6 + j, 6).setBackground('#FFF4CC');
    });

    dash.autoResizeColumns(1, 7);
    ui.alert('Dashboard actualizado ✅');

  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

// =============================================================
// TRIGGERS
// =============================================================

function configurarTrigger() {
  var ui = SpreadsheetApp.getUi(), ts = ScriptApp.getProjectTriggers();

  var ex = ts.some(function(t) {
    return t.getHandlerFunction() === 'clasificarTodo';
  });

  if (ex) {
    if (ui.alert('¿Desactivar?', ui.ButtonSet.YES_NO) === ui.Button.YES) {
      ts.forEach(function(t) {
        if (t.getHandlerFunction() === 'clasificarTodo') ScriptApp.deleteTrigger(t);
      });
      ui.alert('Desactivado.');
    }
  } else {
    ScriptApp.newTrigger('clasificarTodo').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
    ui.alert('✅ Lunes 8am activado.');
  }
}

function configurarTriggerSincronizacion() {
  var ui = SpreadsheetApp.getUi(), ts = ScriptApp.getProjectTriggers();

  var ex = ts.some(function(t) {
    return t.getHandlerFunction() === 'sincronizarSupabaseASheets';
  });

  if (ex) {
    if (ui.alert('¿Desactivar?', ui.ButtonSet.YES_NO) === ui.Button.YES) {
      ts.forEach(function(t) {
        if (t.getHandlerFunction() === 'sincronizarSupabaseASheets') ScriptApp.deleteTrigger(t);
      });
      ui.alert('Desactivado.');
    }
  } else {
    ScriptApp.newTrigger('sincronizarSupabaseASheets').timeBased().everyHours(1).create();
    ui.alert('✅ Sync cada hora activado.');
  }
}

// =============================================================
// DEBUG
// =============================================================

function debugVerCabeceras() {
  var ui = SpreadsheetApp.getUi();

  try {
    var f = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).getFilesByType(MimeType.CSV);
    if (!f.hasNext()) {
      ui.alert('No hay CSVs.');
      return;
    }

    var a = f.next();
    var lines = a.getBlob().getDataAsString('UTF-8').split('\n').map(function(l) { return l.trim(); }).filter(Boolean);

    var hi = CONFIG.CSV_HEADER_ROW - 1;
    var msg = 'Archivo: ' + a.getName() + '\nHeaders fila ' + CONFIG.CSV_HEADER_ROW + ':\n';

    if (lines[hi]) {
      splitCSV(lines[hi]).forEach(function(h, i) {
        msg += '  Col ' + (i + 1) + ': "' + h + '"\n';
      });
    }

    ui.alert('Debug', msg, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Error', e.message, ui.ButtonSet.OK);
  }
}

function testVerArchivos() {
  var ui = SpreadsheetApp.getUi();

  try {
    var f = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).getFilesByType(MimeType.CSV), n = [];
    while (f.hasNext()) n.push(f.next().getName());
    ui.alert('CSVs (' + n.length + ')', n.length ? n.join('\n') : 'No hay.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Error', e.message, ui.ButtonSet.OK);
  }
}
