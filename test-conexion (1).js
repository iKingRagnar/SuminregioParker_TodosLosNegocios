require('dotenv').config();
const Firebird = require('node-firebird');

const options = {
  host:     process.env.FB_HOST,
  port:     parseInt(process.env.FB_PORT),
  database: process.env.FB_DATABASE,
  user:     process.env.FB_USER,
  password: process.env.FB_PASSWORD,
};

console.log('Conectando a:', options.database);

Firebird.attach(options, function(err, db) {
  if (err) {
    console.error('ERROR de conexion:', err.message);
    process.exit(1);
  }

  console.log('Conexion exitosa!');
  console.log('');

  var sql = "SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE RDB$SYSTEM_FLAG = 0 ORDER BY RDB$RELATION_NAME";

  db.query(sql, [], function(err, rows) {
    if (err) {
      console.error('Error en query:', err.message);
      db.detach();
      return;
    }

    console.log('Tablas encontradas:', rows.length);
    console.log('');

    for (var i = 0; i < rows.length; i++) {
      var nombre = Object.values(rows[i])[0].toString().trim();
      console.log(nombre);
    }

    db.detach();
  });
});