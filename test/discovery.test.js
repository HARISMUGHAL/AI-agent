'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zynqora-discovery-'));
process.env.DATA_COLLECTION_ONLY = 'true';
process.env.DATA_DIRECTORY = path.join(tempRoot, 'db');
process.env.HTTP_CACHE_DIRECTORY = path.join(tempRoot, 'cache');
process.env.OUTPUT_DIRECTORY = path.join(tempRoot, 'exports');
process.env.REQUEST_DELAY_MIN_MS = '0';
process.env.REQUEST_DELAY_MAX_MS = '0';
process.env.MAX_CONCURRENCY = '2';
process.env.DISCOVERY_TEST_MODE = 'true';
process.env.GOOGLE_MAPS_API_KEY = 'fixture-google-maps-key';
process.env.GOOGLE_SHEET_ID = 'fixture-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'fixture@example.test';
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nFIXTURE\\n-----END PRIVATE KEY-----';

const { google } = require('googleapis');
const originalJwt = google.auth.JWT;
const originalSheets = google.sheets;
const sheetTitles = [];
let appendCalls = 0;
google.auth.JWT = class FixtureJwt { async authorize() { return {}; } };
google.sheets = () => ({ spreadsheets: {
  get: async () => ({ data: { properties: { title: 'Fixture' }, sheets: sheetTitles.map((title, index) => ({ properties: { title, sheetId: index + 1 } })) } }),
  batchUpdate: async ({ requestBody }) => {
    for (const request of requestBody.requests || []) if (request.addSheet) sheetTitles.push(request.addSheet.properties.title);
    return { data: { replies: [{ addSheet: { properties: { sheetId: sheetTitles.length } } }] } };
  },
  values: {
    get: async () => ({ data: { values: [] } }), update: async () => ({ data: {} }),
    append: async () => { appendCalls++; return { data: {} }; }
  }
} });

const db = require('../src/database/db');
const { normalizeCandidate, discoverCandidates, enrichOfficialWebsite, discardUnverifiedGoogleContent } = require('../src/freeSources/sourceRegistry');
const { parseOverpass } = require('../src/freeSources/overpassSource');
const { parsePlaces, discover: discoverGooglePlaces } = require('../src/freeSources/googlePlacesSource');
const { parseRecords } = require('../src/freeSources/openDataSource');
const { parseLocalAuthorityRecords } = require('../src/freeSources/localAuthoritySource');
const { normalizeEvidence } = require('../src/services/provenanceService');
const sheets = require('../src/services/googleSheets');

test.before(async () => { await db.initDatabase(); });

test('source registry discovers candidates without uploaded arrays', async () => {
  const adapter = {
    metadata: { name:'Fixture Government Register', country:'US', categories:['roofing'], base_url:'https://data.example.test', source_type:'government', enabled:true, requires_key:false, request_delay_ms:0, concurrency:1, cache_ttl:24, provenance_strength:5 },
    discover: async context => [normalizeCandidate({ source_name:'Fixture Government Register', source_type:'government', source_url:'https://data.example.test/record/1', source_listing_id:'fixture-1', business_name:'Fixture Roofing', category:context.category, city:context.location, state_or_region:'NY', country:context.country })]
  };
  const result = await discoverCandidates({ dataset:'US', locations:['New York NY'], categories:['roofing'], limit:10, registry:[adapter] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source_url, 'https://data.example.test/record/1');
});

test('common candidate normalization never invents missing values', () => {
  const candidate = normalizeCandidate({ source_name:'Fixture', source_type:'government', source_url:'https://example.test/source', business_name:'Fixture Ltd' });
  assert.equal(candidate.phone, ''); assert.equal(candidate.email, ''); assert.equal(candidate.website, ''); assert.equal(candidate.company_number, '');
});

test('Overpass fixture parser returns traceable normalized candidates', () => {
  const candidates = parseOverpass({ elements:[{ type:'node', id:42, tags:{ name:'Fixture Taxi', amenity:'taxi', phone:'020 0000 0000', website:'https://fixture.test', 'addr:city':'London', 'addr:postcode':'SW1A 1AA' } }] }, { country:'United Kingdom', location:'London', category:'taxi' });
  assert.equal(candidates[0].source_listing_id, 'osm:node:42');
  assert.equal(candidates[0].source_url, 'https://www.openstreetmap.org/node/42');
});

test('Google Places fixture maps business fields with traceable provenance', () => {
  const candidates = parsePlaces({ places: [{ id:'place-42', displayName:{ text:'Fixture Plumbing' }, formattedAddress:'New York, NY, USA', googleMapsUri:'https://maps.google.com/?cid=42', websiteUri:'https://fixture.test', nationalPhoneNumber:'(212) 555-0100', rating:4.2, userRatingCount:18, primaryType:'plumber', primaryTypeDisplayName:{ text:'Plumber' } }] }, { country:'United States', location:'New York NY', category:'plumbing' });
  assert.equal(candidates[0].source_listing_id, 'google:place-42');
  assert.equal(candidates[0].source_type, 'google_places');
  assert.equal(candidates[0].phone, '');
  assert.equal(candidates[0].address, '');
  assert.equal(candidates[0].rating, 0);
  assert.equal(candidates[0].raw_record.transient_google_content, true);
});

test('Google Places content is replaced by independently sourced official website fields', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html><head><title>Fixture Plumbing | New York</title><script type="application/ld+json">{"@type":"Plumber","name":"Fixture Plumbing","telephone":"+12125550100","email":"office@fixture-plumbing.test","address":{"streetAddress":"1 Main St","addressLocality":"New York","addressRegion":"NY"}}</script></head><body><h1>Fixture Plumbing</h1><a href="/contact">Contact</a></body></html>', { status:200, headers:{'content-type':'text/html'} });
  try {
    const transient = parsePlaces({ places:[{ id:'compliance-1', displayName:{text:'Fixture Plumbing'}, formattedAddress:'Google-only address', googleMapsUri:'https://maps.google.com/?cid=compliance-1', websiteUri:'https://fixture-plumbing.test', nationalPhoneNumber:'Google-only phone', rating:4.9, userRatingCount:999, primaryType:'plumber' }] }, { country:'United States', location:'New York NY', category:'plumbing' })[0];
    const verified = await enrichOfficialWebsite(transient);
    assert.equal(verified.source_type, 'official_website');
    assert.equal(verified.business_name, 'Fixture Plumbing');
    assert.equal(verified.phone, '+12125550100');
    assert.equal(verified.address, '1 Main St, New York, NY');
    assert.equal(verified.rating, 0);
    assert.equal(verified.raw_record, null);
    assert.equal(JSON.stringify(verified).includes('Google-only'), false);
  } finally { global.fetch = originalFetch; }
});

