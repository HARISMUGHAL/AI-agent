'use strict';

const cheerio = require('cheerio');
const { respectfulFetch } = require('./httpClient');
const { normalizeEmail, normalizePhone } = require('../utils/normalizers');
const { safeHyperlink } = require('../utils/formulaSanitizer');

function normalizeCandidate(input = {}) {
  const candidate = {
    source_name: String(input.source_name || ''), source_type: String(input.source_type || ''),
    source_url: safeHyperlink(input.source_url), source_listing_id: String(input.source_listing_id || ''),
    business_name: String(input.business_name || '').trim(), category: String(input.category || '').trim(), business_type: String(input.business_type || '').trim(),
    city: String(input.city || '').trim(), state_or_region: String(input.state_or_region || '').trim(), postcode: String(input.postcode || '').trim(),
    country: String(input.country || '').trim(), address: String(input.address || '').trim(), phone: String(input.phone || '').trim(),
    email: normalizeEmail(input.email), website: safeHyperlink(input.website), contact_page_url: safeHyperlink(input.contact_page_url),
    company_number: String(input.company_number || '').trim(), raw_record: input.raw_record || null,
    primary_source: String(input.primary_source || input.source_name || ''),
    primary_source_type: String(input.primary_source_type || input.source_type || ''),
    primary_source_url: safeHyperlink(input.primary_source_url || input.source_url),
    phone_source_url: safeHyperlink(input.phone_source_url), email_source_url: safeHyperlink(input.email_source_url),
    rating: Number(input.rating ?? input.raw_record?.rating ?? 0), review_count: Number(input.review_count ?? input.raw_record?.review_count ?? 0),
    category_confirmed: !!input.category_confirmed, official_profile_verified: !!input.official_profile_verified,
    evidence: Array.isArray(input.evidence) ? input.evidence : []
  };
  return candidate;
}

function sourceMetadata(adapter) { return { ...adapter.metadata }; }

function createRegistry() {
  const googlePlaces = require('./googlePlacesSource');
  const openData = require('./openDataSource');
  const localAuthority = require('./localAuthoritySource');
  const overpass = require('./overpassSource');
  const manualSeeds = require('./manualSeedSource');
  googlePlaces.metadata.enabled = googlePlaces.isConfigured() && String(process.env.GOOGLE_PLACES_ENABLED || 'true') === 'true';
  overpass.metadata.enabled = String(process.env.OVERPASS_ENABLED || 'true') === 'true'
    && String(process.env.FREE_SOURCE_FALLBACK_ENABLED || 'true') === 'true';
  return [googlePlaces, localAuthority, openData, overpass, manualSeeds];
}

function enabledAdapters(country, registry = createRegistry()) {
  const code = country === 'United States' ? 'US' : 'UK';
  const priorities = code === 'US'
    ? ['Open Data', 'Local Authority', 'Overpass', 'Manual']
    : ['Local Authority', 'Open Data', 'Overpass', 'Manual'];
  const rank = adapter => {
    const type = String(adapter.metadata.source_type || '').toLowerCase();
    const name = `${adapter.metadata.name} ${type}`.toLowerCase();
    if (type === 'google_places') return -1;
    if (type === 'user_seed') return 3;
    if (name.includes('overpass')) return 2;
    if (code === 'UK' && type === 'licensing_register') return 0;
    if (type === 'government') return code === 'US' ? 0 : 1;
    const index = priorities.findIndex(value => name.includes(value.toLowerCase()));
    return index < 0 ? priorities.length : index;
  };
  return registry.filter(adapter => adapter.metadata.enabled && (adapter.metadata.country.includes(code) || adapter.metadata.country.includes(',')))
    .sort((a, b) => rank(a) - rank(b));
}

