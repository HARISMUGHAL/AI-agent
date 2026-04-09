require('dotenv').config();
const { initDatabase, getLeadsByStatus, updateLeadStatus, saveDb } = require('./src/database/db');

async function recover() {
  console.log('🏁 Starting Connection Recovery...');
  await initDatabase();
  
  const readyLeads = getLeadsByStatus('email_ready');
  console.log(`📊 Found ${readyLeads.length} leads waiting for outreach update.`);
  
  if (readyLeads.length === 0) {
    console.log('✅ No leads to recover. Dashboard should be up to date.');
    process.exit(0);
  }

  console.log('📤 Updating status to "contacted" for stalled leads...');
  for (const lead of readyLeads) {
    // We simulate the outreach being "done" because the previous run actually sent them
    // but failed to update the database.
    updateLeadStatus(lead.id, 'contacted');
  }

  await saveDb(5, 500); // Force save with extra retries
  console.log('✅ RECOVERY COMPLETE. New count should be visible on dashboard.');
  process.exit(0);
}

recover().catch(err => {
    console.error('❌ Recovery failed:', err.message);
    process.exit(1);
});
