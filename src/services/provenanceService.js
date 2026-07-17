'use strict';

const { safeHyperlink } = require('../utils/formulaSanitizer');

const SOURCE_STRENGTH = { official_website: 5, government: 5, licensing_register: 5, companies_house: 5, google_places: 4, official_profile: 4, open_data: 4, directory: 2, user_seed: 2 };

function sourceStrength(type) { return SOURCE_STRENGTH[type] || 1; }

function normalizeEvidence(evidence = {}) {
  const url = safeHyperlink(evidence.url || evidence.source_url);
  if (!url) return null;
  return {
    field: String(evidence.field || 'record'),
    value: evidence.value ?? '',
    source_name: String(evidence.source_name || 'Public source'),
    source_type: String(evidence.source_type || 'user_seed'),
    url,
    collected_at: evidence.collected_at || new Date().toISOString()
  };
}

function mergeEvidence(...groups) {
  const seen = new Set();
  const merged = [];
  for (const item of groups.flat()) {
    const evidence = normalizeEvidence(item);
    if (!evidence) continue;
    const key = `${evidence.field}|${evidence.value}|${evidence.url}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); merged.push(evidence); }
  }
  return merged.sort((a, b) => sourceStrength(b.source_type) - sourceStrength(a.source_type));
}

function hasTraceableSource(record) {
  return !!safeHyperlink(record.primary_source_url || record.source_url);
}

module.exports = { sourceStrength, normalizeEvidence, mergeEvidence, hasTraceableSource };
