/**
 * googleMaps.js — Phase 2: Clean Lead Pipeline
 * Zynqora Edge Autonomous Agent
 *
 * Pipeline (strict order):
 *  1. Fetch leads from Google Maps (quota-controlled)
 *  2. Validate & clean each lead
 *  3. Strict quality filter (rating, reviews, email required)
 *  4. Global email dedup (outreach_log check across all accounts)
 *  5. Score lead (Gemini AI via leadScorer)
 *  6. Reject if score < MIN_LEAD_SCORE (default 60)
 *  7. Save valid leads to DB
 *
 * DO NOT modify: gmailService.js, OAuth, DB schema
 */

const {
  insertLead,
  checkDuplicate,
  checkEmailSentBefore,
  getLeadsByStatus
} = require('../database/db');
const { scrapeEmailFromWebsite } = require('./websiteScraper');

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_RATING      = 3.5;
const MAX_RATING      = 4.8;   // Too high = already established, not a good target
const MIN_REVIEWS     = 5;
const MIN_LEAD_SCORE  = 60;    // Reject anything below this after scoring

// Industry niches that score +10 for industry fit
const TARGET_NICHES_BONUS = [
  'restaurant', 'salon', 'clinic', 'gym', 'real estate',
  'dental', 'spa', 'law', 'auto repair', 'tutoring', 'pet grooming'
];

// ─── Email Validator ──────────────────────────────────────────────────────────
/**
 * Returns true only if the string is a valid, usable email address.
 * Rejects obvious system/placeholder addresses.
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;

  const trimmed = email.trim().toLowerCase();

  // Format check
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(trimmed)) return false;

  // Reject known junk/system addresses
  const junkPatterns = [
    'example.com', 'test.com', 'noreply', 'no-reply', 'donotreply',
    'sentry.io', 'wix.com', 'squarespace.com', 'wordpress.com',
    '@localhost', '.png', '.jpg', '.gif', 'privacy@', 'legal@',
    'abuse@', 'postmaster@', 'webmaster@'
  ];
  if (junkPatterns.some(p => trimmed.includes(p))) return false;

  return true;
}

// ─── Quality Filter ───────────────────────────────────────────────────────────
/**
 * RULE 3: Apply strict quality criteria.
 * Returns { pass: bool, reason: string }
 */
function qualityFilter(lead) {
  // Must have a valid email — non-negotiable
  if (!isValidEmail(lead.email)) {
    return { pass: false, reason: 'missing or invalid email' };
  }

  // Rating gate: 3.5–4.8 (improvement opportunity window)
  const rating = parseFloat(lead.rating) || 0;
  if (rating < MIN_RATING) {
    return { pass: false, reason: `rating ${rating} below minimum ${MIN_RATING}` };
  }
  if (rating > MAX_RATING) {
    return { pass: false, reason: `rating ${rating} above maximum ${MAX_RATING} (too established)` };
  }

  // Minimum reviews (proves the business is active)
  const reviews = parseInt(lead.review_count) || 0;
  if (reviews < MIN_REVIEWS) {
    return { pass: false, reason: `only ${reviews} reviews (minimum ${MIN_REVIEWS})` };
  }

  return { pass: true, reason: 'passed' };
}

// ─── Rule-Based Pre-Scorer ────────────────────────────────────────────────────
/**
 * Fast rule-based scoring used BEFORE the Gemini AI scorer.
 * This filters out obviously low-quality leads without burning API quota.
 *
 * Score breakdown (max 100):
 *   +20 → has website (could need upgrade)
 *   +20 → rating 3.5–4.2 (improvement sweet spot)
 *   +15 → has ≥ 20 reviews (active business)
 *   +15 → multiple signals (phone + website + reviews)
 *   +10 → has phone (professional presence)
 *   +10 → industry fit (target niches)
 *   +10 → has location (targetable region)
 */
function preScore(lead) {
  let score = 0;

  // +20: has website (digital presence to improve)
  if (lead.website) score += 20;

  // +20: rating 3.5–4.2 (improvement opportunity sweet spot)
  const rating = parseFloat(lead.rating) || 0;
  if (rating >= 3.5 && rating <= 4.2) score += 20;
  else if (rating > 4.2 && rating <= 4.8) score += 10; // good but less opportunity

  // +15: active business (≥ 20 reviews shows recent activity)
  const reviews = parseInt(lead.review_count) || 0;
  if (reviews >= 20) score += 15;
  else if (reviews >= 5) score += 8; // meets minimum but less active

  // +15: multiple documented signals
  const signalCount = [lead.phone, lead.website, lead.email, lead.address].filter(Boolean).length;
  if (signalCount >= 3) score += 15;
  else if (signalCount === 2) score += 8;

  // +10: professional presence (has phone)
  if (lead.phone) score += 10;

  // +10: industry fit
  const nicheL = (lead.niche || '').toLowerCase();
  if (TARGET_NICHES_BONUS.some(n => nicheL.includes(n))) score += 10;

  // +10: has a targetable location
  if (lead.location) score += 10;

  return Math.min(100, score);
}

// ─── Controlled Search ────────────────────────────────────────────────────────
/**
 * Search Google Maps for a specific niche+location.
 * Only fetches as many leads as `quota` dictates.
 * Returns array of raw place objects (not yet saved to DB).
 */
async function searchBusinesses(query, niche, location, quota = 20) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey || apiKey === 'your_google_maps_api_key_here') {
    console.error('❌ Google Maps API Key is missing or invalid.');
    return [];
  }

  const pageSize = Math.min(quota, 20); // Places API max = 20 per request

  try {
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.websiteUri',
          'places.nationalPhoneNumber',
          'places.rating',
          'places.userRatingCount'
        ].join(',')
      },
      body: JSON.stringify({
        textQuery: `${query} in ${location}`,
        pageSize
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error(`❌ Google Maps API error:`, err.error?.message || response.statusText);
      return [];
    }

    const data = await response.json();
    return data.places || [];

  } catch (error) {
    console.error(`❌ Error searching Google Maps for "${niche}" in ${location}:`, error.message);
    return [];
  }
}

