'use strict';

const { respectfulFetch } = require('./httpClient');
const { normalizeCandidate } = require('./sourceRegistry');

const metadata = {
  name: 'OpenStreetMap Overpass', country: 'US,UK', categories: ['target niches'],
  base_url: process.env.OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter', source_type: 'open_data',
  enabled: String(process.env.OVERPASS_ENABLED || 'true') === 'true', requires_key: false,
  request_delay_ms: 4000, concurrency: 1, cache_ttl: 24, provenance_strength: 3
};

function escapeQuery(value) { return String(value || '').replace(/["\\]/g, '\\$&'); }

function buildQuery({ location, category, country, limit = 100 }) {
  const areaName = escapeQuery(String(location).replace(/,?\s+[A-Z]{2}$/i, '').trim());
  const term = escapeQuery(category);
  const capped = Math.min(100, Math.max(1, Number(limit)));
  const filters = country === 'United Kingdom'
    ? `nwr(area.a)["name"~"${term}",i];nwr(area.a)["amenity"="taxi"];nwr(area.a)["office"="transport"]["name"~"taxi|private hire|minicab|chauffeur|airport transfer|towing|recovery|roadside",i];nwr(area.a)["shop"="car_repair"]["name"~"towing|recovery|roadside",i];`
    : `nwr(area.a)["name"~"${term}",i];nwr(area.a)["craft"~"roofer|hvac|plumber|electrician|landscaper",i];nwr(area.a)["shop"="car_repair"];nwr(area.a)["office"~"lawyer|accountant",i];nwr(area.a)["amenity"~"dentist|clinic",i];`;
  return `[out:json][timeout:25];area["name"="${areaName}"]["boundary"="administrative"]->.a;(${filters});out center tags ${capped};`;
}

function parseOverpass(data, context = {}) {
  return (data.elements || []).map(element => {
    const tags = element.tags || {};
    const sourceUrl = `https://www.openstreetmap.org/${element.type}/${element.id}`;
    return normalizeCandidate({
      source_name: metadata.name, source_type: metadata.source_type, source_url: sourceUrl,
      source_listing_id: `osm:${element.type}:${element.id}`, business_name: tags.name || tags.brand || '',
      category: tags.craft || tags.shop || tags.amenity || tags.office || context.category || '', business_type: context.category || '',
      city: tags['addr:city'] || context.location || '', state_or_region: tags['addr:state'] || '', postcode: tags['addr:postcode'] || '',
      country: context.country || '', address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(', '),
      phone: tags.phone || tags['contact:phone'] || '', email: tags.email || tags['contact:email'] || '',
      website: tags.website || tags['contact:website'] || '', contact_page_url: '', company_number: '', raw_record: element
    });
  }).filter(candidate => candidate.business_name);
}

async function discover(context) {
  if (!metadata.enabled) return [];
  const query = buildQuery(context);
  const response = await respectfulFetch(metadata.base_url, {
    method: 'POST', body: `data=${encodeURIComponent(query)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    requestDelayMs: metadata.request_delay_ms, cacheTtlHours: metadata.cache_ttl
  });
  if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}`);
  return parseOverpass(JSON.parse(response.text), context);
}

module.exports = { metadata, discover, buildQuery, parseOverpass };
