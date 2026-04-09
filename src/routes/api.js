const express = require('express');
const router = express.Router();
const { 
  getStats, getAllLeads, getLeadById, getLeadsByNiche, 
  getAllNiches, updateLeadStatus, updateLeadEmailAddress,
  getOutreachByLead, getLeadsByStatus
} = require('../database/db');
const { runDiscovery, searchBusinesses } = require('../services/googleMaps');
const { scoreAllLeads, scoreLead } = require('../services/leadScorer');
const { analyzeNiches } = require('../services/nicheAnalyzer');
const { generateEmailForLead, generateAllEmails } = require('../services/emailGenerator');
const { sendEmailToLead, isAuthenticated, getAuthUrl } = require('../services/gmailService');
const { runFullPipeline, runFollowUps } = require('../services/scheduler');

// ─── Dashboard Stats ────────────────────────────────────
router.get('/dashboard', (req, res) => {
  try {
    const stats = getStats();
    stats.gmailConnected = isAuthenticated();
    stats.apiKeysConfigured = {
      googleMaps: !!process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY !== 'your_google_maps_api_key_here',
      gemini: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here',
      gmail: !!process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_ID !== 'your_gmail_client_id_here'
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Leads ──────────────────────────────────────────────
router.get('/leads', (req, res) => {
  try {
    const { niche, status } = req.query;
    let leads;
    if (niche) leads = getLeadsByNiche(niche);
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
    if (email) updateLeadEmailAddress(id, email);
    const lead = getLeadById(id);
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Discovery ──────────────────────────────────────────
router.post('/leads/discover', async (req, res) => {
  try {
    const { niche, location } = req.body;
    let count;
    if (niche && location) {
      const leads = await searchBusinesses(niche, niche, location);
      count = leads.length;
    } else {
      count = await runDiscovery();
    }
    res.json({ success: true, leadsFound: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Scoring ────────────────────────────────────────────
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

// ─── Email Generation ───────────────────────────────────
router.post('/leads/:id/generate-email', async (req, res) => {
  try {
    const lead = getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const email = await generateEmailForLead(lead, req.body.followUp || false);
    res.json({ success: true, email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/generate-emails', async (req, res) => {
  try {
    const count = await generateAllEmails();
    res.json({ success: true, emailsGenerated: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Email Sending ──────────────────────────────────────
router.post('/leads/:id/send-email', async (req, res) => {
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

// ─── Niches ─────────────────────────────────────────────
router.get('/niches', (req, res) => {
  try { res.json(getAllNiches()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/niches/analyze', async (req, res) => {
  try {
    const niches = await analyzeNiches();
    res.json({ success: true, niches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Pipeline ───────────────────────────────────────────
router.post('/pipeline/run', async (req, res) => {
  try {
    res.json({ success: true, message: 'Pipeline started.' });
    runFullPipeline();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/pipeline/follow-ups', async (req, res) => {
  try {
    res.json({ success: true, message: 'Follow-up pipeline started.' });
    runFollowUps();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Gmail Auth ─────────────────────────────────────────
router.get('/gmail/status', (req, res) => {
  res.json({ connected: isAuthenticated() });
});

router.get('/gmail/auth-url', (req, res) => {
  const url = getAuthUrl();
  if (!url) return res.status(400).json({ error: 'Gmail OAuth not configured.' });
  res.json({ url });
});

module.exports = router;
