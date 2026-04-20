/**
 * accountManager.js — Phase 5: Multi-Account Load Balancer
 * Zynqora Edge Autonomous Agent
 */

const { getTodayHealthMetrics } = require('../database/db');

// Maintain stable rotation state across batches
let _accountIndex = -1;

/**
 * Hard caps required by Phase 5 safety rules
 */
const LIMITS = {
  gmail: 150,
  business: 250
};

/**
 * Evaluates health strictly per account.
 * Drops account if bounce/error rate > 5% (min 5 sends).
 * Honors hard caps.
 */
function evaluateAccountHealth(account) {
  const m = getTodayHealthMetrics(account.email);
  const totalSent = m.emails_sent || 0;
  const bounces = m.bounces || 0;
  const errors = m.errors || 0;
  
  // Bounce rate evaluated *per account* locally
  const failRate = totalSent >= 5 ? ((bounces + errors) / totalSent) : 0;
  const cap = LIMITS[account.type] || 150;
  
  return {
    email: account.email,
    type: account.type,
    safe: failRate <= 0.05 && totalSent < cap,
    bouncedOut: failRate > 0.05,
    cappedOut: totalSent >= cap,
    failRate: failRate,
    metrics: { sent: totalSent, bounces, errors, cap }
  };
}

/**
 * Extracts only accounts that are safe to use today.
 */
function getHealthyAccounts(allAccounts) {
  return allAccounts.filter(acc => evaluateAccountHealth(acc).safe);
}

/**
 * Stable rotation system (invoked every 3-7 emails by sendBatch).
 */
function rotateAccount(allAccounts) {
  const healthy = getHealthyAccounts(allAccounts);
  if (healthy.length === 0) return null;
  
  _accountIndex = (_accountIndex + 1) % healthy.length;
  return healthy[_accountIndex];
}

/**
 * Provides live telemetry for the /dashboard/accounts API endpoint
 */
function getAccountTelemetry(allAccounts) {
  return allAccounts.map(evaluateAccountHealth);
}

module.exports = {
  LIMITS,
  evaluateAccountHealth,
  getHealthyAccounts,
  rotateAccount,
  getAccountTelemetry
};
