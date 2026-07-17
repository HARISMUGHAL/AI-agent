/**
 * api.js — REST API Routes
 * Zynqora Edge Autonomous Agent
 */

const express = require('express');
const router  = express.Router();

const {
  getStats, getAllLeads, getLeadById, getLeadsByNiche,
  getAllNiches, updateLeadStatus, updateLeadEmailAddress,
  getOutreachByLead, getLeadsByStatus, getAnalyticsSummary,
  isDataCollectionOnly, getCollectionStats
} = require('../database/db');
const { getAccountTelemetry } = require('../services/accountManager');
const { runDiscovery, searchBusinesses } = require('../services/googleMaps');
const { scoreAllLeads, scoreLead }       = require('../services/leadScorer');
const { analyzeNiches }                  = require('../services/nicheAnalyzer');
const { generateEmailForLead, generateAllEmails } = require('../services/emailGenerator');
const { sendEmailToLead, isAuthenticated, getAuthUrl, getAccountPool } = require('../services/gmailService');
const {
  runFullPipeline, runFollowUps, getAgentStatus,
  runDataCollectionPipeline, getCollectionStatus,
  runLocalDataCollection, startLocalDataCollection, pauseLocalCollection, resumeLocalCollection,
  exportDataWorkbook, getDataPlatformStatus
} = require('../services/scheduler');
const { getSheetsStatus, verifyGoogleSheetsConnection, initializeWorksheets } = require('../services/googleSheets');
const { isConfigured: isGooglePlacesConfigured, searchText: testGooglePlaces } = require('../freeSources/googlePlacesSource');

const DATA_MODE_MSG = 'Data collection mode active. Email operations disabled.';

function guardEmailOps(req, res, next) {
  if (isDataCollectionOnly()) {
    return res.status(403).json({ error: DATA_MODE_MSG });
  }
  next();
}

