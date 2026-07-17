/**
 * googleMaps.js — Lead Discovery
 * Zynqora Edge — Data collection + legacy outreach modes
 */

const {
  insertLead,
  insertQualifiedLead,
  checkDuplicate,
  checkDuplicateByEmail,
  checkDuplicateByPhone,
  checkDuplicateByDomain,
  checkEmailSentBefore,
  isSearchCombinationDone,
  recordSearchCombination,
  updateRunProgress,
  isDataCollectionOnly
} = require('../database/db');
const { scrapeEmailFromWebsite, auditWebsite } = require('./websiteScraper');
const { qualifyLeadForDataMode, MIN_LEAD_SCORE } = require('./leadScorer');

const US_CITIES = [
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ',
  'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'Austin, TX',
  'Jacksonville, FL', 'San Francisco, CA', 'Columbus, OH', 'Charlotte, NC', 'Seattle, WA',
  'Denver, CO', 'Boston, MA', 'Nashville, TN', 'Detroit, MI', 'Portland, OR'
];

const UK_CITIES = [
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow',
  'Liverpool', 'Bristol', 'Sheffield', 'Edinburgh', 'Cardiff',
  'Belfast', 'Newcastle', 'Nottingham', 'Southampton', 'Brighton'
];

const DATA_NICHES = [
  'restaurants', 'dental clinics', 'medical clinics', 'aesthetic clinics', 'salons',
  'spas', 'barbershops', 'gyms', 'real estate agencies', 'law firms',
  'auto repair shops', 'home services', 'property management', 'local retail stores',
  'appointment-based services', 'professional services'
];

const MIN_RATING = 3.5;
const MAX_RATING = 4.8;
const MIN_REVIEWS = 5;

const US_PATTERNS = ['united states', 'usa', 'u.s.', ' u.s ', ', us', ' us'];
const UK_PATTERNS = ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'];

const BLOCKED_TYPES = ['government', 'charity', 'nonprofit', 'franchise'];

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(trimmed)) return false;
  const junkPatterns = [
    'example.com', 'test.com', 'noreply', 'no-reply', 'donotreply',
    'sentry.io', 'wix.com', 'squarespace.com', 'wordpress.com',
    '@localhost', '.png', '.jpg', '.gif', 'privacy@', 'legal@',
    'abuse@', 'postmaster@', 'webmaster@', 'support@', 'info@google'
  ];
  return !junkPatterns.some(p => trimmed.includes(p));
}

function parseAddress(formattedAddress, cityHint, country) {
  const parts = (formattedAddress || '').split(',').map(s => s.trim());
  let city = cityHint || '';
  let stateOrRegion = '';
  if (country === 'United States' && parts.length >= 2) {
    city = city || parts[parts.length - 3] || parts[0];
    stateOrRegion = parts[parts.length - 2] || '';
  } else if (country === 'United Kingdom' && parts.length >= 2) {
    city = city || parts[parts.length - 3] || parts[0];
    stateOrRegion = parts[parts.length - 2] || '';
  }
  return { city, state_or_region: stateOrRegion, country };
}

function detectCountry(locationString, city) {
  const lower = `${locationString || ''} ${city || ''}`.toLowerCase();
  if (US_PATTERNS.some(p => lower.includes(p)) || /, [A-Z]{2}\b/.test(locationString || '')) {
    return 'United States';
  }
  if (UK_PATTERNS.some(p => lower.includes(p))) return 'United Kingdom';
  return null;
}

function isAllowedCountry(locationString, city) {
  return !!detectCountry(locationString, city);
}

