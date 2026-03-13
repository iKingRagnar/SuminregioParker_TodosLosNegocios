const { exec } = require('child_process');
exec('ngrok http 7000', (err, stdout) => { console.log(stdout); });