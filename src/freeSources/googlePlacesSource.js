'use strict';

const { normalizeCandidate } = require('./sourceRegistry');

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.googleMapsUri',
  'places.websiteUri', 'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
  'places.rating', 'places.userRatingCount', 'places.businessStatus', 'places.primaryType',
  'places.primaryTypeDisplayName', 'nextPageToken'
].join(',');

function isConfigured() {
  const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  return !!key && key !== 'your_google_maps_api_key_here';
}

const metadata = {
  name: 'Google Maps Places', country: 'US,UK', categories: ['target niches'],
  base_url: ENDPOINT, source_type: 'google_places', enabled: true, requires_key: true,
  paid: true, request_delay_ms: 250, concurrency: 1, cache_ttl: 0, provenance_strength: 5
};

function apiError(message, status = 0, code = '') {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code || (status ? `HTTP_${status}` : 'GOOGLE_PLACES_ERROR');
  error.retryable = status === 429 || status >= 500 || status === 0;
  return error;
}

function parsePlaces(data, context = {}) {
  return (data.places || []).map(place => {
    const sourceUrl = place.googleMapsUri || (place.id ? `https://www.google.com/maps/place/?q=place_id:${place.id}` : '');
    return normalizeCandidate({
    source_name: metadata.name,
    source_type: metadata.source_type,
    source_url: sourceUrl,
    source_listing_id: place.id ? `google:${place.id}` : '',
    business_name: place.displayName?.text || '',
    category: context.category || '',
    business_type: context.category || '',
    city: context.location || '',
    country: context.country || '',
    address: '',
    phone: '',
    website: place.websiteUri || '',
    phone_source_url: '',
    category_confirmed: false,
    official_profile_verified: true,
    rating: 0, review_count: 0,
    evidence: [],
    raw_record: {
      transient_google_content: true, place_id: place.id || '', rating: Number(place.rating || 0),
      review_count: Number(place.userRatingCount || 0), business_status: place.businessStatus || '',
      primary_type: place.primaryType || '', formatted_address: place.formattedAddress || '',
      phone: place.internationalPhoneNumber || place.nationalPhoneNumber || ''
    }
  });
  }).filter(candidate => candidate.business_name && candidate.source_url);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function searchText(context = {}) {
  if (!isConfigured()) throw apiError('Google Maps API key is not configured.', 0, 'GOOGLE_MAPS_KEY_MISSING');
  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY).trim();
  const pageSize = Math.min(20, Math.max(1, Number(context.limit || 20)));
  const retries = Math.max(0, Number(process.env.GOOGLE_PLACES_RETRIES || 3));
  const timeoutMs = Math.max(5000, Number(process.env.GOOGLE_PLACES_TIMEOUT_MS || 20000));
  const body = { textQuery: `${context.category} in ${context.location}, ${context.country}`, pageSize };
  if (context.pageToken) body.pageToken = context.pageToken;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return { data: payload, attempts: attempt + 1, status: response.status };
      const message = payload.error?.message || `Google Places returned HTTP ${response.status}`;
      lastError = apiError(message, response.status, payload.error?.status || '');
      if (!lastError.retryable) throw lastError;
      const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
      if (attempt < retries) await sleep(Math.max(retryAfter, Math.min(15000, 1000 * (2 ** attempt))));
    } catch (error) {
      if (error.name === 'AbortError') lastError = apiError(`Google Places request timed out after ${timeoutMs}ms`, 0, 'GOOGLE_PLACES_TIMEOUT');
      else lastError = error.httpStatus !== undefined ? error : apiError(error.message || 'Google Places network error');
      if (!lastError.retryable || attempt >= retries) throw lastError;
      await sleep(Math.min(15000, 1000 * (2 ** attempt)));
    } finally { clearTimeout(timeout); }
  }
  throw lastError || apiError('Google Places request failed.');
}

async function discover(context) {
  const limit = Math.max(1, Number(context.limit || 20));
  const maxPages = Math.max(1, Math.min(3, Number(process.env.GOOGLE_PLACES_MAX_PAGES || 3)));
  const pageDelayMs = Math.max(0, Number(process.env.GOOGLE_PLACES_PAGE_DELAY_MS || 1000));
  const found = [];
  const seen = new Set();
  let pageToken = '';
  for (let page = 0; page < maxPages && found.length < limit; page++) {
    const result = await searchText({ ...context, pageToken, limit: Math.min(20, limit - found.length) });
    for (const candidate of parsePlaces(result.data, context)) {
      if (!seen.has(candidate.source_listing_id)) { seen.add(candidate.source_listing_id); found.push(candidate); }
      if (found.length >= limit) break;
    }
    pageToken = result.data.nextPageToken || '';
    if (!pageToken) break;
    if (pageDelayMs) await sleep(pageDelayMs);
  }
  return found;
}

module.exports = { metadata, isConfigured, parsePlaces, searchText, discover, FIELD_MASK, ENDPOINT };