test('unverified Google candidate retains only the storable Place ID', () => {
  const safe = discardUnverifiedGoogleContent(normalizeCandidate({ source_name:'Google Maps Places', source_type:'google_places', source_url:'https://maps.google.com/?cid=2', source_listing_id:'google:place-2', business_name:'Transient Name', address:'Transient Address', phone:'123', raw_record:{ transient_google_content:true } }));
  assert.equal(safe.source_listing_id, 'google:place-2');
  assert.equal(safe.business_name, '');
  assert.equal(safe.address, '');
  assert.equal(safe.phone, '');
  assert.equal(safe.raw_record, null);
});

test('Google Places discovery sends a field-masked Text Search request', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ places:[{ id:'place-1', displayName:{text:'Fixture Roofing'}, googleMapsUri:'https://maps.google.com/?cid=1', primaryType:'roofer' }] }), { status:200, headers:{'content-type':'application/json'} });
  };
  try {
    const found = await discoverGooglePlaces({ country:'United States', location:'Boston MA', category:'roofing', limit:5 });
    assert.equal(found.length, 1);
    assert.equal(request.url, 'https://places.googleapis.com/v1/places:searchText');
    assert.match(request.options.headers['X-Goog-FieldMask'], /places\.displayName/);
    assert.equal(JSON.parse(request.options.body).pageSize, 5);
  } finally { global.fetch = originalFetch; }
});

test('Google Places discovery follows pagination up to the requested candidate limit', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const page = body.pageToken ? 2 : 1;
    return new Response(JSON.stringify({ places:[{ id:`page-${page}`, displayName:{text:`Fixture ${page}`}, googleMapsUri:`https://maps.google.com/?cid=page-${page}`, primaryType:'plumber' }], ...(page === 1 ? { nextPageToken:'next-page' } : {}) }), { status:200, headers:{'content-type':'application/json'} });
  };
  try {
    const found = await discoverGooglePlaces({ country:'United States', location:'New York NY', category:'plumbing', limit:2 });
    assert.equal(found.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].pageToken, 'next-page');
  } finally { global.fetch = originalFetch; }
});

test('open-data and local-authority fixtures map to the common structure', () => {
  const records = [{ license_number:'ABC-1', trading_name:'Fixture Private Hire', license_type:'private hire', telephone:'020 0000 0000', city:'London' }];
  const open = parseRecords(records, { country:'United Kingdom', location:'London', category:'private hire' }, 'https://data.example.test/register');
  const local = parseLocalAuthorityRecords(records, { country:'United Kingdom', location:'London', category:'private hire' }, 'https://council.example.test/register');
  assert.equal(open[0].business_name, 'Fixture Private Hire');
  assert.equal(local[0].source_type, 'licensing_register');
  assert.equal(local[0].phone, '020 0000 0000');
});

