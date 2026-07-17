'use strict';

const { deduplicateLeads } = require('../services/leadDeduplicator');
const { hasTraceableSource, mergeEvidence } = require('../services/provenanceService');

const TAXI_TERMS = ['taxi', 'private hire', 'minicab', 'chauffeur', 'airport transfer'];
const TOWING_TERMS = ['towing', 'breakdown recovery', 'vehicle recovery', 'roadside assistance', 'recovery'];

function classifyUkBusiness(category) {
  const value = String(category || '').toLowerCase();
  if (TAXI_TERMS.some(term => value.includes(term))) return 'taxi';
  if (TOWING_TERMS.some(term => value.includes(term))) return 'towing';
  return '';
}

function scoreUkConfidence(lead) {
  let score = 0;
  const reasons = [];
  const add = (condition, points, reason) => { if (condition) { score += points; reasons.push(reason); } };
  add(lead.primary_source_type === 'official_website' || lead.official_website_verified, 25, 'official website verified');
  add(lead.primary_source_type === 'google_places' && lead.official_profile_verified, 20, 'Google Maps business profile verified');
  add(!!lead.business_phone && !!lead.phone_source_url, 20, 'business phone source confirmed');
  add(!!lead.business_email && !!lead.email_source_url, 15, 'public business email source confirmed');
  add(!!lead.company_number && !!lead.companies_house_url, 15, 'Companies House match');
  add(!!lead.address_matches_two_sources, 10, 'address matched across two sources');
  add(!!lead.category_confirmed, 10, 'category confirmed');
  add(!!lead.recent_activity_evidence, 5, 'recent activity evidence');
  score = Math.min(100, score);
  return { confidence_score: score, confidence_level: score >= 80 ? 'High' : score >= 60 ? 'Medium' : 'Low', confidence_reasons: reasons };
}

async function runUkTaxiTowingPipeline(candidates = [], options = {}) {
  const target = Number(options.target || process.env.UK_TARGET_LEADS || 500);
  const accepted = [];
  let rejected = 0;
  for (const candidate of candidates) {
    const classification = classifyUkBusiness(candidate.category || candidate.business_category);
    const hasContact = !!(candidate.business_phone || candidate.phone || candidate.business_email || candidate.email || candidate.contact_page || candidate.contact_page_url);
    if (!classification || !candidate.business_name || !hasContact || !hasTraceableSource(candidate) || candidate.clearly_closed) { rejected++; continue; }
    const normalized = {
      ...candidate,
      primary_source: candidate.primary_source || candidate.source_name || '',
      primary_source_type: candidate.primary_source_type || candidate.source_type || '',
      primary_source_url: candidate.primary_source_url || candidate.source_url || '',
      business_phone: candidate.business_phone || candidate.phone || '',
      business_email: candidate.business_email || candidate.email || '',
      contact_page: candidate.contact_page || candidate.contact_page_url || '',
      region: candidate.region || candidate.state_or_region || '',
      official_website_verified: !!candidate.website_verified
    };
    const scored = scoreUkConfidence(normalized);
    accepted.push({
      ...normalized, ...scored, business_type: classification, country: 'United Kingdom',
      verified_director_name: candidate.verified_director_name || '',
      owner_verification: candidate.verified_director_name ? 'verified_director_not_operational_owner' : 'not_available',
      verification_status: scored.confidence_score >= Number(process.env.MIN_UK_CONFIDENCE_SCORE || 60) ? 'verified' : 'needs_manual_verification',
      date_collected: new Date(),
      evidence: mergeEvidence(candidate.evidence || [])
    });
  }
  const deduped = deduplicateLeads(accepted, 'UK', options.historicalFingerprints);
  const selected = deduped.leads.sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0)).slice(0, target);
  const qualified = selected.filter(lead => lead.verification_status === 'verified');
  return {
    dataset: 'UK', target, leads: selected, collected_count: selected.length, qualified_count: qualified.length,
    manual_count: selected.length - qualified.length, duplicates: deduped.duplicates,
    rejected_count: rejected,
    shortfall_reason: selected.length < target ? `Only ${selected.length} source-backed UK leads were available from the configured sources; ${qualified.length} met the confidence threshold.` : ''
  };
}

module.exports = { runUkTaxiTowingPipeline, scoreUkConfidence, classifyUkBusiness, TAXI_TERMS, TOWING_TERMS };
