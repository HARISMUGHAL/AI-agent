const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { isDataCollectionOnly: hardDataMode, assertOutreachDisabled } = require('../security/dataOnlyGuard');

const DATA_DIR = process.env.DATA_DIRECTORY ? path.resolve(process.env.DATA_DIRECTORY) : path.join(__dirname, '..', '..', 'data');
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
setInterval(saveDb, 60000).unref();

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

  db.run(`
    CREATE TABLE IF NOT EXISTS email_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      emails_sent INTEGER DEFAULT 0,
      bounces INTEGER DEFAULT 0,
      spam_complaints INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      account_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try { db.run('ALTER TABLE leads ADD COLUMN whatsapp_draft TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE outreach_log ADD COLUMN account_email TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE outreach_log ADD COLUMN bounce INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE outreach_log ADD COLUMN spam_complaint INTEGER DEFAULT 0'); } catch(e) {}

  // Phase 5: Revenue Tracking
  try { 
    db.run('ALTER TABLE leads ADD COLUMN deal_value REAL DEFAULT 0'); 
    db.run('UPDATE leads SET deal_value = 0 WHERE deal_value IS NULL');
  } catch(e) {}

  // Data collection mode columns
  const dataModeColumns = [
    'owner_or_contact_name TEXT', 'alternate_email TEXT', 'contact_page_url TEXT',
    'contact_method TEXT', 'city TEXT', 'state_or_region TEXT', 'country TEXT',
    'google_maps_url TEXT', 'website_status TEXT', 'website_issues TEXT',
    'website_evidence TEXT', 'needs_website INTEGER DEFAULT 0',
    'needs_website_redesign INTEGER DEFAULT 0', 'ai_opportunity_score INTEGER DEFAULT 0',
    'needs_ai_services INTEGER DEFAULT 0', 'recommended_service TEXT',
    'qualification_reason TEXT', 'lead_score INTEGER DEFAULT 0', 'data_source TEXT',
    'verification_status TEXT', 'outreach_status TEXT DEFAULT "not_contacted"',
    'last_review_date TEXT', 'operating_status TEXT', 'run_id TEXT'
  ];
  for (const col of dataModeColumns) {
    try { db.run(`ALTER TABLE leads ADD COLUMN ${col}`); } catch (e) {}
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS collection_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending',
      target INTEGER DEFAULT 500,
      qualified_count INTEGER DEFAULT 0,
      synced_count INTEGER DEFAULT 0,
      us_count INTEGER DEFAULT 0,
      uk_count INTEGER DEFAULT 0,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      checkpoint_data TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS search_combinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      country TEXT NOT NULL,
      city TEXT NOT NULL,
      niche TEXT NOT NULL,
      page_token TEXT DEFAULT '',
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, country, city, niche, page_token)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS data_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL,
      verification_status TEXT,
      collected_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS data_run_state (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS discovery_checkpoints (
      dataset TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source TEXT,
      city TEXT,
      category TEXT,
      country TEXT,
      page_cursor TEXT,
      candidates_fetched INTEGER DEFAULT 0,
      candidates_processed INTEGER DEFAULT 0,
      candidates_rejected INTEGER DEFAULT 0,
      duplicates_removed INTEGER DEFAULT 0,
      qualified_saved INTEGER DEFAULT 0,
      last_error TEXT,
      shortfall_reason TEXT,
      checkpoint_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS discovery_combinations (
      dataset TEXT NOT NULL,
      source TEXT NOT NULL,
      city TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      candidates_found INTEGER DEFAULT 0,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(dataset, source, city, category)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sheet_sync_state (
      dataset TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      master_status TEXT DEFAULT 'pending',
      daily_status TEXT DEFAULT 'pending',
      master_error TEXT,
      daily_error TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(dataset, fingerprint)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

// ─── Data Collection Mode ───────────────────────────────
function isDataCollectionOnly() {
  return hardDataMode();
}

function insertQualifiedLead(lead) {
  try {
    runSql(`INSERT OR IGNORE INTO leads (
      place_id, business_name, niche, location, address, website, phone, email,
      rating, review_count, score, status, owner_or_contact_name, alternate_email,
      contact_page_url, contact_method, city, state_or_region, country, google_maps_url,
      website_status, website_issues, website_evidence, needs_website, needs_website_redesign,
      ai_opportunity_score, needs_ai_services, recommended_service, qualification_reason,
      lead_score, data_source, verification_status, outreach_status, last_review_date,
      operating_status, run_id, service_type, recommendation, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lead.place_id, lead.business_name, lead.niche, lead.location, lead.address,
        lead.website || '', lead.phone || '', lead.email || '', lead.rating || 0,
        lead.review_count || 0, lead.lead_score || lead.score || 0,
        lead.status || 'qualified', lead.owner_or_contact_name || '',
        lead.alternate_email || '', lead.contact_page_url || '', lead.contact_method || '',
        lead.city || '', lead.state_or_region || '', lead.country || '',
        lead.google_maps_url || '', lead.website_status || '',
        typeof lead.website_issues === 'string' ? lead.website_issues : JSON.stringify(lead.website_issues || []),
        typeof lead.website_evidence === 'string' ? lead.website_evidence : JSON.stringify(lead.website_evidence || []),
        lead.needs_website ? 1 : 0, lead.needs_website_redesign ? 1 : 0,
        lead.ai_opportunity_score || 0, lead.needs_ai_services ? 1 : 0,
        lead.recommended_service || '', lead.qualification_reason || '',
        lead.lead_score || 0, lead.data_source || 'google_maps',
        lead.verification_status || 'pending', lead.outreach_status || 'not_contacted',
        lead.last_review_date || '', lead.operating_status || 'operational',
        lead.run_id || '', lead.recommended_service || '', lead.qualification_reason || '',
        lead.qualification_reason || ''
      ]);
    return true;
  } catch (e) {
    return false;
  }
}

