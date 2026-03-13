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
  console.log('Conectado OK');

  db.query("SELECT FIRST 3 DOCTO_VE_ID, TIPO_DOCTO, ESTATUS, IMPORTE_NETO, IMPORTE_COBRO FROM DOCTOS_VE", [], function(err, rows) {
    if (err) { console.error('Error:', err.message); db.detach(); return; }
    console.log('Total filas:', rows ? rows.length : 0);
    for (var i = 0; i < rows.length; i++) {
      console.log(JSON.stringify(rows[i]));
    }
    db.detach();
  });
});