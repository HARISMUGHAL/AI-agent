const { runFullPipeline } = require('./src/services/scheduler.js');
const db = require('./src/database/db.js');

async function testPipeline() {
  await db.initDatabase();
  const results = await runFullPipeline();
  console.log('Test Pipeline Results:', results);
}

testPipeline();
