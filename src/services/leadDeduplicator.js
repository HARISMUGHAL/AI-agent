'use strict';

const { normalizeName, normalizeEmail, normalizePhone, normalizePostcode, normalizeCompanyNumber, normalizeDomain, normalizeLocation } = require('../utils/normalizers');
const { mergeEvidence, sourceStrength } = require('./provenanceService');

function fingerprints(lead, dataset) {
  const values = [];
  const add = (type, value) => { if (value) values.push(`${type}:${value}`); };
  add('source', String(lead.source_listing_id || '').trim().toLowerCase());
  add('email', normalizeEmail(lead.email || lead.business_email || lead.public_email));
  add('phone', normalizePhone(lead.phone || lead.business_phone).normalized);
  add('domain', normalizeDomain(lead.website));
  if (dataset === 'UK') {
    add('company', normalizeCompanyNumber(lead.company_number));
    const namePostcode = `${normalizeName(lead.business_name)}|${normalizePostcode(lead.postcode)}`;
    if (!namePostcode.endsWith('|')) add('name_postcode', namePostcode);
  } else {
    const location = `${normalizeLocation(lead.city)}|${normalizeLocation(lead.state)}`;
    if (normalizeName(lead.business_name) && location !== '|') add('name_location', `${normalizeName(lead.business_name)}|${location}`);
  }
  return values;
}

function recordStrength(record) {
  return sourceStrength(record.primary_source_type || record.source_type) * 100 + Number(record.confidence_score || record.lead_score || 0);
}

function mergeRecords(existing, incoming) {
  const stronger = recordStrength(incoming) > recordStrength(existing) ? incoming : existing;
  const weaker = stronger === incoming ? existing : incoming;
  const merged = { ...weaker, ...stronger };
  for (const [key, value] of Object.entries(weaker)) {
    if ((merged[key] === '' || merged[key] === null || merged[key] === undefined) && value !== '') merged[key] = value;
  }
  merged.evidence = mergeEvidence(existing.evidence || [], incoming.evidence || []);
  merged.secondary_source_url ||= weaker.primary_source_url || weaker.source_url || '';
  return merged;
}

function deduplicateLeads(leads, dataset, historicalFingerprints = new Set()) {
  const result = [];
  const index = new Map();
  let duplicates = 0;
  for (const lead of leads || []) {
    const keys = fingerprints(lead, dataset);
    const historical = keys.find(key => historicalFingerprints.has(key));
    if (historical) { duplicates++; continue; }
    const match = keys.map(key => index.get(key)).find(value => value !== undefined);
    if (match !== undefined) {
      result[match] = mergeRecords(result[match], lead);
      for (const key of fingerprints(result[match], dataset)) index.set(key, match);
      duplicates++;
    } else {
      const position = result.push({ ...lead, evidence: mergeEvidence(lead.evidence || []) }) - 1;
      for (const key of keys) index.set(key, position);
    }
  }
  return { leads: result, duplicates, fingerprints: new Set(result.flatMap(lead => fingerprints(lead, dataset))) };
}

module.exports = { fingerprints, mergeRecords, deduplicateLeads };