function checkDuplicateByEmail(email) {
  if (!email) return null;
  return queryOne('SELECT id, place_id FROM leads WHERE email = ? COLLATE NOCASE AND email != ""', [email]);
}

function checkDuplicateByPhone(phone, name) {
  if (!phone) return null;
  const normalized = phone.replace(/\D/g, '');
  if (!normalized) return null;
  if (name) {
    return queryOne(
      'SELECT id FROM leads WHERE REPLACE(REPLACE(REPLACE(phone, "-", ""), " ", ""), "+", "") LIKE ? AND business_name = ? COLLATE NOCASE',
      [`%${normalized.slice(-10)}%`, name]
    );
  }
  return queryOne(
    'SELECT id FROM leads WHERE REPLACE(REPLACE(REPLACE(phone, "-", ""), " ", ""), "+", "") LIKE ?',
    [`%${normalized.slice(-10)}%`]
  );
}

function checkDuplicateByDomain(domain) {
  if (!domain) return null;
  const d = domain.toLowerCase().replace(/^www\./, '');
  return queryOne('SELECT id FROM leads WHERE website LIKE ?', [`%${d}%`]);
}

function createCollectionRun(target = 500) {
  const runId = `run_${Date.now()}`;
  runSql(`INSERT INTO collection_runs (run_id, status, target) VALUES (?, 'running', ?)`, [runId, target]);
  return runId;
}

function updateRunProgress(runId, data) {
  const fields = [];
  const params = [];
  if (data.qualified_count !== undefined) { fields.push('qualified_count = ?'); params.push(data.qualified_count); }
  if (data.synced_count !== undefined) { fields.push('synced_count = ?'); params.push(data.synced_count); }
  if (data.us_count !== undefined) { fields.push('us_count = ?'); params.push(data.us_count); }
  if (data.uk_count !== undefined) { fields.push('uk_count = ?'); params.push(data.uk_count); }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
  if (data.checkpoint_data !== undefined) { fields.push('checkpoint_data = ?'); params.push(typeof data.checkpoint_data === 'string' ? data.checkpoint_data : JSON.stringify(data.checkpoint_data)); }
  if (fields.length === 0) return;
  params.push(runId);
  runSql(`UPDATE collection_runs SET ${fields.join(', ')} WHERE run_id = ?`, params);
}

function getActiveRun() {
  return queryOne("SELECT * FROM collection_runs WHERE status IN ('running', 'paused') ORDER BY start_time DESC LIMIT 1");
}

function completeRun(runId) {
  runSql(`UPDATE collection_runs SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE run_id = ?`, [runId]);
}

function pauseRun(runId) {
  runSql(`UPDATE collection_runs SET status = 'paused' WHERE run_id = ?`, [runId]);
}

