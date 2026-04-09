/**
 * scheduler.js — Autonomous Business-Hours Agent
 * Zynqora Edge — Fully Autonomous AI Outreach Agent
 *
 * Features:
 *  - Runs only during business hours (9AM–6PM local time)
 *  - Interval: every AGENT_RUN_INTERVAL_MINUTES (default 12 min)
 *  - Email warm-up: Day 1-3 → 40/day, Day 4-7 → 80/day, Day 8+ → 100–150/day (randomized)
 *  - Random delay between emails: 30–120 seconds
 *  - Retry with exponential backoff on send failure
 *  - Daily counter reset at midnight
 *  - Emits real-time events via Socket.io
 */

const cron = require('node-cron');
const { runDiscovery } = require('./googleMaps');
const { scoreAllLeads } = require('./leadScorer');
const { analyzeNiches } = require('./nicheAnalyzer');
const { generateAllEmails, generateEmailForLead } = require('./emailGenerator');
const {
  getLeadsByStatus, getLeadsNeedingFollowUp,
  getSetting, setSetting, getStats
} = require('../database/db');
const { sendEmailSafe, isAuthenticated } = require('./gmailService');
const { sendDailyReport } = require('./reportGenerator');
const { emitStatus, emitLog, emitLeadFound, emitEmailSent } = require('./socketService');

// ─── Agent State ──────────────────────────────────────────────────────────────
const agentState = {
  isRunning: false,
  emailsSentToday: 0,
  leadsFoundToday: 0,
  lastRunAt: null,
  nextRunAt: null,
  dailyCap: 40,
  agentStartDate: null,
  status: 'idle',        // 'idle' | 'running' | 'sleeping' | 'cap_reached'
  mode: 'fully_automatic',
  lastLog: ''
};

// ─── Constants ────────────────────────────────────────────────────────────────
const BUSINESS_HOUR_START = parseInt(process.env.BUSINESS_HOUR_START || '9');
const BUSINESS_HOUR_END   = parseInt(process.env.BUSINESS_HOUR_END   || '18');
const INTERVAL_MINUTES    = parseInt(process.env.AGENT_RUN_INTERVAL_MINUTES || '12');
const MIN_DAILY_CAP = 100;  // Day 8+ minimum
const MAX_DAILY_CAP = 150;  // Day 8+ maximum

// ─── Warm-Up Logic ────────────────────────────────────────────────────────────
/**
 * Returns the daily email send target based on warm-up day count.
 *  Day 1–3  → 40 emails/day
 *  Day 4–7  → 80 emails/day
 *  Day 8+   → Random between 100–150 emails/day (anti-pattern detection)
 */
function getDailyTarget(dayCount) {
  if (dayCount <= 3) return 40;
  if (dayCount <= 7) return 80;
  return Math.floor(Math.random() * (MAX_DAILY_CAP - MIN_DAILY_CAP + 1)) + MIN_DAILY_CAP;
}

function getDailyCap() {
  if (!agentState.agentStartDate) {
    const stored = getSetting('agent_start_date');
    if (stored) {
      agentState.agentStartDate = new Date(stored);
    } else {
      agentState.agentStartDate = new Date();
      setSetting('agent_start_date', agentState.agentStartDate.toISOString());
    }
  }

  const now = new Date();
  const daysSinceStart = Math.floor(
    (now - agentState.agentStartDate) / (1000 * 60 * 60 * 24)
  );

  return getDailyTarget(daysSinceStart + 1); // +1 so Day 0 = Day 1
}

// ─── Business Hours Check ─────────────────────────────────────────────────────
function isBusinessHours() {
  const now = new Date();
  const hour = now.getHours();
  return hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END;
}

