/**
 * gmailService.js — Production-Grade Safe Email Engine
 * Zynqora Edge Autonomous Agent
 *
 * Features:
 *  - Progressive warmup schedule (Day 1→20, 2→30, 3→50, 4→70, 5→100, 6→120, 7+→dynamic)
 *  - Batch sending (5–10 emails per batch)
 *  - Human-like delays: 2–5 min between emails, 5–20 min between batches
 *  - Anti-ban: bounce-rate guard (>5% → STOP), spam complaint → reduce volume
 *  - Duplicate prevention via DB check before every send
 *  - Account switching every 3–7 emails (randomized)
 *  - Randomized send order
 *  - Exponential backoff retry (3 attempts)
 *  - Operates at 70–80% of daily limit
 */

const { google } = require('googleapis');
const {
  insertOutreach,
  updateLeadStatus,
  getSetting,
  setSetting,
  checkEmailSentBefore,
  getWarmupDay,
  getTodayHealthMetrics,
  recordEmailSentHealth,
  recordBounce,
  recordSpamComplaint,
  recordSendError
} = require('../database/db');

// ─── OAuth Client Pool ──────────────────────────────────────────────────────
// Supports multiple Gmail accounts — add more via env vars GMAIL_ACCOUNT_2_*, etc.
let oauth2Clients = null;

function buildOAuth2Client(clientId, clientSecret, redirectUri, refreshToken) {
  if (!clientId || clientId.includes('your_gmail')) return null;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function getAccountPool() {
  if (oauth2Clients) return oauth2Clients;

  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/callback';
  oauth2Clients = [];

  // Primary account
  const primary = buildOAuth2Client(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri,
    process.env.GMAIL_REFRESH_TOKEN || getSetting('gmail_refresh_token')
  );
  if (primary) {
    oauth2Clients.push({
      client: primary,
      email: process.env.YOUR_EMAIL || '',
      name: process.env.YOUR_NAME || '',
      type: (process.env.YOUR_EMAIL || '').includes('@gmail.com') ? 'gmail' : 'business',
      sentThisSession: 0
    });
  }

  // Additional accounts: GMAIL_ACCOUNT_2_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN, _EMAIL, _NAME
  for (let i = 2; i <= 5; i++) {
    const cid = process.env[`GMAIL_ACCOUNT_${i}_CLIENT_ID`];
    const cs  = process.env[`GMAIL_ACCOUNT_${i}_CLIENT_SECRET`];
    const rt  = process.env[`GMAIL_ACCOUNT_${i}_REFRESH_TOKEN`];
    const em  = process.env[`GMAIL_ACCOUNT_${i}_EMAIL`] || '';
    const nm  = process.env[`GMAIL_ACCOUNT_${i}_NAME`]  || '';
    const extra = buildOAuth2Client(cid, cs, redirectUri, rt);
    if (extra) {
      oauth2Clients.push({
        client: extra,
        email: em,
        name: nm,
        type: em.includes('@gmail.com') ? 'gmail' : 'business',
        sentThisSession: 0
      });
    }
  }

  return oauth2Clients;
}

// ─── Warmup Schedule ────────────────────────────────────────────────────────
/**
 * Returns daily send target based on warmup day.
 * Operates at 70–80% of the hard limit to stay safe.
 */
function getWarmupTarget(day, accountType = 'gmail') {
  const hardLimits = { gmail: 150, business: 250 };
  const limit = hardLimits[accountType] || 150;

  // Fixed warmup schedule
  const schedule = [0, 20, 30, 50, 70, 100, 120]; // index 0 unused; index = day
  if (day <= 6) {
    // Cap at 75% of hard limit as a safety ceiling
    return Math.min(schedule[day], Math.floor(limit * 0.75));
  }

  // Day 7+: dynamic, 70–80% of limit
  const minTarget = Math.floor(limit * 0.70);
  const maxTarget = Math.floor(limit * 0.80);
  return Math.floor(Math.random() * (maxTarget - minTarget + 1)) + minTarget;
}

// ─── Anti-Ban Health Check ───────────────────────────────────────────────────
/**
 * Evaluate current health metrics.
 * Returns: { safe: bool, action: 'stop'|'reduce'|'pause'|'ok', reason: string }
 */
function evaluateHealth(accountEmail = null) {
  const m = getTodayHealthMetrics(accountEmail);
  const sent = m.emails_sent || 0;

  if (sent === 0) return { safe: true, action: 'ok', reason: 'No emails sent yet' };

  const bounceRate = (m.bounces || 0) / sent;
  const errorRate  = (m.errors  || 0) / sent;

  if (bounceRate > 0.05) {
    return {
      safe: false,
      action: 'stop',
      reason: `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds 5% threshold`
    };
  }

  if ((m.spam_complaints || 0) > 0) {
    return {
      safe: true,
      action: 'reduce',
      reason: `Spam complaint detected — reducing volume`
    };
  }

  if (errorRate > 0.20 && sent >= 5) {
    return {
      safe: false,
      action: 'pause',
      reason: `Error spike: ${(errorRate * 100).toFixed(1)}% of sends failed`
    };
  }

  return { safe: true, action: 'ok', reason: 'Healthy' };
}

// ─── OAuth / Auth Helpers ────────────────────────────────────────────────────
function getOAuth2Client() {
  const pool = getAccountPool();
  return pool.length > 0 ? pool[0].client : null;
}

function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
}