function extractDomain(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function qualityFilterDataMode(lead) {
  const rating = parseFloat(lead.rating) || 0;
  if (rating < MIN_RATING) return { pass: false, reason: `rating ${rating} below ${MIN_RATING}` };
  if (rating > MAX_RATING) return { pass: false, reason: `rating ${rating} too high` };
  const reviews = parseInt(lead.review_count, 10) || 0;
  if (reviews < MIN_REVIEWS) return { pass: false, reason: `only ${reviews} reviews` };
  if (!isAllowedCountry(lead.address || lead.location, lead.city)) {
    return { pass: false, reason: 'outside US/UK' };
  }
  const nameLower = (lead.business_name || '').toLowerCase();
  if (BLOCKED_TYPES.some(t => nameLower.includes(t))) {
    return { pass: false, reason: 'blocked business type' };
  }
  if (lead.operating_status === 'CLOSED_PERMANENTLY') {
    return { pass: false, reason: 'permanently closed' };
  }
  return { pass: true, reason: 'passed' };
}

async function searchBusinesses(query, niche, location, quota = 20, pageToken = null) {
  if (isDataCollectionOnly()) {
    return { places: [], nextPageToken: null, error: true, disabled: true, message: 'Paid Google Maps discovery is disabled in data-only mode.' };
  }
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || apiKey === 'your_google_maps_api_key_here') {
    console.error('❌ Google Maps API Key is missing or invalid.');
    return { places: [], nextPageToken: null };
  }

  const pageSize = Math.min(quota, 20);
  try {
    const body = { textQuery: `${query} in ${location}`, pageSize };
    if (pageToken) body.pageToken = pageToken;

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress',
          'places.websiteUri', 'places.nationalPhoneNumber', 'places.rating',
          'places.userRatingCount', 'places.businessStatus', 'nextPageToken'
        ].join(',')
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('❌ Google Maps API error:', err.error?.message || response.statusText);
      return { places: [], nextPageToken: null, error: true };
    }

    const data = await response.json();
    return { places: data.places || [], nextPageToken: data.nextPageToken || null };
  } catch (error) {
    console.error(`❌ Error searching Google Maps:`, error.message);
    return { places: [], nextPageToken: null, error: true };
  }
}

async function processPlaceForDataMode(place, niche, city, country, runId, counters, sheetEmails) {
  if (checkDuplicate(place.id)) {
    counters.duplicates++;
    return null;
  }

  const address = place.formattedAddress || '';
  const parsed = parseAddress(address, city, country);
  const domain = extractDomain(place.websiteUri);

  if (place.websiteUri && checkDuplicateByDomain(domain)) {
    counters.duplicates++;
    return null;
  }

  const audit = await auditWebsite(place.websiteUri || '');
  let email = audit.email || '';
  if (!email && place.websiteUri) {
    email = await scrapeEmailFromWebsite(place.websiteUri) || '';
  }

  const lead = {
    place_id: place.id,
    business_name: place.displayName?.text || 'Unknown Business',
    niche,
    location: `${parsed.city}, ${country}`,
    address,
    website: place.websiteUri || '',
    phone: place.nationalPhoneNumber || '',
    email: email.trim(),
    rating: place.rating || 0,
    review_count: place.userRatingCount || 0,
    city: parsed.city,
    state_or_region: parsed.state_or_region,
    country,
    google_maps_url: `https://www.google.com/maps/place/?q=place_id:${place.id}`,
    operating_status: place.businessStatus || 'OPERATIONAL',
    owner_or_contact_name: '',
    run_id: runId
  };

  const quality = qualityFilterDataMode(lead);
  if (!quality.pass) {
    counters.rejected_quality++;
    return null;
  }

  if (lead.email && sheetEmails.has(lead.email.toLowerCase())) {
    counters.duplicates++;
    return null;
  }
  if (lead.email && checkDuplicateByEmail(lead.email)) {
    counters.duplicates++;
    return null;
  }
  if (checkDuplicateByPhone(lead.phone, lead.business_name)) {
    counters.duplicates++;
    return null;
  }

  const qualification = qualifyLeadForDataMode(lead, audit);

  if (!lead.email && !(lead.phone && qualification.lead_score >= 80)) {
    counters.rejected_quality++;
    return null;
  }

  if (!qualification.passed) {
    counters.rejected_score++;
    return null;
  }

  const qualified = {
    ...lead,
    ...qualification,
    email: lead.email || '',
    contact_method: lead.email ? 'email' : 'phone',
    status: 'qualified',
    data_source: 'google_maps',
    verification_status: 'pending',
    outreach_status: 'not_contacted'
  };

  insertQualifiedLead(qualified);
  counters.qualified++;
  if (country === 'United States') counters.us_count++;
  else if (country === 'United Kingdom') counters.uk_count++;

  return qualified;
}

