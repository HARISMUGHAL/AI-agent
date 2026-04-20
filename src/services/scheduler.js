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
const { runDiscovery }                    = require('./googleMaps');
const { scoreAllLeads }                   = require('./leadScorer');
const { analyzeNiches }                   = require('./nicheAnalyzer');
const { generateAllEmails, generateEmailForLead } = require('./emailGenerator');
const {
  getLeadsByStatus,
  getLeadsNeedingFollowUp,
  getSetting, setSetting,
  getEmailsSentToday,
  getWarmupDay,
  getTodayHealthMetrics,
  getBounceRateMetrics,
  getStats
} = require('../database/db');
const {
  sendBatch,
  sendEmailSafe,
  isAuthenticated,
  getWarmupTarget,
  getWarmupStatus,
  evaluateHealth
} = require('./gmailService');
const { sendDailyReport }  = require('./reportGenerator');
const { emitStatus, emitLog, emitLeadFound, emitEmailSent } = require('./socketService');
const { updateLeadScoreAndStatus } = require('./googleSheets');
const { processInbox } = require('./replyHandler');

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
  haltReason:     ''
};

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

// ─── Get Agent Status (API) ───────────────────────────────────────────────────
function getAgentStatus() {
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
    log('── Step 0: Reply Detection ──', 'info');
    if (isAuthenticated()) {
      await processInbox();
    } else {
      log('⚠️  Gmail not connected. Skipping reply detection.', 'warning');
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
  agentState
};
