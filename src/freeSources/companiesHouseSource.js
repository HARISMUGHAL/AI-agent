'use strict';

const { fetchJson } = require('./httpClient');

const metadata = {
  name: 'Companies House', country: 'UK', categories: ['company enrichment'], base_url: 'https://api.company-information.service.gov.uk',
  source_type: 'companies_house', enabled: String(process.env.COMPANIES_HOUSE_ENABLED || 'false') === 'true', requires_key: true,
  request_delay_ms: 1000, concurrency: 1, cache_ttl: 24, provenance_strength: 5
};

function publicProfileUrl(companyNumber) {
  return companyNumber ? `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}` : '';
}

async function enrich(candidate) {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!metadata.enabled || !key || !candidate.business_name) return { ...candidate, companies_house_search_url: candidate.business_name ? `https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(candidate.business_name)}` : '' };
  const auth = Buffer.from(`${key}:`).toString('base64');
  const search = await fetchJson(`${metadata.base_url}/search/companies?q=${encodeURIComponent(candidate.business_name)}&items_per_page=5`, { headers: { Authorization: `Basic ${auth}` }, requestDelayMs: metadata.request_delay_ms });
  const city = String(candidate.city || '').toLowerCase();
  const match = (search.data.items || []).find(item => {
    const titleMatches = String(item.title || '').toLowerCase().replace(/\W/g, '').includes(String(candidate.business_name).toLowerCase().replace(/\W/g, ''));
    const locality = String(item.address?.locality || '').toLowerCase();
    return titleMatches && (!city || !locality || locality === city);
  });
  if (!match || match.company_status === 'dissolved') return { ...candidate, companies_house_search_url: `https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(candidate.business_name)}` };
  const companyNumber = match.company_number;
  let director = '';
  try {
    const officers = await fetchJson(`${metadata.base_url}/company/${companyNumber}/officers?items_per_page=10`, { headers: { Authorization: `Basic ${auth}` }, requestDelayMs: metadata.request_delay_ms });
    director = (officers.data.items || []).find(item => !item.resigned_on && String(item.officer_role || '').includes('director'))?.name || '';
  } catch { /* enrichment remains optional */ }
  return {
    ...candidate, company_number: companyNumber, verified_director_name: director,
    owner_verification: director ? 'verified_director_not_operational_owner' : 'not_available',
    companies_house_url: publicProfileUrl(companyNumber), company_source_url: publicProfileUrl(companyNumber)
  };
}

module.exports = { metadata, enrich, publicProfileUrl };
