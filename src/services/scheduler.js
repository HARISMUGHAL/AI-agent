const cron = require('node-cron');
const { runDiscovery } = require('./googleMaps');
const { scoreAllLeads } = require('./leadScorer');
const { analyzeNiches } = require('./nicheAnalyzer');
const { generateAllEmails, generateEmailForLead } = require('./emailGenerator');
const { getLeadsByStatus, getLeadsNeedingFollowUp } = require('../database/db');
const { sendEmailToLead, isAuthenticated } = require('./gmailService');
const { sendDailyReport } = require('./reportGenerator');

let isRunning = false;

/**
 * Run the full pipeline: discover → score → analyze → generate → send
 */
async function runFullPipeline() {
  if (isRunning) {
    console.log('⚠️  Pipeline is already running. Skipping.');
    return { success: false, message: 'Pipeline already running' };
  }

  isRunning = true;
  const results = { discovered: 0, scored: 0, emailsGenerated: 0, emailsSent: 0 };

  try {
    console.log('\n' + '═'.repeat(50));
    console.log('🚀 STARTING FULL PIPELINE');
    console.log('═'.repeat(50));

    console.log('\n── Step 1/5: Discovery ──');
    results.discovered = await runDiscovery();

    console.log('\n── Step 2/5: Scoring ──');
    results.scored = await scoreAllLeads();

    console.log('\n── Step 3/5: Niche Analysis ──');
    await analyzeNiches();

    console.log('\n── Step 4/5: Email Generation ──');
    results.emailsGenerated = await generateAllEmails();

    console.log('\n── Step 5/5: Email Outreach ──');
    if (isAuthenticated()) {
      const readyLeads = getLeadsByStatus('email_ready');
      console.log(`📊 Found ${readyLeads.length} leads in 'email_ready' status.`);
      
      for (const lead of readyLeads) {
        if (lead.email_draft) {
          try {
            const emailData = JSON.parse(lead.email_draft);
            const sent = await sendEmailToLead(lead, emailData);
            if (sent) results.emailsSent++;
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) {
            console.error(`❌ Failed to send to ${lead.business_name}:`, e.message);
          }
        } else {
          console.warn(`⚠️  No draft found for ready lead: ${lead.business_name}`);
        }
      }
    } else {
      console.log('❌ Gmail not connected. Emails generated but NOT sent. Please connect Gmail from the dashboard.');
    }

    console.log('\n' + '═'.repeat(50));
    console.log('✅ PIPELINE COMPLETE');
    console.log(`   Discovered: ${results.discovered} | Scored: ${results.scored}`);
    console.log(`   Emails Generated: ${results.emailsGenerated} | Sent: ${results.emailsSent}`);
    
    console.log('\n── Step 6/6: Daily Lead Report ──');
    await sendDailyReport();
    
    console.log('═'.repeat(50) + '\n');

    return { success: true, results };
  } catch (error) {
    console.error('❌ Pipeline error:', error.message);
    return { success: false, message: error.message };
  } finally {
    isRunning = false;
  }
}

async function runFollowUps() {
  if (!isAuthenticated()) {
    console.log('⚠️  Gmail not connected. Cannot send follow-ups.');
    return 0;
  }

  const leads = getLeadsNeedingFollowUp();
  if (leads.length === 0) {
    console.log('✅ No leads need follow-up right now.');
    return 0;
  }

  console.log(`\n📩 Sending follow-ups to ${leads.length} leads...`);
  let sent = 0;

  for (const lead of leads) {
    const email = await generateEmailForLead(lead, true);
    const success = await sendEmailToLead(lead, email, 1);
    if (success) sent++;
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`✅ Sent ${sent} follow-up emails.`);
  return sent;
}

function startScheduler() {
  const discoveryCron = process.env.DISCOVERY_CRON || '0 9 * * *';
  const followUpCron = process.env.FOLLOW_UP_CRON || '0 14 * * *';

  if (cron.validate(discoveryCron)) {
    cron.schedule(discoveryCron, () => {
      console.log('\n⏰ Scheduled pipeline starting...');
      runFullPipeline();
    });
    console.log(`📅 Discovery scheduled: ${discoveryCron}`);
  }

  if (cron.validate(followUpCron)) {
    cron.schedule(followUpCron, () => {
      console.log('\n⏰ Scheduled follow-ups starting...');
      runFollowUps();
    });
    console.log(`📅 Follow-ups scheduled: ${followUpCron}`);
  }
}

module.exports = { runFullPipeline, runFollowUps, startScheduler };
