'use strict';

const { respectfulFetch } = require('./httpClient');
const { recordsFromPayload, parseRecords } = require('./openDataSource');

const metadata = {
  name: 'Configured Local Authority Register', country: 'UK', categories: ['taxi','private hire','operator'], base_url: '',
  source_type: 'licensing_register', enabled: !!process.env.LOCAL_AUTHORITY_SOURCE_URLS, requires_key: false,
  request_delay_ms: 2500, concurrency: 1, cache_ttl: 24, provenance_strength: 5
};

async function discover(context) {
  if (context.country !== 'United Kingdom') return [];
  const configured = String(process.env.LOCAL_AUTHORITY_SOURCE_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  const output = [];
  for (const url of configured) {
    const response = await respectfulFetch(url, { requestDelayMs: metadata.request_delay_ms, cacheTtlHours: metadata.cache_ttl });
    if (!response.ok) continue;
    output.push(...parseRecords(recordsFromPayload(response.text), context, url, metadata.name).map(candidate => ({ ...candidate, source_type: metadata.source_type })));
  }
  return output;
}

function parseLocalAuthorityRecords(records, context, sourceUrl) {
  return parseRecords(records, context, sourceUrl, metadata.name).map(candidate => ({ ...candidate, source_type: metadata.source_type }));
}

module.exports = { metadata, discover, parseLocalAuthorityRecords };
