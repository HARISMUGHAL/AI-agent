require('dotenv').config();
const { initDatabase, getReadyToContact, updateLeadStatus, insertOutreach } = require('./src/database/db');
const { sendEmailToLead, isAuthenticated } = require('./src/services/gmailService');

async function pulse() {
  console.log('🚀 Starting Outreach Pulse (Manual Trigger)...');
  await initDatabase();

  if (!isAuthenticated()) {
    console.error('❌ Gmail not authenticated. Connect from dashboard first.');
    process.exit(1);
  }

  const { getLeadsByStatus } = require('./src/database/db');
  
  // 1. Get leads that already have drafts (prioritize these)
  const alreadyDrafted = getLeadsByStatus('email_ready');
  
  // 2. Get leads that are scored but don't have drafts yet
  const readyToScore = getReadyToContact();
  
  const allLeads = [...alreadyDrafted, ...readyToScore]; // No limit for full flush
  
  console.log(`📊 Found ${alreadyDrafted.length} drafts ready and ${readyToScore.length} scored leads.`);
  console.log(`🎯 Full Flush Mode: Processing all ${allLeads.length} leads...`);

  if (allLeads.length === 0) {
    console.log('✅ No pending outreach. Dashboard should be up to date.');
    process.exit(0);
  }

  const { generateEmailForLead } = require('./src/services/emailGenerator');
  const http = require('http');

  for (const lead of allLeads) {
    console.log(`📤 Processing outreach for: ${lead.business_name}...`);
    
    // Instead of direct DB access, we'll trigger the API so the server handles persistence correctly
    await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: process.env.PORT || 3001,
        path: `/api/leads/${lead.id}/send-email`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success) console.log(`✅ Success: ${lead.business_name}`);
            else console.warn(`⚠️  Failed: ${lead.business_name}`);
          } catch (e) {
            console.error(`❌ API Error for ${lead.business_name}:`, e.message);
          }
          resolve();
        });
      });

      req.on('error', (e) => {
        console.error(`❌ Connection error: ${e.message}. Is the server running?`);
        resolve();
      });

      req.end();
    });
    
    // Safety delay for high volume
    await new Promise(r => setTimeout(r, 6000));
  }

  console.log(`🏁 FULL FLUSH COMPLETE. Processed ${allLeads.length} leads.`);
  process.exit(0);
}

pulse().catch(err => {
    console.error('❌ Pulse failed:', err.message);
    process.exit(1);
});
