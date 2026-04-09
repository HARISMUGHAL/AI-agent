require('dotenv').config();
const { initDatabase } = require('./src/database/db');
const { sendDailyReport } = require('./src/services/reportGenerator');

async function test() {
  console.log('🧪 Starting Report Generation Test...');
  await initDatabase();
  const result = await sendDailyReport();
  console.log('🏁 Test Result:', result);
  process.exit(0);
}

test();
