/**
 * scheduler.js — Production-Grade Autonomous Agent
 * Zynqora Edge — Safe Email Engine v2
 *
 * Features:
 *  - Progressive warmup (Day 1→20, 2→30, 3→50, 4→70, 5→100, 6→120, 7+→dynamic)
 *  - Batch sending (5–10 per batch) with 2–5 min / 5–20 min delays
 *  - Anti-ban: bounce >5% → STOP, spam complaint → reduce, error spike → pause
 *  - Duplicate prevention before every send
 *  - Randomized send order + account switching
 *  - Business-hours gate (9AM–6PM by default)
 *  - Daily counters persist in DB; midnight reset
 *  - Real-time Socket.io status broadcast
 */

const cron = require('node-cron');
const { runDiscovery, runDataDiscovery }        = require('./googleMaps');
const { scoreAllLeads }                         = require('./leadScorer');
const { analyzeNiches }                         = require('./nicheAnalyzer');
const { generateAllEmails, generateEmailForLead } = require('./emailGenerator');
const {
  getLeadsByStatus,
  getLeadsNeedingFollowUp,
  getSetting, setSetting,
  getEmailsSentToday,
  getWarmupDay,
  getTodayHealthMetrics,
  getBounceRateMetrics,
  getClosingStageLeads,
  getStats,
  isDataCollectionOnly,
  createCollectionRun,
  updateRunProgress,
  getActiveRun,
  completeRun,
  getQualifiedLeadCount,
  getUnsyncedQualifiedLeads,
  markLeadsSynced,
  getCollectionStats,
  getDataLeadFingerprints,
  saveDataLead,
  saveDataRunState,
  getDataLeads,
  saveDiscoveryCheckpoint,
  getDiscoveryCheckpoint,
  markSheetSyncPending,
  getPendingSheetSync,
  markDiscoveryCombinationCompleted,
  isDiscoveryCombinationCompleted,
  getDataPersistenceStats
} = require('../database/db');
const {
  sendBatch,
  sendEmailSafe,
  isAuthenticated,
  getWarmupTarget,
  getWarmupStatus,
  getAccountPool,
  evaluateHealth
} = require('./gmailService');
const { sendDailyReport }  = require('./reportGenerator');
const { emitStatus, emitLog, emitLeadFound, emitEmailSent, emitCollectionProgress } = require('./socketService');
const { updateLeadScoreAndStatus, batchWriteQualifiedLeads, verifyGoogleSheetsConnection, validateGoogleSheetsConfig } = require('./googleSheets');
const { processInbox } = require('./replyHandler');
const { runUsWebAiPipeline } = require('../pipelines/usWebAiPipeline');
const { runUkTaxiTowingPipeline } = require('../pipelines/ukTaxiTowingPipeline');
const { exportUsWorkbook, exportUkWorkbook, karachiDate } = require('./excelExporter');
const { fingerprints, deduplicateLeads } = require('./leadDeduplicator');
const { syncDatasetLeadBatch, getSheetFingerprints, getSheetsStatus } = require('./googleSheets');
const { discoverCandidates, enrichOfficialWebsite } = require('../freeSources/sourceRegistry');
const { enrich: enrichCompaniesHouse } = require('../freeSources/companiesHouseSource');
const { isConfigured: isGooglePlacesConfigured } = require('../freeSources/googlePlacesSource');

function configuredDataTarget(dataset) {
  const testMode = process.env.DISCOVERY_TEST_MODE === 'true';
  if (dataset === 'US') return Number(testMode ? (process.env.DISCOVERY_TEST_US_LIMIT || 10) : (process.env.US_TARGET_LEADS || 500));
  return Number(testMode ? (process.env.DISCOVERY_TEST_UK_LIMIT || 10) : (process.env.UK_TARGET_LEADS || 500));
}

// ─── Agent State ──────────────────────────────────────────────────────────────
const agentState = {
  isRunning:      false,
  emailsSentToday: 0,
  leadsFoundToday: 0,
  lastRunAt:      null,
  nextRunAt:      null,
  dailyCap:       20,           // updated on each run from warmup
  warmupDay:      1,
  status:         'idle',       // 'idle' | 'running' | 'sleeping' | 'cap_reached' | 'halted'
  mode:           'fully_automatic',
  lastLog:        '',
  haltReason:     '',
  collectionRunning: false
};

let sheetsVerified = false;
let collectionProgress = {
  status: 'idle',
  target: 500,
  qualified: 0,
  synced: 0,
  remaining: 500,
  us_count: 0,
  uk_count: 0,
  raw_found: 0,
  rejected: 0,
  duplicates: 0,
  websites_audited: 0,
  no_website_ops: 0,
  redesign_ops: 0,
  ai_ops: 0,
  current_country: '',
  current_city: '',
  current_niche: '',
  api_errors: 0,
  start_time: null,
  progress_pct: 0
};

const dataPlatformState = {
  run_id: null, status: 'idle', paused: false, today: karachiDate(), us_target: configuredDataTarget('US'),
  uk_target: configuredDataTarget('UK'), run_target: configuredDataTarget('US') + configuredDataTarget('UK'), requested_datasets: [],
  us_leads_found: 0, uk_leads_found: 0, total_collected: 0, total_qualified: 0,
  duplicates_removed: 0, needs_manual_verification: 0, current_source: '', current_city: '', current_category: '',
  candidates_found: 0, rejected: 0, current_website: '', sheets_rows_synced: 0, shortfall_reason: '', current_country: '',
  last_error: '', error_count: 0, active_dataset: '', current_business: '', candidates_processed: 0,
  rows_saved_sqlite: 0, master_rows_synced: 0, daily_rows_synced: 0, pending_sheet_rows: 0,
  processing_speed_per_min: 0, estimated_finish_time: null, last_successful_checkpoint: null, started_at: null,
  excel_export_status: 'not_started', excel_export_path: '', us_result: null, uk_result: null, sheets_sync: { US: null, UK: null },
  source_mode: isGooglePlacesConfigured() ? 'Google Maps Places (primary)' : 'Free sources only',
  google_maps_configured: isGooglePlacesConfigured(), source_event: 'idle', source_queries: 0,
  source_candidates_last_query: 0, last_successful_fetch: null, last_error_code: '', last_http_status: 0,
  source_retryable: false, google_maps_status: isGooglePlacesConfigured() ? 'untested' : 'not_configured',
  google_maps_error: '', google_maps_http_status: 0
};

