const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'leads.db');

let db = null;

/** Save DB to disk with retries for file locking */
async function saveDb(retries = 3, delay = 100) {
  if (!db) return;
  
  const data = db.export();
  const buffer = Buffer.from(data);
  
  if (buffer.length === 0 && data.length > 0) {
    console.error('❌ Database export error: Empty buffer');
    return;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const tempPath = DB_PATH + '.tmp';
      fs.writeFileSync(tempPath, buffer);
      
      // Force sync to disk
      const fd = fs.openSync(tempPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      fs.renameSync(tempPath, DB_PATH);
      // console.log('💾 Database saved successfully.');
      return; 
    } catch (error) {
      if (i === retries - 1) {
        console.error('❌ Final Database save error:', error.message);
      } else {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

// Auto-save every 60 seconds (less frequent to reduce disk pressure)
setInterval(saveDb, 60000);

/** Initialize the database */
async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id TEXT UNIQUE,
      business_name TEXT NOT NULL,
      niche TEXT,
      location TEXT,
      address TEXT,
      website TEXT,
      phone TEXT,
      email TEXT,
      rating REAL,
      review_count INTEGER,
      score INTEGER DEFAULT 0,
      service_type TEXT,
      recommendation TEXT,
      reasoning TEXT,
      status TEXT DEFAULT 'new',
      email_draft TEXT,
      whatsapp_draft TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS outreach_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      email_subject TEXT,
      email_body TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      follow_up_number INTEGER DEFAULT 0,
      response_status TEXT DEFAULT 'pending',
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS niches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      total_leads INTEGER DEFAULT 0,
      contacted INTEGER DEFAULT 0,
      responses INTEGER DEFAULT 0,
      best_service TEXT,
      reasoning TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  try {
    db.run('ALTER TABLE leads ADD COLUMN whatsapp_draft TEXT');
  } catch(e) {}

  saveDb();
  console.log('✅ Database initialized.');
  return db;
}

// ─── Helper: run query and return rows ─────────────────
function queryAll(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function runSql(sql, params = []) {
  if (!db) return;
  db.run(sql, params);
  // Fire and forget save for general usage, but it maps to the auto-save interval too
  saveDb().catch(err => console.error('BG Save Error:', err.message));
}

// ─── Lead Operations ────────────────────────────────────
function insertLead(lead) {
  try {
    const { syncLeadToSheets } = require('../services/googleSheets');
    runSql(`INSERT OR IGNORE INTO leads (place_id, business_name, niche, location, address, website, phone, email, rating, review_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lead.place_id, lead.business_name, lead.niche, lead.location, lead.address, lead.website, lead.phone, lead.email, lead.rating, lead.review_count]);
    
    // Trigger Sheets sync after successful DB insert
    syncLeadToSheets(lead).catch(err => console.error('Sheet sync non-blocking error:', err.message));
    
    return true;
  } catch (e) {
    return false;
  }
}

function updateLeadScore(id, score, service_type, recommendation, reasoning) {
  runSql(`UPDATE leads SET score = ?, service_type = ?, recommendation = ?, reasoning = ?, status = 'scored', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [score, service_type, recommendation, reasoning, id]);
}

function updateLeadStatus(id, status) {
  runSql(`UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, id]);
}

function updateLeadEmail(id, email_draft) {
  runSql(`UPDATE leads SET email_draft = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [email_draft, id]);
}

function updateLeadWhatsApp(id, whatsapp_draft) {
  runSql(`UPDATE leads SET whatsapp_draft = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [whatsapp_draft, id]);
}

function markDraftsReady(id) {
  runSql(`UPDATE leads SET status = 'email_ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
}

function updateLeadEmailAddress(id, email) {
  runSql(`UPDATE leads SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [email, id]);
}

function getLeadById(id) {
  return queryOne('SELECT * FROM leads WHERE id = ?', [id]);
}

function getAllLeads() {
  return queryAll('SELECT * FROM leads ORDER BY score DESC, created_at DESC');
}

function getLeadsByStatus(status) {
  return queryAll('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC, score DESC', [status]);
}

function getLeadsByNiche(niche) {
  return queryAll('SELECT * FROM leads WHERE niche = ? ORDER BY score DESC', [niche]);
}

function getUnscoredLeads() {
  return queryAll("SELECT * FROM leads WHERE score = 0 AND status = 'new'");
}

function getReadyToContact() {
  return queryAll("SELECT * FROM leads WHERE score >= 50 AND status = 'scored' AND email IS NOT NULL AND email != '' ORDER BY score DESC");
}

function getLeadsCreatedToday() {
  return queryAll(`
    SELECT * FROM leads 
    WHERE created_at >= datetime('now', '-24 hours')
    ORDER BY score DESC
  `);
}

/** Count emails sent today (from outreach_log) */
function getEmailsSentToday() {
  const result = queryOne(`
    SELECT COUNT(*) as count FROM outreach_log
    WHERE sent_at >= datetime('now', 'start of day')
  `);
  return result ? result.count : 0;
}

/** Count new leads found today */
function getLeadsFoundToday() {
  const result = queryOne(`
    SELECT COUNT(*) as count FROM leads
    WHERE created_at >= datetime('now', 'start of day')
  `);
  return result ? result.count : 0;
}

function getLeadsNeedingFollowUp() {
  return queryAll(`
    SELECT l.* FROM leads l
    JOIN outreach_log o ON l.id = o.lead_id
    WHERE l.status = 'contacted' AND o.response_status = 'pending'
    AND o.sent_at < datetime('now', '-3 days')
    AND o.follow_up_number < 2
    ORDER BY l.score DESC
  `);
}

function checkDuplicate(place_id) {
  return queryOne('SELECT id FROM leads WHERE place_id = ?', [place_id]);
}

// ─── Outreach Operations ────────────────────────────────
function insertOutreach(lead_id, email_subject, email_body, follow_up_number) {
  runSql(`INSERT INTO outreach_log (lead_id, email_subject, email_body, follow_up_number) VALUES (?, ?, ?, ?)`,
    [lead_id, email_subject, email_body, follow_up_number || 0]);
}

function getOutreachByLead(lead_id) {
  return queryAll('SELECT * FROM outreach_log WHERE lead_id = ? ORDER BY sent_at DESC', [lead_id]);
}

// ─── Niche Operations ───────────────────────────────────
function upsertNiche(name, total_leads, best_service, reasoning) {
  const existing = queryOne('SELECT id FROM niches WHERE name = ?', [name]);
  if (existing) {
    runSql(`UPDATE niches SET total_leads = ?, best_service = ?, reasoning = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
      [total_leads, best_service, reasoning, name]);
  } else {
    runSql(`INSERT INTO niches (name, total_leads, best_service, reasoning) VALUES (?, ?, ?, ?)`,
      [name, total_leads, best_service, reasoning]);
  }
}

function getAllNiches() {
  return queryAll('SELECT * FROM niches ORDER BY total_leads DESC');
}

// ─── Dashboard Stats ────────────────────────────────────
function getStats() {
  const totalLeads = queryOne('SELECT COUNT(*) as count FROM leads')?.count || 0;
  const contacted = queryOne("SELECT COUNT(*) as count FROM leads WHERE status IN ('contacted', 'followed_up', 'responded')")?.count || 0;
  const responded = queryOne("SELECT COUNT(*) as count FROM leads WHERE status = 'responded'")?.count || 0;
  const scored = queryOne("SELECT COUNT(*) as count FROM leads WHERE score > 0")?.count || 0;
  const avgScore = queryOne('SELECT AVG(score) as avg FROM leads WHERE score > 0')?.avg || 0;
  const topNiches = queryAll(`
    SELECT niche, COUNT(*) as count, AVG(score) as avg_score 
    FROM leads WHERE niche IS NOT NULL 
    GROUP BY niche ORDER BY avg_score DESC LIMIT 10
  `);
  const recentLeads = queryAll('SELECT * FROM leads ORDER BY created_at DESC LIMIT 20');
  const statusBreakdown = queryAll('SELECT status, COUNT(*) as count FROM leads GROUP BY status');
  const serviceBreakdown = queryAll("SELECT service_type, COUNT(*) as count FROM leads WHERE service_type IS NOT NULL GROUP BY service_type");

  return { totalLeads, contacted, responded, scored, avgScore: Math.round(avgScore), topNiches, recentLeads, statusBreakdown, serviceBreakdown };
}

// ─── Settings ───────────────────────────────────────────
function getSetting(key) {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setSetting(key, value) {
  runSql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// ─── Niche Stats for Analyzer ───────────────────────────
function getNicheData() {
  return queryAll(`
    SELECT niche, COUNT(*) as total, AVG(score) as avg_score,
    SUM(CASE WHEN status IN ('contacted','followed_up','responded') THEN 1 ELSE 0 END) as contacted,
    SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) as responses
    FROM leads WHERE niche IS NOT NULL GROUP BY niche
  `);
}

module.exports = {
  initDatabase,
  insertLead,
  updateLeadScore,
  updateLeadStatus,
  updateLeadEmail,
  updateLeadWhatsApp,
  markDraftsReady,
  updateLeadEmailAddress,
  getLeadById,
  getAllLeads,
  getLeadsByStatus,
  getLeadsByNiche,
  getUnscoredLeads,
  getReadyToContact,
  getLeadsCreatedToday,
  getLeadsNeedingFollowUp,
  getEmailsSentToday,
  getLeadsFoundToday,
  checkDuplicate,
  insertOutreach,
  getOutreachByLead,
  upsertNiche,
  getAllNiches,
  getStats,
  getSetting,
  setSetting,
  getNicheData,
  saveDb,
  queryAll,
  queryOne
};
