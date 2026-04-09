require('dotenv').config();
const { initDatabase, getLeadsByStatus } = require('./src/database/db');
const { generateEmailForLead } = require('./src/services/emailGenerator');

async function refresh() {
  console.log('🔄 Refreshing all pitches to the new Professional Standard...');
  await initDatabase();

  const leads = getLeadsByStatus('scored');
  console.log(`📊 Found ${leads.length} leads to refresh.`);

  if (leads.length === 0) {
    console.log('✅ No leads need refreshing.');
    process.exit(0);
  }

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    process.stdout.write(`   [${i+1}/${leads.length}] Refreshing ${lead.business_name}... `);
    try {
      await generateEmailForLead(lead);
      console.log('✅ Done');
    } catch (e) {
      console.log(`❌ Failed: ${e.message}`);
    }
    // Small delay to avoid API rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n✨ ALL PITCHES UPGRADED TO PROFESSIONAL STANDARD.');
  process.exit(0);
}

refresh().catch(err => {
    console.error('❌ Refresh failed:', err.message);
    process.exit(1);
});
