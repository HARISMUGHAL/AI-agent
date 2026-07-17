'use strict';

const clean = value => String(value ?? '').trim();

function normalizeName(value) {
  return clean(value).normalize('NFKD').toLowerCase().replace(/&/g, ' and ')
    .replace(/\b(limited|ltd|llc|incorporated|inc|corp|corporation|plc)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizePhone(value) {
  const original = clean(value);
  let digits = original.replace(/\D/g, '');
  if (digits.startsWith('0044')) digits = `44${digits.slice(4)}`;
  else if (digits.startsWith('0') && digits.length >= 10) digits = `44${digits.slice(1)}`;
  else if (digits.startsWith('001')) digits = digits.slice(2);
  return { original, normalized: digits };
}

const normalizePostcode = value => clean(value).toUpperCase().replace(/\s+/g, '');
const normalizeCompanyNumber = value => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
const normalizeLocation = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function normalizeDomain(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

module.exports = { clean, normalizeName, normalizeEmail, normalizePhone, normalizePostcode, normalizeCompanyNumber, normalizeDomain, normalizeLocation };
