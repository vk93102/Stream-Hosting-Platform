process.on('uncaughtException', e => { process.stderr.write('UNCAUGHT: ' + e.stack + '\n'); process.exit(1); });
process.on('unhandledRejection', e => { process.stderr.write('UNHANDLED: ' + e + '\n'); process.exit(1); });
const steps = [
  ['dotenv',       () => require('dotenv').config()],
  ['express',      () => require('express')],
  ['config',       () => require('./config')],
  ['logger',       () => require('./utils/logger')],
  ['db',           () => require('./db/database')],
  ['ws',           () => require('./services/websocketServer')],
  ['streamHealth', () => require('./services/streamHealth')],
  ['auth route',   () => require('./routes/auth')],
  ['users route',  () => require('./routes/users')],
  ['admin route',  () => require('./routes/admin')],
  ['media route',  () => require('./routes/media')],
];
for (const [name, fn] of steps) {
  try {
    process.stderr.write('[OK] loading: ' + name + '\n');
    fn();
  } catch(e) {
    process.stderr.write('[FAIL] ' + name + ': ' + e.stack + '\n');
    process.exit(1);
  }
}
process.stderr.write('ALL MODULES OK — checking port 3000\n');
const http = require('http');
http.createServer((req,res)=>res.end('ok')).listen(3000, () => {
  process.stderr.write('Listening on 3000\n');
  process.exit(0);
});
