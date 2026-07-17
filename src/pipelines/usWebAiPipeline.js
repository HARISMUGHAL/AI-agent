'use strict';

const { auditWebsite } = require('../services/websiteScraper');
const { scoreUsLead } = require('../services/leadScorer');
const { deduplicateLeads } = require('../services/leadDeduplicator');
const { hasTraceableSource, mergeEvidence } = require('../services/provenanceService');

const ALLOWED_NICHES = ['roofing', 'roofer', 'hvac', 'plumbing', 'plumber', 'electrician', 'landscaping', 'landscaper', 'remodeling', 'dental', 'medical spa', 'law firm', 'lawyer', 'accounting', 'accountant', 'auto repair', 'car_repair', 'cleaning'];

function allowedNiche(category) {
  const value = String(category || '').toLowerCase();
  return ALLOWED_NICHES.some(niche => value.includes(niche));
}

async function runUsWebAiPipeline(candidates = [], options = {}) {
  const target = Number(options.target || process.env.US_TARGET_LEADS || 500);
  const verified = [];
  const rejected = [];
  for (const candidate of candidates) {
    if (!candidate.business_name || !allowedNiche(candidate.category) || !hasTraceableSource(candidate)) {
      rejected.push({ candidate, reason: 'missing identity/source or unsupported US category' });
      continue;
    }
    const audit = await (options.auditWebsite || auditWebsite)(candidate.website || '');
    const scored = scoreUsLead(candidate, audit);
    const sourceType = candidate.primary_source_type || candidate.source_type || '';
    const sourceBacked = candidate.website_verified || ['government','licensing_register','official_website','official_profile','google_places'].includes(sourceType);
    verified.push({
      ...candidate,
      ...scored,
      primary_source: candidate.primary_source || candidate.source_name || '',
      primary_source_type: sourceType,
      primary_source_url: candidate.primary_source_url || candidate.source_url || '',
      phone: candidate.phone || '', public_email: candidate.public_email || candidate.email || '',
      country: 'United States',
      website_status: audit.website_status,
      website_problems: audit.website_issues || [],
      website_evidence: audit.audit_findings || audit.website_evidence || [],
      audit_findings: (audit.audit_findings || []).map(finding => ({ ...finding, source_url: finding.source_url || candidate.primary_source_url || candidate.source_url || '' })),
      audit_timestamp: new Date(),
      date_collected: new Date(),
      verification_status: scored.lead_score >= Number(process.env.MIN_US_LEAD_SCORE || 60) && sourceBacked ? 'verified' : 'needs_manual_verification',
      evidence: mergeEvidence(candidate.evidence || [], [{ field: 'business_name', value: candidate.business_name, source_name: candidate.primary_source || 'Public source', source_type: candidate.primary_source_type || 'user_seed', url: candidate.primary_source_url || candidate.source_url }])
    });
  }
  const deduped = deduplicateLeads(verified, 'US', options.historicalFingerprints);
  const selected = deduped.leads.sort((a, b) => Number(b.lead_score || 0) - Number(a.lead_score || 0)).slice(0, target);
  const qualified = selected.filter(lead => lead.verification_status === 'verified');
  return {
    dataset: 'US', target, leads: selected, collected_count: selected.length, qualified_count: qualified.length,
    manual_count: selected.length - qualified.length, duplicates: deduped.duplicates,
    rejected_count: rejected.length,
    shortfall_reason: selected.length < target ? `Only ${selected.length} source-backed US leads were available from the configured sources; ${qualified.length} met the opportunity-score threshold.` : ''
  };
}

module.exports = { runUsWebAiPipeline, allowedNiche, ALLOWED_NICHES };