function parseOfficialProfile($) {
  const profiles = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed]);
      profiles.push(...items.filter(Boolean));
    } catch { /* malformed publisher JSON-LD */ }
  });
  const profile = profiles.find(item => {
    const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
    return types.some(type => /organization|localbusiness|professionalservice|store|restaurant/i.test(String(type || '')));
  }) || profiles.find(item => item?.name && (item?.address || item?.telephone || item?.email)) || {};
  const addressValue = typeof profile.address === 'string' ? profile.address : [
    profile.address?.streetAddress, profile.address?.addressLocality, profile.address?.addressRegion,
    profile.address?.postalCode, profile.address?.addressCountry
  ].filter(Boolean).join(', ');
  return {
    name: String(profile.name || $('meta[property="og:site_name"]').attr('content') || $('title').text().split(/[|–—-]/)[0] || '').trim(),
    phone: String(profile.telephone || '').trim(), email: normalizeEmail(profile.email), address: String(addressValue || '').trim()
  };
}

function discardUnverifiedGoogleContent(candidate) {
  return {
    ...candidate, business_name: '', address: '', phone: '', email: '', website: '', contact_page_url: '',
    source_name: 'Google Maps Places', source_type: 'google_place_id', source_url: '',
    primary_source: 'Google Maps Place ID', primary_source_type: 'google_place_id', primary_source_url: '',
    phone_source_url: '', email_source_url: '', rating: 0, review_count: 0, category_confirmed: false,
    official_profile_verified: false, website_verified: false, raw_record: null, evidence: []
  };
}