function updateRuntimeMetrics(target = dataPlatformState.us_target + dataPlatformState.uk_target) {
  const elapsedMinutes = Math.max((Date.now() - new Date(dataPlatformState.started_at || Date.now()).getTime()) / 60000, 1 / 60);
  dataPlatformState.processing_speed_per_min = Number((dataPlatformState.candidates_processed / elapsedMinutes).toFixed(2));
  const remaining = Math.max(0, target - dataPlatformState.total_collected);
  dataPlatformState.estimated_finish_time = dataPlatformState.processing_speed_per_min > 0
    ? new Date(Date.now() + (remaining / dataPlatformState.processing_speed_per_min) * 60000).toISOString() : null;
}

function checkpointDataset(dataset, extra = {}) {
  const stamp = new Date().toISOString();
  dataPlatformState.last_successful_checkpoint = stamp;
  saveDiscoveryCheckpoint(dataset, { ...getDiscoveryCheckpoint(dataset), ...extra, run_id: dataPlatformState.run_id,
    status: dataPlatformState.paused ? 'paused' : (extra.status || 'running'), collection_date: karachiDate(),
    candidates_fetched: dataPlatformState.candidates_found, candidates_processed: dataPlatformState.candidates_processed,
    candidates_rejected: dataPlatformState.rejected, duplicates_removed: dataPlatformState.duplicates_removed,
    qualified_saved: dataPlatformState.total_qualified, last_error: dataPlatformState.last_error,
    last_successful_checkpoint: stamp });
}

function refreshPersistenceStats(dataset) {
  const stats = getDataPersistenceStats(dataset);
  dataPlatformState.rows_saved_sqlite = stats.sqlite_rows;
  dataPlatformState.master_rows_synced = stats.master_synced;
  dataPlatformState.daily_rows_synced = stats.daily_synced;
  dataPlatformState.pending_sheet_rows = stats.pending;
  dataPlatformState.sheets_rows_synced = stats.master_synced + stats.daily_synced;
}

function emitDataPlatformState() {
  emitCollectionProgress({ ...dataPlatformState, us_result: undefined, uk_result: undefined });
}

const splitConfig = (name, fallback) => String(process.env[name] || fallback).split(',').map(value => value.trim()).filter(Boolean);

function discoveryConfig(dataset) {
  if (dataset === 'US') return {
    country: 'United States',
    target: configuredDataTarget('US'),
    locations: splitConfig('US_TARGET_LOCATIONS', 'New York NY,Los Angeles CA,Chicago IL,Houston TX,Phoenix AZ,Philadelphia PA,Dallas TX,Miami FL,Atlanta GA,Boston MA,Seattle WA,Denver CO,Charlotte NC,Orlando FL,Tampa FL,Nashville TN,Austin TX,San Diego CA,Portland OR,Las Vegas NV'),
    categories: splitConfig('US_TARGET_NICHES', 'roofing,hvac,plumbing,electricians,landscaping,remodeling,dental clinics,medical spas,law firms,accounting firms,auto repair,cleaning companies')
  };
  return {
    country: 'United Kingdom',
    target: configuredDataTarget('UK'),
    locations: splitConfig('UK_TARGET_LOCATIONS', 'London,Birmingham,Manchester,Glasgow,Liverpool,Leeds,Bristol,Sheffield,Edinburgh,Leicester,Nottingham,Cardiff,Newcastle,Belfast,Southampton,Coventry,Bradford,Reading,Derby,Stoke-on-Trent'),
    categories: splitConfig('UK_TARGET_NICHES', 'taxi,minicab,private hire,chauffeur,airport transfer,towing,breakdown recovery,vehicle recovery,roadside assistance')
  };
}

async function persistAndSyncResult(dataset, result) {
  const syncable = result.leads;
  const batchSize = Math.max(1, Number(process.env.CHECKPOINT_BATCH_SIZE || 20));
  for (let offset = 0; offset < syncable.length; offset += batchSize) {
    const batch = syncable.slice(offset, offset + batchSize);
    const entries = [];
    for (const lead of batch) {
      const keys = fingerprints(lead, dataset);
      for (const key of keys) saveDataLead(dataset, key, lead);
      if (keys[0]) { markSheetSyncPending(dataset, keys[0]); entries.push({ fingerprint: keys[0], lead }); }
    }
    const sync = await syncDatasetLeadBatch(dataset, entries).catch(error => ({ success: false, message: error.message, master_synced: 0, daily_synced: 0 }));
    dataPlatformState.sheets_sync[dataset] = sync;
    if (!sync.success) { dataPlatformState.error_count++; dataPlatformState.last_error = sync.message || 'Google Sheets sync failed'; }
    refreshPersistenceStats(dataset);
    checkpointDataset(dataset, { event: 'persistence_batch', qualified_saved: offset + batch.length });
    emitDataPlatformState();
  }
}

async function backfillPersistedSheetRows(dataset) {
  const persisted = deduplicateLeads(getDataLeads(dataset), dataset).leads
    .filter(lead => lead.business_name && (lead.primary_source_url || lead.source_url));
  const batchSize = Math.max(1, Number(process.env.CHECKPOINT_BATCH_SIZE || 20));
  let synced = 0;
  for (let offset = 0; offset < persisted.length; offset += batchSize) {
    const entries = [];
    for (const lead of persisted.slice(offset, offset + batchSize)) {
      const key = fingerprints(lead, dataset)[0];
      if (!key) continue;
      markSheetSyncPending(dataset, key);
      entries.push({ fingerprint: key, lead });
    }
    const pendingKeys = new Set(getPendingSheetSync(dataset).map(row => row.fingerprint));
    const pendingEntries = entries.filter(entry => pendingKeys.has(entry.fingerprint));
    if (!pendingEntries.length) continue;
    const result = await syncDatasetLeadBatch(dataset, pendingEntries).catch(error => ({ success:false, message:error.message, master_synced:0, daily_synced:0 }));
    synced += Number(result.master_synced || 0);
    if (!result.success) {
      dataPlatformState.error_count++;
      dataPlatformState.last_error = result.message || result.master_error || result.daily_error || 'Persisted Sheet backfill failed';
      break;
    }
  }
  refreshPersistenceStats(dataset);
  return synced;
}

