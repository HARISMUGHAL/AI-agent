'use strict';

const { normalizeCandidate } = require('./sourceRegistry');

const metadata = {
  name: 'Optional Manual Seeds', country: 'US,UK', categories: ['all'], base_url: '', source_type: 'user_seed',
  enabled: true, requires_key: false, request_delay_ms: 0, concurrency: 1, cache_ttl: 0, provenance_strength: 2
};

async function discover({ seeds = [], country }) {
  return seeds.map(seed => normalizeCandidate({ ...seed, country: seed.country || country, source_name: seed.source_name || metadata.name, source_type: seed.source_type || metadata.source_type }));
}

module.exports = { metadata, discover };
