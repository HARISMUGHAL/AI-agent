const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
async function run() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, 'data', 'leads.db');
  if(!fs.existsSync(dbPath)) return;
  const db = new SQL.Database(fs.readFileSync(dbPath));
  db.run("DELETE FROM settings WHERE key = 'gmail_refresh_token'");
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  console.log('Cleared corrupted token');
}
run();
