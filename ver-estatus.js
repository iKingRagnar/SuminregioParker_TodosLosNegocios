require('dotenv').config();
const Firebird = require('node-firebird');

const options = {
  host:     process.env.FB_HOST,
  port:     parseInt(process.env.FB_PORT),
  database: process.env.FB_DATABASE,
  user:     process.env.FB_USER,
  password: process.env.FB_PASSWORD,
};

Firebird.attach(options, function(err, db) {
  if (err) { console.error('Error:', err.message); return; }

  // Ver valores distintos de ESTATUS y TIPO_DOCTO
  db.query("SELECT DISTINCT ESTATUS, TIPO_DOCTO, COUNT(*) AS TOTAL FROM DOCTOS_VE GROUP BY ESTATUS, TIPO_DOCTO ORDER BY ESTATUS, TIPO_DOCTO", [], function(err, rows) {
    if (err) { console.error('Error:', err.message); db.detach(); return; }
    console.log('Valores de ESTATUS y TIPO_DOCTO:');
    console.log('');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      console.log('ESTATUS=' + JSON.stringify(r.ESTATUS) + '  TIPO_DOCTO=' + JSON.stringify(r.TIPO_DOCTO) + '  TOTAL=' + r.TOTAL);
    }

    // Ver totales disponibles
    db.query("SELECT FIRST 3 IMPORTE_NETO, IMPORTE_COBRO FROM DOCTOS_VE WHERE TIPO_DOCTO = 'F'", [], function(err2, rows2) {
      if (!err2 && rows2) {
        console.log('');
        console.log('Ejemplo de importes en facturas:');
        for (var j = 0; j < rows2.length; j++) {
          console.log('IMPORTE_NETO=' + rows2[j].IMPORTE_NETO + '  IMPORTE_COBRO=' + rows2[j].IMPORTE_COBRO);
        }
      }
      db.detach();
    });
  });
});