async function collectDataset(dataset, payload) {
  const config = discoveryConfig(dataset);
  await backfillPersistedSheetRows(dataset);
  const checkpoint = getDiscoveryCheckpoint(dataset);
  const today = karachiDate();
  const canResume = !!payload.resume && checkpoint && checkpoint.status !== 'completed' && checkpoint.collection_date === today;
  const resumeCheckpoint = canResume ? checkpoint : {};
  const scopeRunId = canResume && checkpoint.run_id ? checkpoint.run_id : dataPlatformState.run_id;
  const combinationScope = `${dataset}:${today}:${scopeRunId}`;
  const supplied = dataset === 'US' ? (payload.us_candidates || []) : (payload.uk_candidates || []);
  const historyDb = getDataLeadFingerprints(dataset);
  const historySheet = await getSheetFingerprints(dataset).catch(() => new Set());
  const history = new Set([...historyDb, ...historySheet]);
  const discovery = await discoverCandidates({
    dataset, locations: config.locations, categories: config.categories, seeds: supplied,
    limit: Math.max(config.target * Math.max(1, Number(process.env.CANDIDATE_POOL_MULTIPLIER || 2)), Number(process.env.MAX_CANDIDATES_PER_SOURCE_QUERY || 60)), checkpoint: resumeCheckpoint,
    shouldPause: () => dataPlatformState.paused,
    isCompleted: (source, city, category) => isDiscoveryCombinationCompleted(combinationScope, source, city, category),
    markCompleted: (source, city, category, count) => markDiscoveryCombinationCompleted(combinationScope, source, city, category, count),
    onProgress: progress => {
      const mapsProgress = progress.source === 'Google Maps Places';
      Object.assign(dataPlatformState, {
        current_country: progress.country || config.country, current_source: progress.source || '', current_city: progress.city || '',
        current_category: progress.category || '', candidates_found: progress.candidates_found ?? dataPlatformState.candidates_found,
        last_error: progress.last_error || dataPlatformState.last_error,
        last_error_code: progress.last_error_code || dataPlatformState.last_error_code,
        last_http_status: progress.last_http_status ?? dataPlatformState.last_http_status,
        source_retryable: progress.source_retryable ?? dataPlatformState.source_retryable,
        source_event: progress.event || dataPlatformState.source_event,
        source_queries: progress.queries ?? dataPlatformState.source_queries,
        source_candidates_last_query: progress.candidates_added ?? dataPlatformState.source_candidates_last_query,
        last_successful_fetch: progress.event === 'query_completed' && Number(progress.candidates_added || 0) > 0
          ? new Date().toISOString() : dataPlatformState.last_successful_fetch,
        error_count: progress.error_count ?? dataPlatformState.error_count,
        active_dataset: dataset
      });
      if (mapsProgress) {
        dataPlatformState.google_maps_status = progress.event === 'query_completed' ? 'connected'
          : ['source_blocked', 'query_blocked'].includes(progress.event) ? 'blocked'
            : progress.last_error ? 'error' : dataPlatformState.google_maps_status;
        dataPlatformState.google_maps_error = progress.last_error || dataPlatformState.google_maps_error;
        dataPlatformState.google_maps_http_status = progress.last_http_status ?? dataPlatformState.google_maps_http_status;
      }
      if (progress.checkpoint || progress.last_error) checkpointDataset(dataset, progress);
      emitDataPlatformState();
    }
  });
  const discoveredCandidates = [...discovery.candidates, ...supplied];
  const preliminary = deduplicateLeads(discoveredCandidates, dataset, history);
  const rawCandidates = preliminary.leads;
  dataPlatformState.duplicates_removed += preliminary.duplicates;
  const enriched = [];
  for (let offset = 0; offset < rawCandidates.length; offset += Number(process.env.MAX_CONCURRENCY || 2)) {
    if (dataPlatformState.paused) break;
    const batch = rawCandidates.slice(offset, offset + Number(process.env.MAX_CONCURRENCY || 2));
    const records = await Promise.all(batch.map(async candidate => {
      dataPlatformState.current_website = candidate.website || '';
      dataPlatformState.current_business = candidate.source_type === 'google_places'
        ? `Verifying ${candidate.source_listing_id || 'Google Place ID'}` : (candidate.business_name || '');
      let record = await enrichOfficialWebsite(candidate);
      if (dataset === 'UK') record = await enrichCompaniesHouse(record);
      return record;
    }));
    enriched.push(...records);
    dataPlatformState.candidates_processed += records.length;
    updateRuntimeMetrics(config.target);
    if (dataPlatformState.candidates_processed % Math.max(1, Number(process.env.CHECKPOINT_BATCH_SIZE || 20)) === 0) checkpointDataset(dataset, { event: 'candidate_batch' });
    emitDataPlatformState();
  }
  const pipeline = dataset === 'US' ? runUsWebAiPipeline : runUkTaxiTowingPipeline;
  const result = await pipeline(enriched, { target: config.target, historicalFingerprints: history });
  result.duplicates += preliminary.duplicates;
  result.shortfall_reason = [result.shortfall_reason, discovery.stopped_reason, dataPlatformState.last_error]
    .filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(' | ');
  await persistAndSyncResult(dataset, result);
  dataPlatformState.total_collected += result.collected_count ?? result.leads.length;
  dataPlatformState.total_qualified += result.qualified_count;
  dataPlatformState.rejected += result.rejected_count;
  checkpointDataset(dataset, {
    status: dataPlatformState.paused ? 'paused' : 'completed', collection_date: today, candidates_fetched: rawCandidates.length,
    candidates_processed: enriched.length, candidates_rejected: result.rejected_count, duplicates_removed: result.duplicates,
    qualified_saved: result.qualified_count, collected_saved: result.collected_count ?? result.leads.length, shortfall_reason: result.shortfall_reason, last_error: dataPlatformState.last_error
  });
  return result;
}

