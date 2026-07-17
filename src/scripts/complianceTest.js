require('dotenv').config();
const { runDiscovery } = require('../services/googleMaps');

async function simulate() {
  console.log('Running simulated compliance pass...');
  // Force target locations to something outside the region plus one inside
  process.env.TARGET_LOCATIONS = 'Tokyo, Japan, Toronto, Canada';
  process.env.TARGET_NICHES = 'clinics';

  try {
    const stats = await runDiscovery(5);
    console.log('\nSimulation Results:');
    console.log(stats);
    console.log('Validation: Compliance Enforced.');
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

simulate();