function recordSearchCombination(runId, country, city, niche, pageToken = '') {
  try {
    runSql('INSERT OR IGNORE INTO search_combinations (run_id, country, city, niche, page_token) VALUES (?, ?, ?, ?, ?)',
      [runId, country, city, niche, pageToken || '']);
    return true;
  } catch (e) {
    return false;
  }
}

function isSearchCombinationDone(runId, country, city, niche, pageToken = '') {
  const row = queryOne(
    'SELECT id FROM search_combinations WHERE run_id = ? AND country = ? AND city = ? AND niche = ? AND page_token = ?',
    [runId, country, city, niche, pageToken || '']
  );
  return !!row;
}

function getCollectionStats() {
  const active = getActiveRun();
  const totals = queryOne(`
    SELECT COUNT(*) as total_qualified,
      SUM(CASE WHEN country = 'United States' THEN 1 ELSE 0 END) as us_total,
      SUM(CASE WHEN country = 'United Kingdom' THEN 1 ELSE 0 END) as uk_total
    FROM leads WHERE status = 'qualified'
  `) || { total_qualified: 0, us_total: 0, uk_total: 0 };
  return { activeRun: active, totals };
}

function getQualifiedLeadCount(runId) {
  const result = queryOne('SELECT COUNT(*) as count FROM leads WHERE run_id = ? AND status = ?', [runId, 'qualified']);
  return result ? result.count : 0;
}

function getQualifiedLeadsByRun(runId, limit = 100) {
  return queryAll('SELECT * FROM leads WHERE run_id = ? AND status = ? ORDER BY lead_score DESC LIMIT ?', [runId, 'qualified', limit]);
}

function getUnsyncedQualifiedLeads(runId, limit = 50) {
  return queryAll("SELECT * FROM leads WHERE run_id = ? AND status = 'qualified' AND verification_status != 'synced' ORDER BY lead_score DESC LIMIT ?", [runId, limit]);
}