async function runLocalDataCollection(payload = {}) {
  if (!isDataCollectionOnly()) return { success: false, message: 'DATA_COLLECTION_ONLY=true is required.' };
  if (dataPlatformState.status === 'running') return { success: false, message: 'A local collection run is already active.' };
  const runId = `local_${Date.now()}`;
  const requested = Array.isArray(payload.datasets) && payload.datasets.length ? payload.datasets.map(value => String(value).toUpperCase()) : ['US', 'UK'];
  Object.assign(dataPlatformState, {
    run_id: runId, status: 'running', paused: false, last_error: '', shortfall_reason: '', candidates_found: 0,
    us_target: configuredDataTarget('US'), uk_target: configuredDataTarget('UK'),
    run_target: requested.reduce((sum, dataset) => sum + configuredDataTarget(dataset), 0), requested_datasets: requested,
    us_leads_found: 0, uk_leads_found: 0, us_result: null, uk_result: null,
    rejected: 0, duplicates_removed: 0, total_collected: 0, total_qualified: 0, sheets_rows_synced: 0, candidates_processed: 0, error_count: 0,
    rows_saved_sqlite: 0, master_rows_synced: 0, daily_rows_synced: 0, pending_sheet_rows: 0,
    started_at: new Date().toISOString(), current_source: isGooglePlacesConfigured() ? 'Google Maps Places' : 'automatic free-source discovery',
    source_mode: isGooglePlacesConfigured() ? 'Google Maps Places (primary)' : 'Free sources only',
    google_maps_configured: isGooglePlacesConfigured(), source_event: 'starting', source_queries: 0,
    source_candidates_last_query: 0, last_successful_fetch: null, last_error_code: '', last_http_status: 0,
    source_retryable: false, google_maps_status: isGooglePlacesConfigured() ? 'untested' : 'not_configured',
    google_maps_error: '', google_maps_http_status: 0
  });
  emitDataPlatformState();
  try {
    let us = null;
    let uk = null;
    if (requested.includes('US')) {
      us = await collectDataset('US', payload); dataPlatformState.us_result = us; dataPlatformState.us_leads_found = us.collected_count ?? us.leads.length;
    }
    if (dataPlatformState.paused) {
      dataPlatformState.status = 'paused'; saveDataRunState(runId, 'paused', getDataPlatformStatus()); emitDataPlatformState();
      return { success: true, paused: true, state: getDataPlatformStatus() };
    }
    if (requested.includes('UK')) {
      uk = await collectDataset('UK', payload); dataPlatformState.uk_result = uk; dataPlatformState.uk_leads_found = uk.collected_count ?? uk.leads.length;
    }
    const results = [us, uk].filter(Boolean);
    const qualifiedTotal = results.reduce((sum, result) => sum + result.qualified_count, 0);
    const collectedTotal = results.reduce((sum, result) => sum + (result.collected_count ?? result.leads.length), 0);
    const sourceFailure = collectedTotal === 0 && dataPlatformState.candidates_processed === 0 && dataPlatformState.error_count > 0;
    Object.assign(dataPlatformState, {
      status: dataPlatformState.paused ? 'paused' : (sourceFailure ? 'failed' : 'completed'),
      total_collected: collectedTotal,
      total_qualified: qualifiedTotal,
      duplicates_removed: results.reduce((sum, result) => sum + result.duplicates, 0),
      needs_manual_verification: results.reduce((sum, result) => sum + result.manual_count, 0),
      rejected: results.reduce((sum, result) => sum + result.rejected_count, 0),
      shortfall_reason: results.map(result => result.shortfall_reason).filter(Boolean).join(' | '),
      current_source: '', current_city: '', current_category: '', current_website: '',
      source_event: sourceFailure ? 'blocked' : 'completed'
    });
    saveDataRunState(runId, dataPlatformState.status, getDataPlatformStatus());
    emitDataPlatformState();
    return { success: true, state: getDataPlatformStatus(), us, uk };
  } catch (error) {
    Object.assign(dataPlatformState, { status: 'failed', last_error: error.message });
    saveDataRunState(runId, 'failed', getDataPlatformStatus()); emitDataPlatformState();
    return { success: false, message: error.message };
  }
}

function pauseLocalCollection() {
  dataPlatformState.paused = true;
  if (dataPlatformState.status === 'running') dataPlatformState.status = 'pausing';
  if (dataPlatformState.active_dataset) checkpointDataset(dataPlatformState.active_dataset, { status: 'paused', event: 'pause_requested' });
  emitDataPlatformState();
  return getDataPlatformStatus();
}

function startLocalDataCollection(payload = {}) {
  if (dataPlatformState.status === 'running') return { success: false, message: 'A local collection run is already active.', state: getDataPlatformStatus() };
  runLocalDataCollection(payload).catch(error => {
    dataPlatformState.status = 'failed'; dataPlatformState.last_error = error.message; emitDataPlatformState();
  });
  return { success: true, started: true, state: getDataPlatformStatus() };
}

function resumeLocalCollection(payload = {}) {
  dataPlatformState.paused = false;
  return startLocalDataCollection({ ...payload, resume: true });
}

async function exportDataWorkbook(dataset) {
  let result = dataset === 'UK' ? dataPlatformState.uk_result : dataPlatformState.us_result;
  if (!result) {
    const persisted = deduplicateLeads(getDataLeads(dataset), dataset).leads;
    if (!persisted.length) return { success: false, message: `No persisted ${dataset} leads are available.` };
    const qualified = persisted.filter(lead => lead.verification_status === 'verified');
    result = {
      dataset, target: discoveryConfig(dataset).target, leads: persisted, qualified_count: qualified.length,
      manual_count: persisted.length - qualified.length, duplicates: 0, rejected_count: 0,
      shortfall_reason: qualified.length < discoveryConfig(dataset).target ? 'Exported persisted leads; daily target was not reached.' : ''
    };
  }
  dataPlatformState.excel_export_status = 'running'; emitDataPlatformState();
  try {
    const exported = dataset === 'UK' ? await exportUkWorkbook(result) : await exportUsWorkbook(result);
    dataPlatformState.excel_export_status = 'completed'; dataPlatformState.excel_export_path = exported.path || ''; emitDataPlatformState();
    return { success: true, ...exported };
  } catch (error) {
    dataPlatformState.excel_export_status = 'failed'; dataPlatformState.last_error = error.message; emitDataPlatformState();
    return { success: false, message: error.message };
  }
}

function getDataPlatformStatus() {
  const { us_result, uk_result, ...safe } = dataPlatformState;
  return { ...safe, us_remaining: Math.max(0, safe.us_target - safe.us_leads_found), uk_remaining: Math.max(0, safe.uk_target - safe.uk_leads_found) };
}

