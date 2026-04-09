const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
async function run() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, 'data', 'leads.db');
  if(!fs.existsSync(dbPath)) return;
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const r = db.exec("SELECT * FROM settings WHERE key='gmail_refresh_token'");
  console.log(JSON.stringify(r, null, 2));
}
run();
