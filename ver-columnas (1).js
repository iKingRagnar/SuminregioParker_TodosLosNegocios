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

  var sql = "SELECT r.RDB$FIELD_NAME FROM RDB$RELATION_FIELDS r WHERE r.RDB$RELATION_NAME = 'DOCTOS_VE' ORDER BY r.RDB$FIELD_POSITION";

  db.query(sql, [], function(err, rows) {
    if (err) { console.error('Error:', err.message); db.detach(); return; }
    console.log('Columnas de DOCTOS_VE:');
    console.log('');
    for (var i = 0; i < rows.length; i++) {
      console.log(Object.values(rows[i])[0].toString().trim());
    }
    db.detach();
  });
});