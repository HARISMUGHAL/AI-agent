'use strict';

function isDataCollectionOnly() {
  return String(process.env.DATA_COLLECTION_ONLY || '').toLowerCase() === 'true';
}

function assertOutreachDisabled(operation = 'outreach operation') {
  if (isDataCollectionOnly()) {
    const error = new Error(`${operation} is disabled while DATA_COLLECTION_ONLY=true`);
    error.code = 'DATA_ONLY_OPERATION_BLOCKED';
    throw error;
  }
}

function safeBlockedResult(operation) {
  return { success: false, blocked: true, code: 'DATA_ONLY_OPERATION_BLOCKED', message: `${operation} is disabled in data collection mode.` };
}

module.exports = { isDataCollectionOnly, assertOutreachDisabled, safeBlockedResult };