// ─── Random Delay Helper ──────────────────────────────────────────────────────
function randomDelay(minMs = 30000, maxMs = 120000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Midnight Daily Reset ─────────────────────────────────────────────────────
function scheduleMidnightReset() {
  cron.schedule('0 0 * * *', () => {
    agentState.emailsSentToday = 0;
    agentState.leadsFoundToday = 0;
    agentState.status = 'idle';
    agentState.dailyCap = getDailyCap(); // recalculates with fresh randomization for Day 8+
    log(`🌅 Midnight reset: counters cleared. Today's target: ${agentState.dailyCap} emails.`, 'info');
    broadcastStatus();
  });
}

// ─── Logging Helper ───────────────────────────────────────────────────────────
function log(message, level = 'info') {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${message}`);
  agentState.lastLog = message;
  emitLog(message, level);
}

// ─── Broadcast Status ─────────────────────────────────────────────────────────
function broadcastStatus() {
  agentState.dailyCap = getDailyCap();
  emitStatus({
    status:              agentState.status,
    mode:                agentState.mode,
    emails_sent_today:   agentState.emailsSentToday,
    leads_found_today:   agentState.leadsFoundToday,
    daily_cap:           agentState.dailyCap,
    daily_target:        agentState.dailyCap,        // same value — dynamic per day
    daily_target_range:  '100-150',                  // shown in dashboard after warm-up
    last_run_at:         agentState.lastRunAt,
    next_run_at:         agentState.nextRunAt,
    is_business_hours:   isBusinessHours(),
    last_log:            agentState.lastLog,
    dashboard_name:      'Zynqora Edge'
  });
}

// ─── Get Agent Status (for API) ───────────────────────────────────────────────
function getAgentStatus() {
  agentState.dailyCap = getDailyCap();
  return {
    status:              agentState.status,
    mode:                agentState.mode,
    emails_sent_today:   agentState.emailsSentToday,
    leads_found_today:   agentState.leadsFoundToday,
    daily_cap:           agentState.dailyCap,
    daily_target:        agentState.dailyCap,        // current day's actual target
    daily_target_range:  '100-150',                  // post-warmup range shown in UI
    last_run_at:         agentState.lastRunAt,
    next_run_at:         agentState.nextRunAt,
    is_business_hours:   isBusinessHours(),
    last_log:            agentState.lastLog,
    dashboard_name:      'Zynqora Edge',
    agent_mode:          'fully_automatic',
    email_strategy:      'rate_limited_randomized',
    realtime_updates:    true
  };
}

// ─── Full Pipeline ─────────────────────────────────────────────────────────────
async function runFullPipeline() {
  if (agentState.isRunning) {
    log('⚠️  Pipeline already running. Skipping.', 'warning');
    return { success: false, message: 'Pipeline already running' };
  }

  const cap = getDailyCap();
  agentState.dailyCap = cap;

  if (agentState.emailsSentToday >= cap) {
    agentState.status = 'cap_reached';
    log(`🛑 Daily email cap reached (${agentState.emailsSentToday}/${cap}). Skipping outreach.`, 'warning');
    broadcastStatus();
    return { success: false, message: 'Daily cap reached' };
  }

  agentState.isRunning = true;
  agentState.status = 'running';
  agentState.lastRunAt = new Date().toISOString();
  broadcastStatus();

  const results = { discovered: 0, scored: 0, emailsGenerated: 0, emailsSent: 0 };

  try {
    log('\n' + '═'.repeat(50), 'info');
    log('🚀 ZYNQORA EDGE — AUTONOMOUS PIPELINE STARTING', 'info');
    log('═'.repeat(50), 'info');

    // Step 1: Discover
    log('── Step 1/5: Lead Discovery ──', 'info');
    broadcastStatus();
    results.discovered = await runDiscovery();
    agentState.leadsFoundToday += results.discovered;
    log(`✅ Discovered ${results.discovered} new leads today.`, 'success');
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

    // Step 5: Outreach (with anti-ban delays)
    log('── Step 5/5: Smart Email Outreach ──', 'info');
    if (isAuthenticated()) {
      const readyLeads = getLeadsByStatus('email_ready');
      const remaining = cap - agentState.emailsSentToday;
      const toSend = readyLeads.slice(0, Math.max(0, remaining));

      log(`📊 ${readyLeads.length} leads ready. Sending up to ${toSend.length} (cap: ${cap}, sent today: ${agentState.emailsSentToday}).`, 'info');

      for (const lead of toSend) {
        if (agentState.emailsSentToday >= cap) {
          log(`🛑 Daily cap hit mid-run (${agentState.emailsSentToday}/${cap}). Stopping outreach.`, 'warning');
          agentState.status = 'cap_reached';
          break;
        }

        if (lead.email_draft) {
          try {
            const emailData = JSON.parse(lead.email_draft);
            const sent = await sendEmailSafe(lead, emailData, agentState.emailsSentToday, cap);
            if (sent) {
              results.emailsSent++;
              agentState.emailsSentToday++;
              emitEmailSent(lead, agentState.emailsSentToday, cap);
              log(`📤 Email sent to ${lead.business_name} (${lead.email}) [${agentState.emailsSentToday}/${cap}]`, 'success');
              broadcastStatus();

              // Anti-ban: random delay 30–120 seconds between emails
              const delaySec = Math.floor(Math.random() * 91) + 30;
              log(`⏳ Waiting ${delaySec}s before next email (anti-ban)...`, 'info');
              await randomDelay(delaySec * 1000, delaySec * 1000);
            }
          } catch (e) {
            log(`❌ Failed to process lead ${lead.business_name}: ${e.message}`, 'error');
          }
        }
      }
    } else {
      log('❌ Gmail not authenticated. Connect Gmail from dashboard.', 'error');
    }

    log('═'.repeat(50), 'info');
    log(`✅ PIPELINE COMPLETE — Discovered: ${results.discovered} | Sent: ${results.emailsSent}`, 'success');
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
  if (!isAuthenticated()) {
    log('⚠️  Gmail not connected. Cannot send follow-ups.', 'warning');
    return 0;
  }

  const leads = getLeadsNeedingFollowUp();
  if (leads.length === 0) {
    log('✅ No leads need follow-up right now.', 'info');
    return 0;
  }

  const cap = getDailyCap();
  log(`\n📩 Sending follow-ups to ${leads.length} leads...`, 'info');
  let sent = 0;

  for (const lead of leads) {
    if (agentState.emailsSentToday >= cap) {
      log('🛑 Daily cap reached. Stopping follow-ups.', 'warning');
      break;
    }
    const email = await generateEmailForLead(lead, true);
    const success = await sendEmailSafe(lead, email, agentState.emailsSentToday, cap, 1);
    if (success) {
      sent++;
      agentState.emailsSentToday++;
      broadcastStatus();
      // Anti-ban delay
      const delaySec = Math.floor(Math.random() * 91) + 30;
      await randomDelay(delaySec * 1000, delaySec * 1000);
    }
  }

  log(`✅ Sent ${sent} follow-up emails.`, 'success');
  return sent;
}

// ─── Main Scheduler ────────────────────────────────────────────────────────────
function startScheduler() {
  log('🤖 Zynqora Edge Autonomous Agent starting...', 'info');
  log(`📅 Schedule: every ${INTERVAL_MINUTES} min | Business hours: ${BUSINESS_HOUR_START}:00–${BUSINESS_HOUR_END}:00`, 'info');

  // Initialize daily cap based on start date
  agentState.dailyCap = getDailyCap();
  log(`📈 Warm-up cap today: ${agentState.dailyCap} emails/day`, 'info');

  // Start status broadcast interval (every 5 seconds)
  setInterval(() => {
    if (agentState.status !== 'running') {
      broadcastStatus();
    }
  }, 5000);

  // Main cron: runs every INTERVAL_MINUTES, checks business hours internally
  const cronExpr = `*/${INTERVAL_MINUTES} * * * *`;

  cron.schedule(cronExpr, async () => {
    if (!isBusinessHours()) {
      agentState.status = 'sleeping';
      const h = new Date().getHours();
      log(`😴 Outside business hours (${h}:00). Agent sleeping.`, 'info');
      broadcastStatus();
      return;
    }

    if (agentState.emailsSentToday >= agentState.dailyCap) {
      agentState.status = 'cap_reached';
      log(`🛑 Daily cap reached (${agentState.emailsSentToday}/${agentState.dailyCap}). Resting until midnight.`, 'warning');
      broadcastStatus();
      return;
    }

    // Calculate next run
    const next = new Date(Date.now() + INTERVAL_MINUTES * 60 * 1000);
    agentState.nextRunAt = next.toISOString();

    log(`\n⏰ Autonomous pipeline triggered at ${new Date().toLocaleTimeString()}`, 'info');
    await runFullPipeline();
  });

  // Follow-ups cron: once a day at 2PM
  cron.schedule('0 14 * * *', async () => {
    if (!isBusinessHours()) return;
    log('\n⏰ Scheduled follow-ups starting...', 'info');
    await runFollowUps();
  });

  // Daily report at end of business day
  cron.schedule('0 17 * * *', async () => {
    log('\n📊 Sending daily activity report...', 'info');
    try {
      await sendDailyReport();
    } catch (e) {
      log(`⚠️  Daily report failed: ${e.message}`, 'warning');
    }
  });

  // Midnight reset
  scheduleMidnightReset();

  log(`✅ Scheduler active. Next run in ~${INTERVAL_MINUTES} minutes (if business hours).`, 'success');
  broadcastStatus();
}

module.exports = {
  runFullPipeline,
  runFollowUps,
  startScheduler,
  getAgentStatus,
  agentState
};
