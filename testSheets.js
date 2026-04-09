require('dotenv').config();
const { initDatabase } = require('./src/database/db');
const { syncLeadToSheets, initSheetHeaders } = require('./src/services/googleSheets');

async function test() {
  console.log('🧪 Starting Google Sheets Sync Test...');
  await initDatabase();
  
  const testLead = {
    business_name: 'Test Business ' + Date.now(),
    niche: 'Tests',
    location: 'Automation City',
    email: 'test@example.com',
    phone: '123-456-7890',
    website: 'https://test.com',
    rating: 5,
    review_count: 1,
    status: 'test'
  };

  console.log('📝 Initializing headers...');
  await initSheetHeaders();

  console.log('📊 Syncing test lead...');
  const result = await syncLeadToSheets(testLead);
  
  if (result.success) {
    console.log('✅ TEST PASSED: Lead sync was successful.');
  } else {
    console.error('❌ TEST FAILED:', result.message);
    if (result.message.includes('insufficient permissions') || result.message.includes('403')) {
        console.log('\n💡 HINT: You need to RE-AUTHENTICATE on your dashboard to grant sheet permissions!');
    }
  }
  process.exit(0);
}

test();