async function runDataDiscovery(options = {}) {
  const target = options.target || parseInt(process.env.QUALIFIED_LEAD_TARGET_PER_DAY || '500', 10);
  const usTarget = parseInt(process.env.US_TARGET_ROWS || '300', 10);
  const ukTarget = parseInt(process.env.UK_TARGET_ROWS || '200', 10);
  const runId = options.runId;
  const onProgress = options.onProgress || (() => {});

  const counters = {
    fetched: 0, raw_found: 0, audited: 0, rejected_quality: 0, rejected_score: 0,
    duplicates: 0, qualified: 0, synced: 0, us_count: 0, uk_count: 0, api_errors: 0
  };

  const { getExistingSheetEmails } = require('./googleSheets');
  const sheetEmails = await getExistingSheetEmails();

  const combinations = [];
  for (const city of US_CITIES) {
    for (const niche of DATA_NICHES) combinations.push({ country: 'United States', city, niche });
  }
  for (const city of UK_CITIES) {
    for (const niche of DATA_NICHES) combinations.push({ country: 'United Kingdom', city, niche });
  }

  console.log(`\n🔍 DATA DISCOVERY — target: ${target} (US: ${usTarget}, UK: ${ukTarget})`);

  for (const combo of combinations) {
    if (counters.qualified >= target) break;
    if (combo.country === 'United States' && counters.us_count >= usTarget) continue;
    if (combo.country === 'United Kingdom' && counters.uk_count >= ukTarget) continue;

    let pageToken = null;
    let pagesDone = 0;

    do {
      if (isSearchCombinationDone(runId, combo.country, combo.city, combo.niche, pageToken || '')) {
        pageToken = null;
        break;
      }

      const { places, nextPageToken, error } = await searchBusinesses(
        combo.niche, combo.niche, `${combo.city}, ${combo.country}`, 20, pageToken
      );

      if (error) {
        counters.api_errors++;
        updateRunProgress(runId, { checkpoint_data: { combo, counters }, status: 'paused' });
        onProgress({ ...counters, status: 'paused', current_country: combo.country, current_city: combo.city, current_niche: combo.niche });
        return counters;
      }

      counters.fetched += places.length;
      counters.raw_found += places.length;
      recordSearchCombination(runId, combo.country, combo.city, combo.niche, pageToken || '');

      for (const place of places) {
        if (counters.qualified >= target) break;
        if (combo.country === 'United States' && counters.us_count >= usTarget) break;
        if (combo.country === 'United Kingdom' && counters.uk_count >= ukTarget) break;

        counters.audited++;
        const result = await processPlaceForDataMode(place, combo.niche, combo.city, combo.country, runId, counters, sheetEmails);
        if (result?.email) sheetEmails.add(result.email.toLowerCase());

        onProgress({
          ...counters,
          target,
          remaining: target - counters.qualified,
          current_country: combo.country,
          current_city: combo.city,
          current_niche: combo.niche,
          progress_pct: Math.round((counters.qualified / target) * 100)
        });
      }

      pageToken = nextPageToken;
      pagesDone++;
      if (pageToken) await new Promise(r => setTimeout(r, 2000));
    } while (pageToken && pagesDone < 3 && counters.qualified < target);

    updateRunProgress(runId, {
      qualified_count: counters.qualified,
      us_count: counters.us_count,
      uk_count: counters.uk_count,
      checkpoint_data: { lastCombo: combo, counters }
    });

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`📊 DATA DISCOVERY COMPLETE — qualified: ${counters.qualified}, US: ${counters.us_count}, UK: ${counters.uk_count}`);
  return counters;
}

// ─── Legacy outreach discovery ───────────────────────────────────────────────

const ALLOWED_REGIONS = [
  'united arab emirates', 'uae', 'saudi arabia', 'ksa', 'qatar',
  'united kingdom', 'uk', 'canada', 'italy', 'spain',
  'netherlands', 'sweden', 'poland', 'australia'
];

function isRegionAllowed(locationString) {
  if (!locationString) return false;
  const lower = locationString.toLowerCase();
  return ALLOWED_REGIONS.some(region => lower.includes(region));
}

