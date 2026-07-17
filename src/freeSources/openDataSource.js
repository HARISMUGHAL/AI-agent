'use strict';

const { respectfulFetch } = require('./httpClient');
const { normalizeCandidate } = require('./sourceRegistry');

const metadata = {
  name: 'Configured Government Open Data', country: 'US,UK', categories: ['configured'], base_url: '', source_type: 'government',
  enabled: !!process.env.OPEN_DATA_SOURCE_URLS, requires_key: false, request_delay_ms: 2000, concurrency: 1, cache_ttl: 24, provenance_strength: 5
};

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map(value => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function recordsFromPayload(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    return parsed.results || parsed.data || parsed.records || [];
  } catch { return parseCsv(text); }
}

function parseRecords(records, context, sourceUrl, sourceName = metadata.name) {
  return records.map((record, index) => normalizeCandidate({
    source_name: sourceName, source_type: metadata.source_type, source_url: sourceUrl,
    source_listing_id: record.id || record.license_number || record.company_number || `${sourceName}:${index}`,
    business_name: record.business_name || record.name || record.company_name || record.trading_name || '',
    category: record.category || record.business_type || record.license_type || context.category || '', business_type: record.business_type || '',
    city: record.city || context.location || '', state_or_region: record.state || record.region || record.county || '',
    postcode: record.postcode || record.zip || record.zip_code || '', country: record.country || context.country || '',
    address: record.address || record.full_address || '', phone: record.phone || record.telephone || '', email: record.email || '',
    website: record.website || record.url || '', contact_page_url: record.contact_page_url || '', company_number: record.company_number || '', raw_record: record
  })).filter(candidate => candidate.business_name);
}

async function discover(context) {
  const configured = String(process.env.OPEN_DATA_SOURCE_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  const output = [];
  for (const url of configured) {
    const response = await respectfulFetch(url, { requestDelayMs: metadata.request_delay_ms, cacheTtlHours: metadata.cache_ttl });
    if (!response.ok) continue;
    output.push(...parseRecords(recordsFromPayload(response.text), context, url));
  }
  return output;
}

module.exports = { metadata, discover, parseCsv, recordsFromPayload, parseRecords };