async function handleAuthCallback(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error('Gmail OAuth not configured');
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  if (tokens.refresh_token) {
    setSetting('gmail_refresh_token', tokens.refresh_token);
    console.log('✅ Gmail refresh token saved.');
  }
  return true;
}

function isAuthenticated() {
  const pool = getAccountPool();
  if (pool.length === 0) return false;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || getSetting('gmail_refresh_token');
  return !!refreshToken;
}

// ─── Low-Level Send ─────────────────────────────────────────────────────────
async function sendEmailViaAccount(account, to, subject, body) {
  const gmail = google.gmail({ version: 'v1', auth: account.client });

  const emailLines = [
    `From: ${account.name} <${account.email}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body
  ];

  const rawMessage = Buffer.from(emailLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: rawMessage }
  });
}

// Legacy single-account send (backward-compat)
async function sendEmail(to, subject, body) {
  const pool = getAccountPool();
  if (!pool.length) throw new Error('Gmail not configured');
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || getSetting('gmail_refresh_token');
  if (!refreshToken) throw new Error('Gmail not authenticated — connect from dashboard');
  pool[0].client.setCredentials({ refresh_token: refreshToken });
  return sendEmailViaAccount(pool[0], to, subject, body);
}

// ─── Delay Utilities ─────────────────────────────────────────────────────────
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Human-like delay between individual emails: 2–5 minutes */
function betweenEmailDelay() {
  const ms = randomInt(2 * 60 * 1000, 5 * 60 * 1000);
  console.log(`⏳ Waiting ${Math.round(ms / 60000)} min ${Math.round((ms % 60000) / 1000)}s before next email (human-behavior delay)...`);
  return new Promise(r => setTimeout(r, ms));
}

/** Delay between batches: 5–20 minutes */
function betweenBatchDelay() {
  const ms = randomInt(5 * 60 * 1000, 20 * 60 * 1000);
  console.log(`⏸️  Batch cooldown: waiting ${Math.round(ms / 60000)} min before next batch...`);
  return new Promise(r => setTimeout(r, ms));
}

// ─── Account Switcher ────────────────────────────────────────────────────────
let _currentAccountIdx = 0;
let _emailsOnCurrentAccount = 0;
let _switchEvery = 3; // randomized per switch

function getNextAccount() {
  const pool = getAccountPool();
  if (pool.length <= 1) return pool[0];

  if (_emailsOnCurrentAccount >= _switchEvery) {
    _currentAccountIdx = (_currentAccountIdx + 1) % pool.length;
    _emailsOnCurrentAccount = 0;
    _switchEvery = randomInt(3, 7); // new random threshold
    console.log(`🔄 Switched to account: ${pool[_currentAccountIdx].email} (next switch in ${_switchEvery} emails)`);
  }

  return pool[_currentAccountIdx];
}

// ─── Core Safe Send ──────────────────────────────────────────────────────────
/**
 * Send a single email safely with:
 *  - Duplicate check
 *  - Health/anti-ban check
 *  - Exponential backoff retry
 *  - Health metric recording
 */
async function sendEmailSafe(lead, emailData, emailsSentToday = 0, dailyCap = 100, followUpNumber = 0) {
  if (!lead.email) {
    console.log(`⚠️  No email address for ${lead.business_name}. Skipping.`);
    return false;
  }

  // ── 5. Duplicate guard ──────────────────────────────────────────────────
  const alreadySent = checkEmailSentBefore(lead.email);
  if (alreadySent) {
    console.log(`🔁 Duplicate skipped: ${lead.email} already contacted on ${alreadySent.sent_at}`);
    return false;
  }

  // ── 4. Anti-ban health check ────────────────────────────────────────────
  const account = getNextAccount();
  const health  = evaluateHealth(account ? account.email : null);

  if (!health.safe) {
    console.error(`🚨 Anti-ban: ${health.action.toUpperCase()} — ${health.reason}`);
    if (health.action === 'stop' || health.action === 'pause') return 'HALT';
  }

  if (health.action === 'reduce') {
    // Skip ~30% of sends to reduce volume
    if (Math.random() < 0.30) {
      console.log(`📉 Volume reduced due to spam complaint. Skipping this send.`);
      return false;
    }
  }

  // ── Retry with exponential backoff ─────────────────────────────────────
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      if (account) {
        await sendEmailViaAccount(account, lead.email, emailData.subject, emailData.body);
      } else {
        await sendEmail(lead.email, emailData.subject, emailData.body);
      }

      // Record success
      insertOutreach(lead.id, emailData.subject, emailData.body, followUpNumber);
      updateLeadStatus(lead.id, followUpNumber > 0 ? 'followed_up' : 'contacted');
      recordEmailSentHealth(account ? account.email : '');

      if (account) {
        account.sentThisSession++;
        _emailsOnCurrentAccount++;
      }

      console.log(`📤 [${emailsSentToday + 1}/${dailyCap}] Email sent to ${lead.business_name} (${lead.email}) via ${account ? account.email : 'primary'}`);
      return true;

    } catch (error) {
      attempt++;
      const isPermError = error.message && (
        error.message.includes('invalid_grant') ||
        error.message.includes('Token has been expired') ||
        error.message.includes('unauthorized')
      );

      if (isPermError) {
        console.error(`🔑 Auth error for ${lead.business_name}: ${error.message} — skipping.`);
        recordSendError(account ? account.email : '');
        return false;
      }

      // Check for bounce signals in error
      if (error.message && (error.message.includes('550') || error.message.includes('no such user'))) {
        console.warn(`📭 Bounce detected for ${lead.email}`);
        recordBounce(lead.id, account ? account.email : '');
        return false;
      }

      recordSendError(account ? account.email : '');
      const backoffMs = Math.pow(2, attempt) * 5000;
      console.error(`⚠️  Send attempt ${attempt}/${MAX_RETRIES} failed for ${lead.business_name}: ${error.message}`);

      if (attempt < MAX_RETRIES) {
        console.log(`🔄 Retrying in ${backoffMs / 1000}s...`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  console.error(`❌ All ${MAX_RETRIES} attempts failed for ${lead.business_name}.`);
  return false;
}

// ─── Batch Sender ────────────────────────────────────────────────────────────
/**
 * Send a list of leads in safe batches.
 *
 * - Batch size: 5–10 (random)
 * - Delay between emails: 2–5 min
 * - Delay between batches: 5–20 min
 * - Randomizes lead order before sending (human behavior)
 * - Stops immediately on HALT signal from anti-ban system
 *
 * @param {Array}  leads              Array of lead objects with email_draft
 * @param {number} emailsSentToday    Running count for today
 * @param {number} dailyCap           Today's total daily cap
 * @param {number} [followUpNumber=0] 0 = first touch, 1+ = follow-up
 * @param {Function} [onSent]         Callback(lead, newCount) after each successful send
 * @returns {number}                  Total emails sent this call
 */
async function sendBatch(leads, emailsSentToday, dailyCap, followUpNumber = 0, onSent = null) {
  if (!leads || leads.length === 0) return 0;

  // 6. Randomize sending order (human behavior)
  const shuffled = [...leads].sort(() => Math.random() - 0.5);

  let totalSent = 0;
  let idx = 0;

  while (idx < shuffled.length) {
    // Re-check cap
    if (emailsSentToday + totalSent >= dailyCap) {
      console.log(`🛑 Daily cap reached mid-batch (${emailsSentToday + totalSent}/${dailyCap}).`);
      break;
    }

    // Pick batch size: 5–10
    const batchSize = randomInt(5, 10);
    const batch = shuffled.slice(idx, idx + batchSize);
    idx += batchSize;

    console.log(`📦 Starting batch: ${batch.length} leads (batch ${Math.ceil(idx / batchSize)} of ~${Math.ceil(shuffled.length / batchSize)})`);

    for (const lead of batch) {
      if (emailsSentToday + totalSent >= dailyCap) break;

      let emailData;
      try {
        emailData = typeof lead.email_draft === 'string'
          ? JSON.parse(lead.email_draft)
          : lead.email_draft;
      } catch (e) {
        console.error(`❌ Bad email_draft for ${lead.business_name}: ${e.message}`);
        continue;
      }

      const result = await sendEmailSafe(lead, emailData, emailsSentToday + totalSent, dailyCap, followUpNumber);

      if (result === 'HALT') {
        console.error('🚨 HALT signal received — stopping all outreach for today.');
        return totalSent;
      }

      if (result === true) {
        totalSent++;
        if (onSent) onSent(lead, emailsSentToday + totalSent);
      }

      // 2. Human-like delay between individual emails
      if (totalSent > 0 || idx < shuffled.length) {
        await betweenEmailDelay();
      }
    }

    // 2. Batch cooldown (5–20 min) — skip after the last batch
    if (idx < shuffled.length && (emailsSentToday + totalSent) < dailyCap) {
      await betweenBatchDelay();
    }
  }

  return totalSent;
}

// ─── Public Warmup Info ──────────────────────────────────────────────────────
/**
 * Returns current warmup status for the dashboard.
 */
function getWarmupStatus() {
  const pool = getAccountPool();
  const day  = getWarmupDay();
  const primaryType = pool.length > 0 ? pool[0].type : 'gmail';
  const target = getWarmupTarget(day, primaryType);
  const health = getTodayHealthMetrics();

  return {
    warmup_day:       day,
    daily_target:     target,
    account_type:     primaryType,
    account_count:    pool.length,
    health: {
      emails_sent:     health.emails_sent     || 0,
      bounces:         health.bounces         || 0,
      spam_complaints: health.spam_complaints || 0,
      errors:          health.errors          || 0
    }
  };
}

// ─── Legacy sendEmailToLead (backward compat) ─────────────────────────────
async function sendEmailToLead(lead, emailData, followUpNumber = 0) {
  if (!lead.email) {
    console.log(`⚠️  No email for ${lead.business_name}. Skipping.`);
    return false;
  }
  try {
    await sendEmail(lead.email, emailData.subject, emailData.body);
    insertOutreach(lead.id, emailData.subject, emailData.body, followUpNumber);
    updateLeadStatus(lead.id, followUpNumber > 0 ? 'followed_up' : 'contacted');
    console.log(`📤 Email sent to ${lead.business_name} (${lead.email})`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to email ${lead.business_name}:`, error.message);
    return false;
  }
}

module.exports = {
  // Auth
  getAuthUrl,
  handleAuthCallback,
  isAuthenticated,
  getOAuth2Client,
  // Send
  sendEmail,
  sendEmailToLead,
  sendEmailSafe,
  sendBatch,
  // Warmup / Health
  getWarmupTarget,
  getWarmupStatus,
  evaluateHealth,
  // Exposed for testing
  getAccountPool,
  betweenEmailDelay,
  betweenBatchDelay
};