function qualityFilter(lead) {
  if (!isValidEmail(lead.email)) return { pass: false, reason: 'missing or invalid email' };
  const rating = parseFloat(lead.rating) || 0;
  if (rating < MIN_RATING) return { pass: false, reason: `rating ${rating} below minimum ${MIN_RATING}` };
  if (rating > MAX_RATING) return { pass: false, reason: `rating ${rating} above maximum ${MAX_RATING}` };
  const reviews = parseInt(lead.review_count, 10) || 0;
  if (reviews < MIN_REVIEWS) return { pass: false, reason: `only ${reviews} reviews` };
  if (!lead.website && rating > 4.2) return { pass: false, reason: 'no website and rating too high' };
  if (!isRegionAllowed(lead.address) && !isRegionAllowed(lead.location)) {
    return { pass: false, reason: 'region blocked' };
  }
  return { pass: true, reason: 'passed' };
}

function preScore(lead) {
  let score = 0;
  if (lead.website) score += 20;
  const rating = parseFloat(lead.rating) || 0;
  if (rating >= 3.5 && rating <= 4.2) score += 20;
  else if (rating > 4.2 && rating <= 4.8) score += 10;
  const reviews = parseInt(lead.review_count, 10) || 0;
  if (reviews >= 20) score += 15;
  else if (reviews >= 5) score += 8;
  const signalCount = [lead.phone, lead.website, lead.email, lead.address].filter(Boolean).length;
  if (signalCount >= 3) score += 15;
  else if (signalCount === 2) score += 8;
  if (lead.phone) score += 10;
  const nicheL = (lead.niche || '').toLowerCase();
  const TARGET_NICHES_BONUS = ['restaurant', 'salon', 'clinic', 'gym', 'real estate', 'dental', 'spa', 'law', 'auto repair', 'tutoring', 'pet grooming'];
  if (TARGET_NICHES_BONUS.some(n => nicheL.includes(n))) score += 10;
  if (lead.location) score += 10;
  return Math.min(100, score);
}

async function runDiscovery(quotaNeeded = 50) {
  if (isDataCollectionOnly()) {
    console.log('⚠️  Data collection mode — use runDataDiscovery via scheduler.');
    return 0;
  }

  const niches = (process.env.TARGET_NICHES || 'restaurants').split(',').map(s => s.trim());
  const locations = (process.env.TARGET_LOCATIONS || 'New York').split(',').map(s => s.trim());
  const stats = { fetched: 0, valid: 0, duplicates: 0, rejected_quality: 0, rejected_score: 0, saved: 0, leads: [] };
  const fetchBuffer = Math.ceil(quotaNeeded * 1.30);
  const perNiche = Math.ceil(fetchBuffer / (niches.length * locations.length)) || 5;

  for (const location of locations) {
    for (const niche of niches) {
      if (stats.saved >= quotaNeeded) break;
      const { places } = await searchBusinesses(niche, niche, location, perNiche);
      stats.fetched += places.length;

      for (const place of places) {
        if (stats.saved >= quotaNeeded) break;
        if (checkDuplicate(place.id)) { stats.duplicates++; continue; }

        let extractedEmail = '';
        if (place.websiteUri) extractedEmail = await scrapeEmailFromWebsite(place.websiteUri) || '';

        const lead = {
          place_id: place.id,
          business_name: place.displayName?.text || 'Unknown Business',
          niche, location,
          address: place.formattedAddress || '',
          website: place.websiteUri || '',
          phone: place.nationalPhoneNumber || '',
          email: (extractedEmail || '').trim(),
          rating: place.rating || 0,
          review_count: place.userRatingCount || 0
        };

        const quality = qualityFilter(lead);
        if (!quality.pass) { stats.rejected_quality++; continue; }
        if (checkEmailSentBefore(lead.email)) { stats.duplicates++; continue; }
        if (preScore(lead) < MIN_LEAD_SCORE) { stats.rejected_score++; continue; }

        try {
          insertLead(lead);
          stats.saved++;
          stats.valid++;
        } catch (e) {
          stats.duplicates++;
        }
      }
      if (stats.saved < quotaNeeded) await new Promise(r => setTimeout(r, 1000));
    }
    if (stats.saved >= quotaNeeded) break;
  }

  return stats.saved;
}

module.exports = {
  searchBusinesses,
  runDiscovery,
  runDataDiscovery,
  isValidEmail,
  isAllowedCountry,
  detectCountry,
  parseAddress,
  US_CITIES,
  UK_CITIES,
  DATA_NICHES
};