function markLeadsSynced(ids) {
  if (!ids || ids.length === 0) return;
  for (const id of ids) {
    runSql("UPDATE leads SET verification_status = 'synced', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  }
}

function getDataLeadFingerprints(dataset) {
  return new Set(queryAll('SELECT fingerprint FROM data_leads WHERE dataset = ?', [dataset]).map(row => row.fingerprint));
}

function saveDataLead(dataset, fingerprint, record) {
  if (!dataset || !fingerprint || !record) return false;
  runSql(`INSERT OR IGNORE INTO data_leads (dataset, fingerprint, record_json, verification_status, collected_date)
    VALUES (?, ?, ?, ?, ?)`, [dataset, fingerprint, JSON.stringify(record), record.verification_status || '', new Date().toISOString().slice(0, 10)]);
  return true;
}

function getDataLeads(dataset) {
  const seen = new Set();
  return queryAll('SELECT record_json FROM data_leads WHERE dataset = ? ORDER BY created_at DESC', [dataset]).map(row => {
    try { return JSON.parse(row.record_json); } catch { return null; }
  }).filter(record => {
    if (!record) return false;
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function saveDataRunState(runId, status, state) {
  runSql(`INSERT OR REPLACE INTO data_run_state (run_id, status, state_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [runId, status, JSON.stringify(state || {})]);
}

function getLatestDataRunState() {
  const row = queryOne('SELECT * FROM data_run_state ORDER BY updated_at DESC LIMIT 1');
  if (!row) return null;
  try { return { ...row, state: JSON.parse(row.state_json) }; } catch { return row; }
}

function saveDiscoveryCheckpoint(dataset, state = {}) {
  runSql(`INSERT OR REPLACE INTO discovery_checkpoints (
    dataset,status,source,city,category,country,page_cursor,candidates_fetched,candidates_processed,candidates_rejected,
    duplicates_removed,qualified_saved,last_error,shortfall_reason,checkpoint_json,updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [
    dataset, state.status || 'running', state.source || '', state.city || '', state.category || '', state.country || '', state.page_cursor || '',
    state.candidates_fetched || 0, state.candidates_processed || 0, state.candidates_rejected || 0, state.duplicates_removed || 0,
    state.qualified_saved || 0, state.last_error || '', state.shortfall_reason || '', JSON.stringify(state)
  ]);
}

function getDiscoveryCheckpoint(dataset) {
  const row = queryOne('SELECT * FROM discovery_checkpoints WHERE dataset = ?', [dataset]);
  if (!row) return null;
  try { return { ...row, ...JSON.parse(row.checkpoint_json || '{}') }; } catch { return row; }
}

function markDiscoveryCombinationCompleted(dataset, source, city, category, candidatesFound = 0) {
  runSql(`INSERT OR REPLACE INTO discovery_combinations
    (dataset, source, city, category, status, candidates_found, completed_at)
    VALUES (?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP)`,
  [dataset, source, city, category, Number(candidatesFound) || 0]);
}

function isDiscoveryCombinationCompleted(dataset, source, city, category) {
  return !!queryOne(`SELECT 1 FROM discovery_combinations
    WHERE dataset = ? AND source = ? AND city = ? AND category = ? AND status = 'completed'`,
  [dataset, source, city, category]);
}

function getDataPersistenceStats(dataset) {
  const rows = queryOne('SELECT COUNT(*) AS count FROM data_leads WHERE dataset = ?', [dataset]) || { count: 0 };
  const sync = queryOne(`SELECT
    SUM(CASE WHEN master_status = 'synced' THEN 1 ELSE 0 END) AS master_synced,
    SUM(CASE WHEN daily_status = 'synced' THEN 1 ELSE 0 END) AS daily_synced,
    SUM(CASE WHEN master_status != 'synced' OR daily_status != 'synced' THEN 1 ELSE 0 END) AS pending
    FROM sheet_sync_state WHERE dataset = ?`, [dataset]) || {};
  return { sqlite_rows: Number(rows.count || 0), master_synced: Number(sync.master_synced || 0), daily_synced: Number(sync.daily_synced || 0), pending: Number(sync.pending || 0) };
}

function markSheetSyncPending(dataset, fingerprint) {
  runSql(`INSERT OR IGNORE INTO sheet_sync_state (dataset, fingerprint) VALUES (?, ?)`, [dataset, fingerprint]);
}

function updateSheetSyncStatus(dataset, fingerprint, sheet, status, error = '') {
  const statusColumn = sheet === 'master' ? 'master_status' : 'daily_status';
  const errorColumn = sheet === 'master' ? 'master_error' : 'daily_error';
  runSql(`UPDATE sheet_sync_state SET ${statusColumn} = ?, ${errorColumn} = ?, updated_at = CURRENT_TIMESTAMP WHERE dataset = ? AND fingerprint = ?`,
    [status, error, dataset, fingerprint]);
}

function getPendingSheetSync(dataset) {
  return queryAll(`SELECT * FROM sheet_sync_state WHERE dataset = ? AND (master_status != 'synced' OR daily_status != 'synced')`, [dataset]);
}

// ─── Lead Operations ────────────────────────────────────
function insertLead(lead) {
  try {
    if (!isDataCollectionOnly()) {
      const { syncLeadToSheets } = require('../services/googleSheets');
      runSql(`INSERT OR IGNORE INTO leads (place_id, business_name, niche, location, address, website, phone, email, rating, review_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [lead.place_id, lead.business_name, lead.niche, lead.location, lead.address, lead.website, lead.phone, lead.email, lead.rating, lead.review_count]);
      syncLeadToSheets(lead).catch(err => console.error('Sheet sync non-blocking error:', err.message));
    } else {
      runSql(`INSERT OR IGNORE INTO leads (place_id, business_name, niche, location, address, website, phone, email, rating, review_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [lead.place_id, lead.business_name, lead.niche, lead.location, lead.address, lead.website, lead.phone, lead.email, lead.rating, lead.review_count]);
    }
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

function getClosingStageLeads() {
  return queryAll("SELECT * FROM leads WHERE status = 'closing_stage' ORDER BY updated_at DESC");
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

function getLeadByEmail(email) {
  if (!email) return null;
  return queryOne('SELECT * FROM leads WHERE email = ? COLLATE NOCASE', [email]);
}

/**
 * Check if an email address has already been contacted (dedup guard).
 * Returns the outreach_log row if it exists, otherwise null.
 */
function checkEmailSentBefore(email) {
  if (!email) return null;
  return queryOne(`
    SELECT o.id, o.sent_at FROM outreach_log o
    JOIN leads l ON o.lead_id = l.id
    WHERE l.email = ? COLLATE NOCASE
    ORDER BY o.sent_at DESC LIMIT 1
  `, [email]);
}

// ─── Reply Tracking ─────────────────────────────────────
function isMessageProcessed(messageId) {
  const row = queryOne('SELECT message_id FROM processed_messages WHERE message_id = ?', [messageId]);
  return !!row;
}

function markMessageProcessed(messageId) {
  runSql('INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)', [messageId]);
}

function updateOutreachResponseStatus(leadId, status) {
  runSql(`UPDATE outreach_log SET response_status = ? WHERE lead_id = ? ORDER BY id DESC LIMIT 1`, [status, leadId]);
}

// ─── Warmup Day Persistence ──────────────────────────────
/**
 * RULE 1: Warmup day must increment ONLY ONCE per calendar day.
 *
 * In-process lock (_warmupDayIncrementedForDate) prevents multiple
 * call-sites (scheduler, broadcastStatus, getWarmupStatus, etc.) from
 * triggering a second increment on the same calendar day within the
 * same Node.js process, even if the DB date-check passes momentarily
 * due to async timing.
 */
let _warmupDayIncrementedForDate = '';

function getWarmupDay() {
  assertOutreachDisabled('Warmup counters');
  const today = new Date().toDateString();

  const stored = getSetting('warmup_day');
  if (!stored) {
    // First-ever call: initialise to Day 1
    setSetting('warmup_day', '1');
    setSetting('warmup_day_date', today);
    _warmupDayIncrementedForDate = today;
    return 1;
  }

  const storedDate = getSetting('warmup_day_date') || '';

  // Only increment if:
  //  (a) The DB-persisted date differs from today, AND
  //  (b) This process has NOT already incremented for today
  if (storedDate !== today && _warmupDayIncrementedForDate !== today) {
    const nextDay = parseInt(stored, 10) + 1;
    setSetting('warmup_day', String(nextDay));
    setSetting('warmup_day_date', today);
    _warmupDayIncrementedForDate = today; // lock for rest of process day
    return nextDay;
  }

  return parseInt(stored, 10);
}

/** Force-set the warmup day (useful for testing or manual override). */
function setWarmupDay(day) {
  setSetting('warmup_day', String(day));
  setSetting('warmup_day_date', new Date().toDateString());
  _warmupDayIncrementedForDate = new Date().toDateString(); // respect the forced value
}

// ─── Health / Anti-Ban Tracking ─────────────────────────
/** Upsert today's email health row. Returns the row. */
function getTodayHealthRow(accountEmail = '') {
  const today = new Date().toISOString().slice(0, 10);
  let row = queryOne('SELECT * FROM email_health WHERE date = ? AND account_email = ?', [today, accountEmail]);
  if (!row) {
    runSql('INSERT INTO email_health (date, account_email) VALUES (?, ?)', [today, accountEmail]);
    row = queryOne('SELECT * FROM email_health WHERE date = ? AND account_email = ?', [today, accountEmail]);
  }
  return row;
}

function recordEmailSentHealth(accountEmail = '') {
  const today = new Date().toISOString().slice(0, 10);
  getTodayHealthRow(accountEmail);
  runSql('UPDATE email_health SET emails_sent = emails_sent + 1 WHERE date = ? AND account_email = ?', [today, accountEmail]);
}

function recordBounce(leadId, accountEmail = '') {
  const today = new Date().toISOString().slice(0, 10);
  getTodayHealthRow(accountEmail);
  runSql('UPDATE email_health SET bounces = bounces + 1 WHERE date = ? AND account_email = ?', [today, accountEmail]);
  runSql('UPDATE outreach_log SET bounce = 1 WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]);
  updateLeadStatus(leadId, 'bounced');
}

function recordSpamComplaint(leadId, accountEmail = '') {
  const today = new Date().toISOString().slice(0, 10);
  getTodayHealthRow(accountEmail);
  runSql('UPDATE email_health SET spam_complaints = spam_complaints + 1 WHERE date = ? AND account_email = ?', [today, accountEmail]);
  runSql('UPDATE outreach_log SET spam_complaint = 1 WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]);
  updateLeadStatus(leadId, 'spam_complaint');
}

function recordSendError(accountEmail = '') {
  const today = new Date().toISOString().slice(0, 10);
  getTodayHealthRow(accountEmail);
  runSql('UPDATE email_health SET errors = errors + 1 WHERE date = ? AND account_email = ?', [today, accountEmail]);
}

/**
 * Get today's health metrics for a specific account (or all accounts combined).
 */
function getTodayHealthMetrics(accountEmail = null) {
  const today = new Date().toISOString().slice(0, 10);
  if (accountEmail) {
    return queryOne('SELECT * FROM email_health WHERE date = ? AND account_email = ?', [today, accountEmail])
      || { emails_sent: 0, bounces: 0, spam_complaints: 0, errors: 0 };
  }
  // Aggregate across all accounts
  return queryOne(`
    SELECT SUM(emails_sent) as emails_sent, SUM(bounces) as bounces,
           SUM(spam_complaints) as spam_complaints, SUM(errors) as errors
    FROM email_health WHERE date = ?
  `, [today]) || { emails_sent: 0, bounces: 0, spam_complaints: 0, errors: 0 };
}

/**
 * RULE 3: Bounce rate = failedEmails / totalSent.
 * Returns { bounceRate, totalSent, totalFailed } aggregated globally.
 * 'failed' includes bounces + permanent errors (non-retryable sends).
 */
function getBounceRateMetrics() {
  const m = getTodayHealthMetrics(null); // global aggregate
  const totalSent   = m.emails_sent      || 0;
  const totalFailed = (m.bounces || 0) + (m.errors || 0); // all failures
  const bounceRate  = totalSent > 0 ? totalFailed / totalSent : 0;
  return { bounceRate, totalSent, totalFailed, bounces: m.bounces || 0, errors: m.errors || 0 };
}

// ─── Outreach Operations ────────────────────────────────
function insertOutreach(lead_id, email_subject, email_body, follow_up_number) {
  assertOutreachDisabled('Outreach logging');
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

// ─── Phase 5 Analytics ──────────────────────────────────
function getAnalyticsSummary() {
  const m = getTodayHealthMetrics(null);
  const totalSent = queryOne("SELECT COUNT(*) as count FROM outreach_log")?.count || 0;
  const replies = queryOne("SELECT COUNT(*) as count FROM outreach_log WHERE response_status != 'pending'")?.count || 0;
  const interested = queryOne("SELECT COUNT(*) as count FROM outreach_log WHERE response_status = 'interested'")?.count || 0;
  
  const totalRevenueRow = queryOne('SELECT SUM(deal_value) as total FROM leads WHERE status = "closing_stage"');
  const totalRevenue = totalRevenueRow?.total || 0;

  const conversionRate = totalSent > 0 ? ((interested / totalSent) * 100).toFixed(2) : 0;
  const bounceRateStats = getBounceRateMetrics();

  return {
    totalSent,
    replies,
    interested,
    conversionRate: parseFloat(conversionRate),
    totalRevenue,
    todaySent: m.emails_sent || 0,
    todayBounces: m.bounces || 0,
    globalBounceRate: (bounceRateStats.bounceRate * 100).toFixed(2) + '%'
  };
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
  getClosingStageLeads,
  getLeadsCreatedToday,
  getLeadsNeedingFollowUp,
  getEmailsSentToday,
  getLeadsFoundToday,
  checkDuplicate,
  checkEmailSentBefore,
  insertOutreach,
  getOutreachByLead,
  getLeadByEmail,
  isMessageProcessed,
  markMessageProcessed,
  updateOutreachResponseStatus,
  upsertNiche,
  getAllNiches,
  getStats,
  getAnalyticsSummary,
  getSetting,
  setSetting,
  getNicheData,
  // Warmup
  getWarmupDay,
  setWarmupDay,
  // Health
  getTodayHealthMetrics,
  getBounceRateMetrics,
  recordEmailSentHealth,
  recordBounce,
  recordSpamComplaint,
  recordSendError,
  saveDb,
  queryAll,
  queryOne,
  isDataCollectionOnly,
  insertQualifiedLead,
  checkDuplicateByEmail,
  checkDuplicateByPhone,
  checkDuplicateByDomain,
  createCollectionRun,
  updateRunProgress,
  getActiveRun,
  completeRun,
  pauseRun,
  recordSearchCombination,
  isSearchCombinationDone,
  getCollectionStats,
  getQualifiedLeadCount,
  getQualifiedLeadsByRun,
  getUnsyncedQualifiedLeads,
  markLeadsSynced
  ,getDataLeadFingerprints
  ,saveDataLead
  ,getDataLeads
  ,saveDataRunState
  ,getLatestDataRunState
  ,saveDiscoveryCheckpoint
  ,getDiscoveryCheckpoint
  ,markDiscoveryCombinationCompleted
  ,isDiscoveryCombinationCompleted
  ,getDataPersistenceStats
  ,markSheetSyncPending
  ,updateSheetSyncStatus
  ,getPendingSheetSync
};