async function enrichOfficialWebsite(candidate) {
  const googleDiscovered = candidate.source_type === 'google_places';
  if (!candidate.website) return googleDiscovered ? discardUnverifiedGoogleContent(candidate) : { ...candidate, website_verified: false };
  try {
    const response = await respectfulFetch(candidate.website, { accept: 'text/html,*/*;q=0.5', cacheTtlHours: 24 });
    if (!response.ok || !response.text) return googleDiscovered ? discardUnverifiedGoogleContent(candidate) : { ...candidate, website_verified: false };
    const $ = cheerio.load(response.text);
    const official = parseOfficialProfile($);
    const pageText = $('body').text().replace(/\s+/g, ' ');
    const titleText = `${$('title').text()} ${pageText.slice(0, 5000)}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const nameTokens = candidate.business_name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(token => token.length > 2);
    const nameMatch = nameTokens.length > 0 && nameTokens.filter(token => titleText.includes(token)).length >= Math.min(2, nameTokens.length);
    if (!nameMatch) return googleDiscovered ? { ...discardUnverifiedGoogleContent(candidate), website_conflict: true } : { ...candidate, website: '', website_verified: false, website_conflict: true };
    let email = googleDiscovered ? official.email : candidate.email;
    if (!email) {
      const mailto = $('a[href^="mailto:"]').first().attr('href');
      email = normalizeEmail(mailto ? mailto.replace(/^mailto:/i, '').split('?')[0] : '');
    }
    let phone = googleDiscovered ? official.phone : candidate.phone;
    if (!phone) {
      const tel = $('a[href^="tel:"]').first().attr('href');
      phone = tel ? tel.replace(/^tel:/i, '').trim() : '';
    }
    let contactPage = googleDiscovered ? '' : candidate.contact_page_url;
    if (!contactPage) {
      const href = $('a').filter((_, element) => /contact/i.test($(element).text())).first().attr('href');
      if (href) { try { contactPage = new URL(href, response.url).href; } catch { /* blank */ } }
    }
    const verified = {
      ...candidate, website: response.url, website_verified: true, email, phone,
      category_confirmed: String(candidate.category || '').toLowerCase().split(/\s+/).filter(token => token.length > 3).some(token => titleText.includes(token)),
      contact_page_url: safeHyperlink(contactPage), website_source_url: candidate.source_url,
      phone_source_url: phone ? response.url : candidate.phone_source_url || '', email_source_url: email ? response.url : candidate.email_source_url || '',
      verified_at: new Date().toISOString(), parser_version: 'official-website-v1'
    };
    if (!googleDiscovered) return verified;
    return {
      ...verified,
      business_name: official.name || candidate.business_name,
      address: official.address || '', rating: 0, review_count: 0, raw_record: null,
      source_name: 'Official website', source_type: 'official_website', source_url: response.url,
      primary_source: 'Official website', primary_source_type: 'official_website', primary_source_url: response.url,
      phone_source_url: phone ? response.url : '', email_source_url: email ? response.url : '',
      official_profile_verified: false,
      evidence: [{ field: 'business_name', value: official.name || candidate.business_name, source_name: 'Official website', source_type: 'official_website', url: response.url }]
    };
  } catch { return googleDiscovered ? discardUnverifiedGoogleContent(candidate) : { ...candidate, website_verified: false }; }
}

async function discoverCandidates({ dataset, locations, categories, seeds = [], limit, registry, checkpoint = {}, onProgress = () => {}, shouldPause = () => false, isCompleted = () => false, markCompleted = () => {} }) {
  const country = dataset === 'US' ? 'United States' : 'United Kingdom';
  const adapters = enabledAdapters(country, registry);
  const automaticAdapters = adapters.filter(adapter => adapter.metadata.source_type !== 'user_seed');
  if (automaticAdapters.length === 0 && seeds.length === 0) return { candidates: [], exhausted: true, stopped_reason: 'source_configuration_required' };
  const candidates = [];
  const maxQueries = Number(process.env.DISCOVERY_TEST_MODE === 'true' ? 4 : process.env.MAX_DISCOVERY_QUERIES || 100);
  let queries = 0;
  let errorCount = 0;
  let resumed = !checkpoint.source;
  for (const adapter of adapters) {
    let adapterUnavailable = false;
    for (const location of locations) {
      for (const category of categories) {
        if (adapter.metadata.source_type === 'user_seed' && (location !== locations[0] || category !== categories[0])) continue;
        if (isCompleted(adapter.metadata.name, location, category)) continue;
        if (!resumed) {
          resumed = checkpoint.source === adapter.metadata.name && checkpoint.city === location && checkpoint.category === category;
          if (!resumed) continue;
        }
        if (shouldPause() || queries >= maxQueries || candidates.length >= limit) return { candidates, exhausted: false, stopped_reason: shouldPause() ? 'paused' : 'safe query/candidate ceiling reached' };
        const context = { dataset, country, location, category, limit: Math.min(Number(process.env.MAX_CANDIDATES_PER_SOURCE_QUERY || 100), limit - candidates.length), seeds };
        onProgress({ event: 'query_started', source: adapter.metadata.name, city: location, category, country, queries, candidates_found: candidates.length });
        const before = candidates.length;
        let succeeded = false;
        try {
          const found = await adapter.discover(context);
          for (const raw of found) {
            const candidate = normalizeCandidate(raw);
            if (candidate.source_url && candidate.business_name) candidates.push(candidate);
            if (candidates.length >= limit) break;
          }
          succeeded = true;
        } catch (error) {
          errorCount++;
          adapterUnavailable = error.retryable === false;
          onProgress({ event: adapterUnavailable ? 'source_blocked' : 'source_error', source: adapter.metadata.name, city: location, category, country, last_error: error.message, last_error_code: error.code || '', last_http_status: error.httpStatus || 0, source_retryable: !!error.retryable, error_count: errorCount, queries });
        }
        queries++;
        if (succeeded) markCompleted(adapter.metadata.name, location, category, candidates.length - before);
        onProgress({ event: succeeded ? 'query_completed' : (adapterUnavailable ? 'query_blocked' : 'query_failed'), source: adapter.metadata.name, city: location, category, country, queries, candidates_found: candidates.length, candidates_added: candidates.length - before, error_count: errorCount, checkpoint: true });
        if (adapterUnavailable) break;
      }
      if (adapterUnavailable) break;
    }
  }
  return { candidates, exhausted: true, error_count: errorCount, stopped_reason: candidates.length < limit ? 'all enabled source/location/category combinations exhausted' : '' };
}

module.exports = { normalizeCandidate, sourceMetadata, createRegistry, enabledAdapters, enrichOfficialWebsite, discoverCandidates, discardUnverifiedGoogleContent, parseOfficialProfile };