// ─── Constants ────────────────────────────────────────────────────────────────
const BUSINESS_HOUR_START = parseInt(process.env.BUSINESS_HOUR_START || '9');
const BUSINESS_HOUR_END   = parseInt(process.env.BUSINESS_HOUR_END   || '18');
const INTERVAL_MINUTES    = parseInt(process.env.AGENT_RUN_INTERVAL_MINUTES || '12');

// Gmail account type — drive limits (overridable via env)
const EMAIL_ACCOUNT_TYPE  = process.env.EMAIL_ACCOUNT_TYPE || 'gmail'; // 'gmail' | 'business'

// ─── Daily Cap (Warmup-Aware) ─────────────────────────────────────────────────
function getDailyCap() {
  const day  = getWarmupDay();
  agentState.warmupDay = day;
  return getWarmupTarget(day, EMAIL_ACCOUNT_TYPE);
}

// ─── Business Hours ───────────────────────────────────────────────────────────
function isBusinessHours() {
  const hour = new Date().getHours();
  return hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END;
}

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(message, level = 'info') {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${message}`);
  agentState.lastLog = message;
  emitLog(message, level);
}

// ─── Status Broadcast ─────────────────────────────────────────────────────────
function broadcastStatus() {
  if (isDataCollectionOnly()) {
    emitStatus(getAgentStatus());
    return;
  }

  const health = getTodayHealthMetrics();
  emitStatus({
    status:              agentState.status,
    mode:                agentState.mode,
    emails_sent_today:   agentState.emailsSentToday,
    leads_found_today:   agentState.leadsFoundToday,
    daily_cap:           agentState.dailyCap,
    warmup_day:          agentState.warmupDay,
    daily_target_range:  EMAIL_ACCOUNT_TYPE === 'business' ? '150-250' : '100-150',
    last_run_at:         agentState.lastRunAt,
    next_run_at:         agentState.nextRunAt,
    is_business_hours:   isBusinessHours(),
    last_log:            agentState.lastLog,
    halt_reason:         agentState.haltReason,
    health: {
      bounces:         health.bounces          || 0,
      spam_complaints: health.spam_complaints   || 0,
      errors:          health.errors            || 0,
      bounce_rate:     health.emails_sent
        ? ((health.bounces || 0) / health.emails_sent)
        : 0
    },
    dashboard_name: 'Zynqora Edge'
  });
}

// ─── Data Collection Pipeline ─────────────────────────────────────────────────
async function verifySheetsForCollection() {
  const cfg = validateGoogleSheetsConfig();
  if (cfg.status !== 'ok') {
    log(`[Sheets] Configuration required: ${cfg.missing.join(', ')}`, 'warning');
    return false;
  }
  const result = await verifyGoogleSheetsConnection();
  if (!result.connected || !result.write_access) {
    log(`[Sheets] Connection failed: ${result.error || 'unknown'}`, 'error');
    return false;
  }
  sheetsVerified = true;
  log(`[Sheets] Connected to "${result.spreadsheet_title}" with write access.`, 'success');
  return true;
}

async function runDataCollectionPipeline(resume = false) {
  if (agentState.collectionRunning) {
    return { success: false, message: 'Collection already running' };
  }

  if (!sheetsVerified) {
    const ok = await verifySheetsForCollection();
    if (!ok) return { success: false, message: 'Google Sheets not configured or accessible' };
  }

  let run = resume ? getActiveRun() : null;
  let runId;
  const target = parseInt(process.env.QUALIFIED_LEAD_TARGET_PER_DAY || '500', 10);

  if (run && run.status === 'paused') {
    runId = run.run_id;
    updateRunProgress(runId, { status: 'running' });
    log(`▶️ Resuming collection run ${runId}`, 'info');
  } else if (run && run.status === 'running') {
    return { success: false, message: 'Active run already in progress' };
  } else {
    runId = createCollectionRun(target);
    log(`🆕 Started collection run ${runId} (target: ${target})`, 'info');
  }

  agentState.collectionRunning = true;
  agentState.isRunning = true;
  agentState.status = 'running';
  agentState.mode = 'data_collection';
  collectionProgress.status = 'running';
  collectionProgress.target = target;
  collectionProgress.start_time = new Date().toISOString();
  broadcastStatus();

  try {
    const counters = await runDataDiscovery({
      runId,
      target,
      onProgress: (data) => {
        collectionProgress = {
          ...collectionProgress,
          ...data,
          qualified: data.qualified || 0,
          synced: collectionProgress.synced,
          rejected: (data.rejected_quality || 0) + (data.rejected_score || 0),
          websites_audited: data.audited || 0
        };
        emitCollectionProgress(collectionProgress);
        updateRunProgress(runId, {
          qualified_count: data.qualified,
          us_count: data.us_count,
          uk_count: data.uk_count
        });
      }
    });

    if (counters.api_errors > 0 && counters.qualified < target) {
      updateRunProgress(runId, { status: 'paused', qualified_count: counters.qualified });
      collectionProgress.status = 'paused';
      agentState.status = 'idle';
      emitCollectionProgress(collectionProgress);
      return { success: false, message: 'Paused due to API errors', counters };
    }

    const unsynced = getUnsyncedQualifiedLeads(runId, 500);
    if (unsynced.length > 0) {
      const syncResult = await batchWriteQualifiedLeads(unsynced);
      if (syncResult.success) {
        markLeadsSynced(unsynced.map(l => l.id));
        counters.synced = syncResult.synced || 0;
        updateRunProgress(runId, { synced_count: counters.synced });
      }
    }

    completeRun(runId);
    collectionProgress = {
      ...collectionProgress,
      ...counters,
      qualified: counters.qualified,
      synced: counters.synced,
      status: 'completed',
      remaining: Math.max(0, target - counters.qualified),
      progress_pct: Math.round((counters.qualified / target) * 100)
    };

    log(`✅ Collection complete: ${counters.qualified} qualified, ${counters.synced} synced to Sheets`, 'success');
    emitCollectionProgress(collectionProgress);
    agentState.status = 'idle';
    broadcastStatus();
    return { success: true, counters };
  } catch (error) {
    log(`❌ Collection error: ${error.message}`, 'error');
    if (runId) updateRunProgress(runId, { status: 'paused' });
    collectionProgress.status = 'paused';
    emitCollectionProgress(collectionProgress);
    return { success: false, message: error.message };
  } finally {
    agentState.collectionRunning = false;
    agentState.isRunning = false;
  }
}

function getCollectionStatus() {
  const active = getActiveRun();
  const target = parseInt(process.env.QUALIFIED_LEAD_TARGET_PER_DAY || '500', 10);
  return {
    data_collection_only: true,
    ...collectionProgress,
    target,
    active_run: active,
    qualified: active?.qualified_count ?? collectionProgress.qualified,
    synced: active?.synced_count ?? collectionProgress.synced,
    us_count: active?.us_count ?? collectionProgress.us_count,
    uk_count: active?.uk_count ?? collectionProgress.uk_count,
    sheets_verified: sheetsVerified
  };
}

// ─── Get Agent Status (API) ───────────────────────────────────────────────────
function getAgentStatus() {
  if (isDataCollectionOnly()) {
    const stats = getCollectionStats();
    return {
      status: collectionProgress.status || agentState.status,
      mode: 'data_collection',
      data_collection_only: true,
      collection: getCollectionStatus(),
      qualified_today: collectionProgress.qualified,
      synced_today: collectionProgress.synced,
      target_per_day: parseInt(process.env.QUALIFIED_LEAD_TARGET_PER_DAY || '500', 10),
      us_count: collectionProgress.us_count,
      uk_count: collectionProgress.uk_count,
      last_run_at: agentState.lastRunAt,
      last_log: agentState.lastLog,
      dashboard_name: 'Zynqora Edge — Data Collection',
      sheets_verified: sheetsVerified,
      realtime_updates: true
    };
  }

  const cap    = getDailyCap();
  const health = getTodayHealthMetrics();
  agentState.dailyCap = cap;

  return {
    status:              agentState.status,
    mode:                agentState.mode,
    emails_sent_today:   agentState.emailsSentToday,
    leads_found_today:   agentState.leadsFoundToday,
    daily_cap:           cap,
    warmup_day:          agentState.warmupDay,
    daily_target_range:  EMAIL_ACCOUNT_TYPE === 'business' ? '150-250' : '100-150',
    email_account_type:  EMAIL_ACCOUNT_TYPE,
    last_run_at:         agentState.lastRunAt,
    next_run_at:         agentState.nextRunAt,
    is_business_hours:   isBusinessHours(),
    last_log:            agentState.lastLog,
    halt_reason:         agentState.haltReason,
    health: {
      emails_sent:     health.emails_sent      || 0,
      bounces:         health.bounces          || 0,
      spam_complaints: health.spam_complaints   || 0,
      errors:          health.errors            || 0,
      bounce_rate:     health.emails_sent
        ? ((health.bounces || 0) / health.emails_sent)
        : 0
    },
    dashboard_name:   'Zynqora Edge',
    agent_mode:       'fully_automatic',
    email_strategy:   'batched_warmup_anti_ban',
    realtime_updates: true
  };
}

// ─── Anti-Ban System-Level Check ─────────────────────────────────────────────
/**
 * Called before running outreach. Checks system-wide health.
 * Returns true if safe to proceed.
 */
function systemHealthCheck() {
  if (agentState.status === 'halted') {
    log(`🚨 Agent is HALTED: ${agentState.haltReason}. Manual restart required.`, 'error');
    return false;
  }

  const health = evaluateHealth(null); // aggregate
  if (!health.safe) {
    if (health.action === 'stop' || health.action === 'pause') {
      agentState.status     = 'halted';
      agentState.haltReason = health.reason;
      log(`🚨 SYSTEM HALT — ${health.reason}`, 'error');
      broadcastStatus();
      return false;
    }
  }
  return true;
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────
async function runFullPipeline() {
  if (isDataCollectionOnly()) {
    return runLocalDataCollection({ us_candidates: [], uk_candidates: [] });
  }

  if (agentState.isRunning) {
    log('⚠️  Pipeline already running. Skipping.', 'warning');
    return { success: false, message: 'Pipeline already running' };
  }

  // Refresh daily cap from warmup schedule
  const cap = getDailyCap();
  agentState.dailyCap = cap;

  if (agentState.emailsSentToday >= cap) {
    agentState.status = 'cap_reached';
    log(`🛑 Daily cap reached (${agentState.emailsSentToday}/${cap}). Skipping outreach.`, 'warning');
    broadcastStatus();
    return { success: false, message: 'Daily cap reached' };
  }

  if (!systemHealthCheck()) {
    return { success: false, message: agentState.haltReason || 'System halted' };
  }

  agentState.isRunning = true;
  agentState.status    = 'running';
  agentState.lastRunAt = new Date().toISOString();
  broadcastStatus();

  const results = { discovered: 0, scored: 0, emailsGenerated: 0, emailsSent: 0 };

  try {
    log('\n' + '═'.repeat(50), 'info');
    log(`🚀 ZYNQORA EDGE — PIPELINE (Warmup Day ${agentState.warmupDay} | Cap: ${cap})`, 'info');
    log('═'.repeat(50), 'info');

    // Step 0: Handle Inbox (run before anything else to halt follow-ups if they replied)
    log('── Step 0: Reply Detection & Hot Leads ──', 'info');
    if (isAuthenticated()) {
      await processInbox();
      
      const hotLeads = getClosingStageLeads();
      if (hotLeads.length > 0) {
        log(`🔥 HOT LEAD PRIORITY: ${hotLeads.length} leads in closing stage!`, 'success');
        hotLeads.forEach((l, idx) => {
          log(`   [${idx+1}] ${l.business_name} (${l.email}) — Action Required`, 'warning');
        });
      }
    } else {
      log('⚠️  Gmail not connected. Skipping reply detection.', 'warning');
    }

    // ── Phase 5: Smart Scaling Safety ──
    const pool = getAccountPool();
    let dynamicHardCap = 0;
    
    if (pool.length > 0) {
      // Calculate absolute system ceiling based on connected account types
      dynamicHardCap = pool.reduce((sum, acc) => sum + (acc.type === 'gmail' ? 150 : 250), 0);
      if (cap > dynamicHardCap) {
        log(`⚖️  Scaling Safety: Warmup target (${cap}) exceeds available hard limits. Capping to ${dynamicHardCap}.`, 'warning');
        cap = dynamicHardCap; // Prevent exponential runaway
      }
    }

    // Step 1: Discover (CONTROLLED — pass remaining quota so we only fetch what's needed)
    log('── Step 1/5: Lead Discovery ──', 'info');
    const remaining_before_discovery = cap - agentState.emailsSentToday;
    // Fetch with a small buffer (1.3×) to compensate for quality filtering rejections
    const discoveryQuota = Math.ceil(remaining_before_discovery * 1.3);
    results.discovered = await runDiscovery(discoveryQuota);
    agentState.leadsFoundToday += results.discovered;
    log(`✅ Discovery complete: ${results.discovered} valid leads saved.`, 'success');
    broadcastStatus();

    // Step 2: Score
    log('── Step 2/5: AI Scoring ──', 'info');
    results.scored = await scoreAllLeads();
    log(`✅ Scored ${results.scored} leads.`, 'success');
    broadcastStatus();

    // Step 3: Niche Analysis
    log('── Step 3/5: Niche Analysis ──', 'info');
    await analyzeNiches();
    log('✅ Niche analysis complete.', 'success');

    // Step 4: Email Generation
    log('── Step 4/5: Email Generation ──', 'info');
    results.emailsGenerated = await generateAllEmails();
    log(`✅ Generated ${results.emailsGenerated} email drafts.`, 'success');
    broadcastStatus();

    // Step 5: Batch Outreach
    log('── Step 5/5: Batched Email Outreach ──', 'info');
    if (isAuthenticated()) {
      const readyLeads = getLeadsByStatus('email_ready');
      const remaining  = cap - agentState.emailsSentToday;

      if (remaining <= 0) {
        log(`🛑 No remaining capacity (${agentState.emailsSentToday}/${cap}).`, 'warning');
      } else {
        const toSend = readyLeads.slice(0, remaining);
        log(`📊 ${readyLeads.length} leads ready | Sending up to ${toSend.length} | Warmup Day ${agentState.warmupDay} | Cap: ${cap}`, 'info');

        const sent = await sendBatch(
          toSend,
          agentState.emailsSentToday,
          cap,
          0, // first touch
          (lead, newCount) => {
            results.emailsSent++;
            agentState.emailsSentToday = newCount; // kept live by callback
            emitEmailSent(lead, newCount, cap);
            log(`📤 Sent to ${lead.business_name} (${lead.email}) [${newCount}/${cap}]`, 'success');
            broadcastStatus();

            // RULE 8: Update Google Sheets with score and final status
            updateLeadScoreAndStatus(lead.email, lead.score || 0, 'sent')
              .catch(e => log(`⚠️  Sheet update failed for ${lead.email}: ${e.message}`, 'warning'));

            // Re-run health check after each send — HALT fast if needed
            if (!systemHealthCheck()) {
              log('🚨 Anti-ban halt mid-batch. Outreach stopped.', 'error');
            }
          }
        );

        results.emailsSent = sent;
        // Sync from DB as authoritative source (onSent callback advanced the counter live)
        agentState.emailsSentToday = getEmailsSentToday();
      }
    } else {
      log('❌ Gmail not authenticated. Connect Gmail from dashboard.', 'error');
    }

    log('═'.repeat(50), 'info');
    log(`✅ PIPELINE COMPLETE`, 'success');
    log(`   🔍 Leads discovered:    ${results.discovered}`, 'info');
    log(`   📧 Emails generated:   ${results.emailsGenerated}`, 'info');
    log(`   📤 Emails sent:        ${results.emailsSent}`, 'success');
    log(`   📊 Daily progress:     ${agentState.emailsSentToday}/${cap}`, 'info');
    log('═'.repeat(50), 'info');

    agentState.status = agentState.emailsSentToday >= cap ? 'cap_reached' : 'idle';
    broadcastStatus();
    return { success: true, results };

  } catch (error) {
    log(`❌ Pipeline error: ${error.message}`, 'error');
    agentState.status = 'idle';
    broadcastStatus();
    return { success: false, message: error.message };
  } finally {
    agentState.isRunning = false;
  }
}

// ─── Follow-Ups ────────────────────────────────────────────────────────────────
async function runFollowUps() {
  if (isDataCollectionOnly()) {
    log('📭 Data collection mode — follow-ups disabled.', 'info');
    return 0;
  }

  if (!isAuthenticated()) {
    log('⚠️  Gmail not connected. Cannot send follow-ups.', 'warning');
    return 0;
  }

  if (!systemHealthCheck()) return 0;

  const cap   = getDailyCap();
  const leads = getLeadsNeedingFollowUp();

  if (leads.length === 0) {
    log('✅ No leads need follow-up right now.', 'info');
    return 0;
  }

  const remaining = cap - agentState.emailsSentToday;
  if (remaining <= 0) {
    log('🛑 Daily cap reached — skipping follow-ups.', 'warning');
    return 0;
  }

  log(`\n📩 Follow-ups: ${leads.length} leads eligible | Remaining cap: ${remaining}`, 'info');

  // Phase 3: Use pre-generated follow_up from whatsapp_draft if available.
  // It was stored at email-generation time (2–3 days ago) — dispatch it now.
  // Only fall back to live AI generation if the stored draft is missing.
  const prepared = [];
  for (const lead of leads.slice(0, remaining)) {
    try {
      let emailData;

      const storedFollowUp = lead.whatsapp_draft ? (() => {
        try { return JSON.parse(lead.whatsapp_draft); } catch { return null; }
      })() : null;

      if (storedFollowUp && storedFollowUp.subject && storedFollowUp.body) {
        // Use pre-generated follow-up (Phase 3 primary path)
        emailData = { subject: storedFollowUp.subject, body: storedFollowUp.body };
        log(`📩 Using stored follow-up for ${lead.business_name}`, 'info');
      } else {
        // Fallback: generate fresh follow-up if stored draft is missing
        emailData = await generateEmailForLead(lead, true);
        log(`📩 Generated live follow-up for ${lead.business_name}`, 'info');
      }

      prepared.push({ ...lead, email_draft: JSON.stringify(emailData) });
    } catch (e) {
      log(`⚠️  Could not prepare follow-up for ${lead.business_name}: ${e.message}`, 'warning');
    }
  }

  const sent = await sendBatch(
    prepared,
    agentState.emailsSentToday,
    cap,
    1, // follow-up number
    (lead, newCount) => {
      agentState.emailsSentToday = newCount; // kept live by callback
      broadcastStatus();
    }
  );

  // RULE 7: Sync from DB — do NOT += sent (already advanced by onSent callback)
  agentState.emailsSentToday = getEmailsSentToday();
  log(`✅ Sent ${sent} follow-up emails.`, 'success');
  return sent;
}

// ─── Midnight Reset ───────────────────────────────────────────────────────────
function scheduleMidnightReset() {
  cron.schedule('0 0 * * *', () => {
    agentState.emailsSentToday = 0;
    agentState.leadsFoundToday = 0;
    agentState.haltReason      = '';

    // Only clear 'halted' on midnight if the user wants auto-recovery.
    // Keep 'cap_reached' clear; set to idle.
    if (agentState.status !== 'halted') {
      agentState.status = 'idle';
    }

    const cap = getDailyCap();
    agentState.dailyCap = cap;

    log(`🌅 Midnight reset: counters cleared. Warmup Day ${agentState.warmupDay} → Target: ${cap} emails.`, 'info');
    broadcastStatus();
  });
}

// ─── Manual Resume (after halt) ───────────────────────────────────────────────
function resumeAgent() {
  if (agentState.status === 'halted') {
    agentState.status     = 'idle';
    agentState.haltReason = '';
    log('🔓 Agent manually resumed.', 'info');
    broadcastStatus();
    return true;
  }
  return false;
}

// ─── Main Scheduler ────────────────────────────────────────────────────────────
function startScheduler() {
  if (isDataCollectionOnly()) {
    log('📊 Zynqora Edge Data Collection mode starting...', 'info');
    agentState.mode = 'data_collection';

    verifySheetsForCollection().then(ok => {
      if (ok) {
        const { initDataModeHeaders } = require('./googleSheets');
        initDataModeHeaders().catch(e => log(`[Sheets] Header init: ${e.message}`, 'warning'));
      }
    });

    setInterval(() => {
      if (agentState.status !== 'running') broadcastStatus();
    }, 5000);

    if (process.env.DATA_COLLECTION_SCHEDULE_ENABLED === 'true') {
      const cronExpr = process.env.DATA_COLLECTION_CRON || '0 9 * * *';
      const tz = process.env.DATA_COLLECTION_TIMEZONE || 'Asia/Karachi';
      cron.schedule(cronExpr, async () => {
        if (!sheetsVerified) {
          const ok = await verifySheetsForCollection();
          if (!ok) {
            log('⏸️ Scheduled collection skipped — Sheets not ready.', 'warning');
            return;
          }
        }
        if (agentState.collectionRunning) {
          log('⏸️ Scheduled collection skipped — run already active.', 'warning');
          return;
        }
        log(`⏰ Scheduled data collection triggered (${tz})`, 'info');
        await runLocalDataCollection({ us_candidates: [], uk_candidates: [] });
      }, { timezone: tz });
      log(`📅 Data collection schedule: ${cronExpr} (${tz})`, 'info');
    } else {
      log('📅 Auto-schedule disabled — use POST /api/collection/start to trigger.', 'info');
    }

    broadcastStatus();
    log('✅ Data collection scheduler active.', 'success');
    return;
  }

  log('🤖 Zynqora Edge Safe Engine v2 starting...', 'info');

  // Sync email count from DB in case of restart
  agentState.emailsSentToday = getEmailsSentToday();

  const cap = getDailyCap();
  agentState.dailyCap = cap;

  log(`📅 Schedule: every ${INTERVAL_MINUTES} min | Business hours: ${BUSINESS_HOUR_START}:00–${BUSINESS_HOUR_END}:00`, 'info');
  log(`📈 Warmup Day ${agentState.warmupDay} | Today's target: ${cap} emails (${EMAIL_ACCOUNT_TYPE})`, 'info');

  // Status broadcast every 5 seconds
  setInterval(() => {
    if (agentState.status !== 'running') broadcastStatus();
  }, 5000);

  // Main cron
  const cronExpr = `*/${INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpr, async () => {
    if (!isBusinessHours()) {
      agentState.status = 'sleeping';
      const h = new Date().getHours();
      log(`😴 Outside business hours (${h}:00). Agent sleeping.`, 'info');
      broadcastStatus();
      return;
    }

    if (agentState.status === 'halted') {
      log(`🚨 Agent is HALTED: ${agentState.haltReason}. Skipping run.`, 'error');
      broadcastStatus();
      return;
    }

    if (agentState.emailsSentToday >= agentState.dailyCap) {
      agentState.status = 'cap_reached';
      log(`🛑 Daily cap reached (${agentState.emailsSentToday}/${agentState.dailyCap}). Resting until midnight.`, 'warning');
      broadcastStatus();
      return;
    }

    const next = new Date(Date.now() + INTERVAL_MINUTES * 60 * 1000);
    agentState.nextRunAt = next.toISOString();

    log(`\n⏰ Pipeline triggered at ${new Date().toLocaleTimeString()}`, 'info');
    await runFullPipeline();
  });

  // Follow-ups: 2PM daily
  cron.schedule('0 14 * * *', async () => {
    if (!isBusinessHours()) return;
    log('\n⏰ Scheduled follow-ups starting...', 'info');
    await runFollowUps();
  });

  // Daily report: 5PM
  cron.schedule('0 17 * * *', async () => {
    log('\n📊 Sending daily activity report...', 'info');
    try { await sendDailyReport(); }
    catch (e) { log(`⚠️  Daily report failed: ${e.message}`, 'warning'); }
  });

  // Midnight reset
  scheduleMidnightReset();

  log(`✅ Safe scheduler active. Next run in ~${INTERVAL_MINUTES} min (if business hours).`, 'success');
  broadcastStatus();
}

module.exports = {
  runFullPipeline,
  runFollowUps,
  startScheduler,
  getAgentStatus,
  resumeAgent,
  runDataCollectionPipeline,
  getCollectionStatus,
  verifySheetsForCollection,
  agentState,
  collectionProgress
  ,runLocalDataCollection
  ,startLocalDataCollection
  ,pauseLocalCollection
  ,resumeLocalCollection
  ,exportDataWorkbook
  ,getDataPlatformStatus
};