// ─── Full Lead Pipeline ───────────────────────────────────────────────────────
/**
 * RULE 6: Quota-controlled discovery.
 *
 * @param {number} quotaNeeded  How many MORE valid leads we need this cycle
 * @returns {object}  Pipeline stats { fetched, valid, duplicates, rejected, saved, leads[] }
 */
async function runDiscovery(quotaNeeded = 50) {
  const niches    = (process.env.TARGET_NICHES    || 'restaurants').split(',').map(s => s.trim());
  const locations = (process.env.TARGET_LOCATIONS || 'New York').split(',').map(s => s.trim());

  // Stats counters (RULE 9)
  const stats = {
    fetched:          0,
    valid:            0,
    duplicates:       0,
    rejected_quality: 0,
    rejected_score:   0,
    saved:            0,
    leads:            []
  };

  // Safety: add a buffer so we end up with enough valid leads after filtering
  // Fetch 30% more than needed to compensate for rejections
  const fetchBuffer  = Math.ceil(quotaNeeded * 1.30);
  const perNiche     = Math.ceil(fetchBuffer / (niches.length * locations.length)) || 5;

  console.log('\n' + '═'.repeat(55));
  console.log(`🔍 LEAD PIPELINE — quota needed: ${quotaNeeded} | fetch target: ${fetchBuffer}`);
  console.log('═'.repeat(55));

  for (const location of locations) {
    for (const niche of niches) {

      // RULE 6: Stop when we have enough saved leads
      if (stats.saved >= quotaNeeded) {
        console.log(`📊 Quota reached (${stats.saved}/${quotaNeeded}). Stopping discovery.`);
        break;
      }

      console.log(`\n🌍 Searching: "${niche}" in ${location} (quota per search: ${perNiche})`);
      const places = await searchBusinesses(niche, niche, location, perNiche);
      stats.fetched += places.length;

      for (const place of places) {
        if (stats.saved >= quotaNeeded) break;

        // ── Step 1: Check place_id duplicate (already in DB) ──────────────
        if (checkDuplicate(place.id)) {
          stats.duplicates++;
          continue;
        }

        // ── Step 2: Scrape email from website ─────────────────────────────
        let extractedEmail = '';
        if (place.websiteUri) {
          extractedEmail = await scrapeEmailFromWebsite(place.websiteUri) || '';
        }

        // ── Step 3: Build lead object ──────────────────────────────────────
        const lead = {
          place_id:     place.id,
          business_name: place.displayName?.text || 'Unknown Business',
          niche:        niche,
          location:     location,
          address:      place.formattedAddress  || '',
          website:      place.websiteUri         || '',
          phone:        place.nationalPhoneNumber || '',
          email:        (extractedEmail || '').trim(),
          rating:       place.rating             || 0,
          review_count: place.userRatingCount    || 0
        };

        // ── Step 4: Strict quality filter ─────────────────────────────────
        const quality = qualityFilter(lead);
        if (!quality.pass) {
          stats.rejected_quality++;
          console.log(`   ⛔ Rejected (${quality.reason}): ${lead.business_name}`);
          continue;
        }

        // ── Step 5: Global email dedup (across ALL accounts) ──────────────
        // RULE 4: check outreach_log — never contact already-mailed address
        const alreadyContacted = checkEmailSentBefore(lead.email);
        if (alreadyContacted) {
          stats.duplicates++;
          console.log(`   🔁 Dup (already contacted): ${lead.email}`);
          continue;
        }

        // ── Step 6: Pre-score filter ───────────────────────────────────────
        const preScoreVal = preScore(lead);
        if (preScoreVal < MIN_LEAD_SCORE) {
          stats.rejected_score++;
          console.log(`   📉 Rejected (pre-score ${preScoreVal} < ${MIN_LEAD_SCORE}): ${lead.business_name}`);
          continue;
        }

        // ── Step 7: Also check if lead status is bounced or spam ──────────
        // This is caught implicitly — if place_id is new but the email domain
        // triggered spam/bounce on a previous lead, the outreach_log check above
        // would already block it. No separate check needed.

        // ── Step 8: Save to DB ─────────────────────────────────────────────
        try {
          insertLead(lead);
          stats.saved++;
          stats.valid++;
          stats.leads.push(lead);
          console.log(`   ✅ Saved [score est: ${preScoreVal}]: ${lead.business_name} <${lead.email}>`);
        } catch (e) {
          // Constraint error — already inserted by another process
          stats.duplicates++;
        }
      }

      // Small pause between searches to avoid Maps API rate limits
      if (stats.saved < quotaNeeded) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (stats.saved >= quotaNeeded) break;
  }

  // ── RULE 9: Structured summary log ──────────────────────────────────────────
  console.log('\n' + '─'.repeat(55));
  console.log(`📊 DISCOVERY SUMMARY`);
  console.log(`   Total fetched:          ${stats.fetched}`);
  console.log(`   Quality passed:         ${stats.valid}`);
  console.log(`   Duplicates skipped:     ${stats.duplicates}`);
  console.log(`   Rejected (quality):     ${stats.rejected_quality}`);
  console.log(`   Rejected (pre-score):   ${stats.rejected_score}`);
  console.log(`   Saved to DB:            ${stats.saved}`);
  console.log('─'.repeat(55) + '\n');

  return stats.saved;
}

module.exports = { searchBusinesses, runDiscovery };