test('official website enrichment extracts only published contacts and verifies identity', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html><title>Fixture Roofing</title><body><a href="tel:+12025550123">Call</a><a href="mailto:office@fixture.test">Email</a><a href="/contact">Contact</a><p>Roofing services</p></body></html>', { status:200, headers:{'content-type':'text/html'} });
  try {
    const result = await enrichOfficialWebsite(normalizeCandidate({ source_name:'Fixture Register', source_type:'government', source_url:'https://data.example.test/1', business_name:'Fixture Roofing', category:'roofing', website:'https://fixture.test' }));
    assert.equal(result.website_verified, true);
    assert.equal(result.email, 'office@fixture.test');
    assert.equal(result.phone, '+12025550123');
    assert.equal(result.email_source_url, 'https://fixture.test/');
  } finally { global.fetch = originalFetch; }
});

test('provenance rejects records without a valid source URL', () => {
  assert.equal(normalizeEvidence({ field:'phone', value:'123', url:'' }), null);
  assert.equal(normalizeEvidence({ field:'phone', value:'123', url:'https://example.test/source' }).field, 'phone');
});

test('discovery checkpoint persists and resumes metadata', () => {
  db.saveDiscoveryCheckpoint('US', { status:'paused', source:'Fixture', city:'Boston MA', category:'plumbing', candidates_fetched:7, collection_date:'2026-07-17' });
  const checkpoint = db.getDiscoveryCheckpoint('US');
  assert.equal(checkpoint.status, 'paused');
  assert.equal(checkpoint.city, 'Boston MA');
  assert.equal(checkpoint.candidates_fetched, 7);
});

test('completed discovery combinations are skipped on resume', async () => {
  let calls = 0;
  const adapter = { metadata: { enabled:true, country:'US', name:'Resume Fixture', source_type:'open_data' }, discover: async () => { calls++; return []; } };
  const completed = new Set(['Resume Fixture|Boston MA|plumbing']);
  await discoverCandidates({ dataset:'US', locations:['Boston MA'], categories:['plumbing','roofing'], limit:10, registry:[adapter],
    isCompleted: (source, city, category) => completed.has(`${source}|${city}|${category}`) });
  assert.equal(calls, 1);
});

test('permanent source permission failure is attempted once before fallback', async () => {
  let blockedCalls = 0;
  let fallbackCalls = 0;
  const blocked = { metadata:{ enabled:true, country:'US', name:'Blocked Google', source_type:'google_places' }, discover:async()=>{ blockedCalls++; const error=new Error('permission denied'); error.retryable=false; error.httpStatus=403; error.code='PERMISSION_DENIED'; throw error; } };
  const fallback = { metadata:{ enabled:true, country:'US', name:'Fallback Register', source_type:'government' }, discover:async context=>{ fallbackCalls++; return [normalizeCandidate({ source_name:'Fallback Register', source_type:'government', source_url:'https://data.example.test/fallback', business_name:'Fallback Roofing', category:context.category })]; } };
  const result = await discoverCandidates({ dataset:'US', locations:['Boston MA'], categories:['roofing','plumbing'], limit:10, registry:[blocked,fallback] });
  assert.equal(blockedCalls, 1);
  assert.equal(fallbackCalls, 2);
  assert.equal(result.candidates.length, 2);
});

test('per-sheet sync is idempotent after successful status persistence', async () => {
  const lead = { business_name:'Fixture Roofing', city:'New York NY', state:'NY', country:'United States', primary_source_url:'https://data.example.test/1', verification_status:'verified' };
  db.markSheetSyncPending('US', 'source:fixture-1');
  const first = await sheets.syncDatasetLeadBatch('US', [{ fingerprint:'source:fixture-1', lead }]);
  const callsAfterFirst = appendCalls;
  const second = await sheets.syncDatasetLeadBatch('US', [{ fingerprint:'source:fixture-1', lead }]);
  assert.equal(first.master_synced, 1); assert.equal(first.daily_synced, 1);
  assert.equal(second.master_synced, 0); assert.equal(second.daily_synced, 0);
  assert.equal(appendCalls, callsAfterFirst);
});

test('Excel export rebuilds from persisted SQLite data after memory loss', async () => {
  const lead = { lead_id:'persisted-1', business_name:'Persisted Roofing', category:'roofing', city:'Boston', state:'MA', country:'United States', primary_source_url:'https://data.example.test/persisted-1', lead_score:85, priority:'High', verification_status:'verified', date_collected:new Date().toISOString() };
  db.saveDataLead('US', 'source:persisted-1', lead);
  const { exportDataWorkbook } = require('../src/services/scheduler');
  const result = await exportDataWorkbook('US');
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(result.path), true);
});

test.after(() => { google.auth.JWT = originalJwt; google.sheets = originalSheets; });