// ─── Collection (Data Mode) ──────────────────────────────────────────────────
router.get('/collection/status', (req, res) => {
  try {
    res.json(getCollectionStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/collection/start', async (req, res) => {
  try {
    if (!isDataCollectionOnly()) {
      return res.status(400).json({ error: 'Not in data collection mode.' });
    }
    const result = startLocalDataCollection(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/collection/resume', async (req, res) => {
  try {
    if (!isDataCollectionOnly()) {
      return res.status(400).json({ error: 'Not in data collection mode.' });
    }
    const result = await resumeLocalCollection(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/collection/start/:dataset', (req, res) => {
  if (!isDataCollectionOnly()) return res.status(400).json({ error: 'Not in data collection mode.' });
  const dataset = String(req.params.dataset || '').toUpperCase();
  if (!['US', 'UK'].includes(dataset)) return res.status(400).json({ error: 'Dataset must be US or UK.' });
  res.json(startLocalDataCollection({ ...(req.body || {}), datasets: [dataset] }));
});

router.post('/collection/pause', (req, res) => {
  if (!isDataCollectionOnly()) return res.status(400).json({ error: 'Not in data collection mode.' });
  res.json({ success: true, state: pauseLocalCollection() });
});

router.get('/collection/local-status', (req, res) => res.json(getDataPlatformStatus()));

router.post('/maps/test', async (req, res) => {
  if (!isGooglePlacesConfigured()) return res.status(400).json({ configured: false, connected: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
  try {
    const result = await testGooglePlaces({ country: 'United States', location: 'New York NY', category: 'plumbing', limit: 1 });
    res.json({ configured: true, connected: true, http_status: result.status, places_returned: (result.data.places || []).length, attempts: result.attempts });
  } catch (error) {
    res.status(400).json({ configured: true, connected: false, error: error.message, code: error.code || '', http_status: error.httpStatus || 0, retryable: !!error.retryable });
  }
});

router.get('/collection/export/status', (req, res) => {
  const state = getDataPlatformStatus();
  res.json({ status: state.excel_export_status, path: state.excel_export_path || '', last_error: state.last_error || '' });
});

router.post('/collection/export/:dataset', async (req, res) => {
  const dataset = String(req.params.dataset || '').toUpperCase();
  if (!['US', 'UK'].includes(dataset)) return res.status(400).json({ error: 'Dataset must be US or UK.' });
  const result = await exportDataWorkbook(dataset);
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/sheets/status', async (req, res) => {
  try {
    const status = await getSheetsStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sheets/test', async (req, res) => {
  try {
    const connection = await verifyGoogleSheetsConnection();
    if (!connection.connected || !connection.write_access) return res.status(400).json(connection);
    const worksheets = await initializeWorksheets();
    res.json({ configured: true, connected: true, write_access: true, worksheets });
  } catch (error) {
    res.status(500).json({ configured: true, connected: false, write_access: false, error: error.message });
  }
});

// ─── Agent Status (Real-Time) ────────────────────────────────────────────────
router.get('/agent/status', (req, res) => {
  try {
    res.json(getAgentStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Agent Daily Stats ───────────────────────────────────────────────────────
router.get('/agent/daily-stats', (req, res) => {
  try {
    const status = getAgentStatus();
    const dbStats = getStats();
    if (isDataCollectionOnly()) {
      return res.json({
        data_collection_only: true,
        qualified_today: status.qualified_today || 0,
        synced_today: status.synced_today || 0,
        target_per_day: status.target_per_day || 500,
        us_count: status.us_count || 0,
        uk_count: status.uk_count || 0,
        agent_status: status.status,
        total_leads: dbStats.totalLeads,
        dashboard_name: 'Zynqora Edge — Data Collection'
      });
    }
    res.json({
      emails_sent_today: status.emails_sent_today,
      leads_found_today: status.leads_found_today,
      daily_cap:         status.daily_cap,
      daily_target:      status.daily_target,
      total_leads:       dbStats.totalLeads,
      contacted:         dbStats.contacted,
      responded:         dbStats.responded,
      is_business_hours: status.is_business_hours,
      agent_status:      status.status,
      dashboard_name:    'Zynqora Edge'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Dashboard Stats ─────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const stats = getStats();
    const sheetsStatus = await getSheetsStatus();

    if (isDataCollectionOnly()) {
      const collection = getCollectionStats();
      const agentStatus = getAgentStatus();
      return res.json({
        ...stats,
        data_collection_only: true,
        gmailConnected: false,
        gmailRequired: false,
        sheetsStatus,
        collectionStats: collection,
        agentStatus,
        apiKeysConfigured: {
          googleMaps: !!process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY !== 'your_google_maps_api_key_here',
          googleSheets: sheetsStatus.configured,
          gemini: false
        }
      });
    }

    stats.gmailConnected = isAuthenticated();
    stats.apiKeysConfigured = {
      googleMaps: !!process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY !== 'your_google_maps_api_key_here',
      gemini:     !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here',
      gmail:      !!process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_ID !== 'your_gmail_client_id_here',
      googleSheets: sheetsStatus.configured
    };
    stats.sheetsStatus = sheetsStatus;
    stats.agentStatus = getAgentStatus();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard/summary', (req, res) => {
  try {
    if (isDataCollectionOnly()) {
      return res.json(getCollectionStatus());
    }
    const summary = getAnalyticsSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard/accounts', (req, res) => {
  try {
    if (isDataCollectionOnly()) {
      return res.json({ accounts: [], message: 'Email accounts not used in data collection mode.' });
    }
    const pool = getAccountPool();
    const accounts = getAccountTelemetry(pool);
    res.json({ accounts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Leads ───────────────────────────────────────────────────────────────────
router.get('/leads', (req, res) => {
  try {
    const { niche, status } = req.query;
    let leads;
    if (niche)  leads = getLeadsByNiche(niche);
    else if (status) leads = getLeadsByStatus(status);
    else leads = getAllLeads();
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads/:id', (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const outreach = getOutreachByLead(lead.id);
    res.json({ ...lead, outreach });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/leads/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, email } = req.body;
    if (status) updateLeadStatus(id, status);
    if (email)  updateLeadEmailAddress(id, email);
    const lead = getLeadById(id);
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/discover', async (req, res) => {
  try {
    if (isDataCollectionOnly()) return res.status(403).json({ error: 'Paid Maps discovery is disabled. Use /api/collection/start with public source candidates.' });
    const { niche, location } = req.body;
    let count;
    if (niche && location) {
      const result = await searchBusinesses(niche, niche, location);
      count = result.places ? result.places.length : 0;
    } else {
      count = await runDiscovery();
    }
    res.json({ success: true, leadsFound: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/score', async (req, res) => {
  try {
    const scored = await scoreAllLeads();
    res.json({ success: true, leadsScored: scored });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/:id/score', async (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const result = await scoreLead(lead);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/:id/generate-email', guardEmailOps, async (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const email = await generateEmailForLead(lead, req.body.followUp || false);
    res.json({ success: true, email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/generate-emails', guardEmailOps, async (req, res) => {
  try {
    const count = await generateAllEmails();
    res.json({ success: true, emailsGenerated: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/:id/send-email', guardEmailOps, async (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let emailData = req.body.email;
    if (!emailData && lead.email_draft) emailData = JSON.parse(lead.email_draft);
    if (!emailData) emailData = await generateEmailForLead(lead);
    const success = await sendEmailToLead(lead, emailData);
    res.json({ success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/niches', (req, res) => {
  try { res.json(getAllNiches()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/niches/analyze', async (req, res) => {
  try {
    if (isDataCollectionOnly()) return res.status(403).json({ error: 'Legacy paid-AI niche analysis is disabled in data collection mode.' });
    const niches = await analyzeNiches();
    res.json({ success: true, niches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/pipeline/run', async (req, res) => {
  try {
    const msg = isDataCollectionOnly()
      ? 'Data collection pipeline triggered.'
      : 'Autonomous pipeline triggered manually (debug mode).';
    res.json({ success: true, message: msg });
    runFullPipeline();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/pipeline/follow-ups', guardEmailOps, async (req, res) => {
  try {
    res.json({ success: true, message: 'Follow-up pipeline triggered manually.' });
    runFollowUps();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/gmail/status', (req, res) => {
  if (isDataCollectionOnly()) {
    return res.json({ connected: false, required: false, message: 'Gmail not required in data collection mode.' });
  }
  res.json({ connected: isAuthenticated() });
});

router.get('/gmail/auth-url', guardEmailOps, (req, res) => {
  const url = getAuthUrl();
  if (!url) return res.status(400).json({ error: 'Gmail OAuth not configured.' });
  res.json({ url });
});

module.exports = router;
