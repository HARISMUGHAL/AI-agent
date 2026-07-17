'use strict';

function sanitizeSpreadsheetValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date || ['number', 'boolean'].includes(typeof value)) return value;
  const text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function safeHyperlink(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

module.exports = { sanitizeSpreadsheetValue, safeHyperlink };
