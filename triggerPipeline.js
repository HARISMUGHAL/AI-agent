require('dotenv').config();
const { initDatabase } = require('./src/database/db');
const { runFullPipeline } = require('./src/services/scheduler');

async function test() {
  console.log('🚀 Manually triggering Full Pipeline to process leads...');
  await initDatabase();
  const result = await runFullPipeline();
  console.log('🏁 Pipeline result:', JSON.stringify(result, null, 2));
  process.exit(0);
}

test();
