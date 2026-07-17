'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

process.env.DATA_COLLECTION_ONLY = 'true';
process.env.DATA_COLLECTION_TIMEZONE = 'Asia/Karachi';
process.env.GOOGLE_SHEET_ID = 'test-sheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test-service-account@example.test';
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nTEST_ONLY\\n-----END PRIVATE KEY-----';

const { google } = require('googleapis');
const originalJwt = google.auth.JWT;
const originalSheets = google.sheets;
const titles = [];
const appended = [];
google.auth.JWT = class FakeJwt { async authorize() { return { access_token: 'test-only' }; } };
google.sheets = () => ({ spreadsheets: {
  get: async () => ({ data: { properties: { title: 'Fixture Sheet' }, sheets: titles.map((title, index) => ({ properties: { title, sheetId: index + 1 } })) } }),
  batchUpdate: async ({ requestBody }) => {
    for (const request of requestBody.requests || []) if (request.addSheet) titles.push(request.addSheet.properties.title);
    return { data: { replies: [{ addSheet: { properties: { sheetId: titles.length } } }] } };
  },
  values: {
    update: async () => ({ data: {} }),
    append: async args => { appended.push(args); return { data: {} }; },
    get: async () => ({ data: { values: [] } })
  }
} });

const sheets = require('../src/services/googleSheets');
const { scoreUsLead } = require('../src/services/leadScorer');
const { scoreUkConfidence, runUkTaxiTowingPipeline } = require('../src/pipelines/ukTaxiTowingPipeline');
const { runUsWebAiPipeline } = require('../src/pipelines/usWebAiPipeline');
const { deduplicateLeads } = require('../src/services/leadDeduplicator');
const { exportUsWorkbook, exportUkWorkbook } = require('../src/services/excelExporter');
const ExcelJS = require('exceljs');

test('service-account config is detected without exposing values', () => {
  const result = sheets.validateGoogleSheetsConfig();
  assert.deepEqual(result, { status: 'ok' });
  assert.equal(JSON.stringify(result).includes('TEST_ONLY'), false);
});

test('Sheets access and Master/US/UK worksheets initialize through a mocked client', async () => {
  const connection = await sheets.verifyGoogleSheetsConnection();
  assert.equal(connection.connected, true);
  assert.equal(connection.write_access, true);
  const initialized = await sheets.initializeWorksheets();
  assert.equal(initialized.success, true);
  assert.deepEqual(titles.sort(), ['Master Leads', sheets.getDailyWorksheetName('UK'), sheets.getDailyWorksheetName('US')].sort());
});

test('low-level outreach operations are blocked', async () => {
  const gmail = require('../src/services/gmailService');
  const generator = require('../src/services/emailGenerator');
  const reply = require('../src/services/replyHandler');
  const accounts = require('../src/services/accountManager');
  const db = require('../src/database/db');
  await assert.rejects(() => gmail.sendEmail('test@example.test', 'subject', 'body'), { code: 'DATA_ONLY_OPERATION_BLOCKED' });
  await assert.rejects(() => generator.generateEmailForLead({ business_name: 'Fixture' }), { code: 'DATA_ONLY_OPERATION_BLOCKED' });
  await assert.rejects(() => reply.processInbox(), { code: 'DATA_ONLY_OPERATION_BLOCKED' });
  assert.throws(() => accounts.rotateAccount([]), { code: 'DATA_ONLY_OPERATION_BLOCKED' });
  assert.throws(() => db.insertOutreach(1, 'subject', 'body', 0), { code: 'DATA_ONLY_OPERATION_BLOCKED' });
  assert.throws(() => db.getWarmupDay(), { code: 'DATA_ONLY_OPERATION_BLOCKED' });
});

test('US scoring is transparent and deterministic', () => {
  const result = scoreUsLead({}, { has_website: false, website_status: 'unreachable' });
  assert.equal(result.lead_score, 75);
  assert.equal(result.priority, 'Medium');
  assert.equal(result.recommended_service, 'new website');
});

test('UK confidence scoring follows the documented rubric', () => {
  const result = scoreUkConfidence({ primary_source_type: 'official_website', business_phone: '020 0000 0000', phone_source_url: 'https://example.test/contact', business_email: 'office@example.test', email_source_url: 'https://example.test/contact', company_number: '01234567', companies_house_url: 'https://find-and-update.company-information.service.gov.uk/company/01234567', category_confirmed: true });
  assert.equal(result.confidence_score, 85);
  assert.equal(result.confidence_level, 'High');
});

test('source-backed leads remain collected even below opportunity/confidence threshold', async () => {
  const usCandidates = [1,2,3].map(id => ({ business_name:`Fixture Roofing ${id}`, category:'roofing', source_type:'official_website', source_url:`https://fixture${id}.test`, website_verified:true }));
  const us = await runUsWebAiPipeline(usCandidates, { target:2, auditWebsite:async()=>({ has_website:true, website_status:'modern', has_https:true, has_mobile_viewport:true, has_contact_form:true, has_booking_system:true, has_ordering_system:true, has_cta:true, has_chatbot:true, has_visible_phone:true, page_title:'Fixture', meta_description:'Fixture' }) });
  assert.equal(us.collected_count, 2);
  assert.equal(us.qualified_count, 0);
  assert.equal(us.manual_count, 2);
  const uk = await runUkTaxiTowingPipeline([{ business_name:'Fixture Taxi', category:'taxi', phone:'020 0000 0000', phone_source_url:'https://fixture-taxi.test', source_type:'official_website', source_url:'https://fixture-taxi.test', website_verified:true, category_confirmed:true }], { target:1 });
  assert.equal(uk.collected_count, 1);
  assert.equal(uk.qualified_count, 0);
  assert.equal(uk.manual_count, 1);
});

test('duplicates merge complementary evidence and preserve stronger sources', () => {
  const first = { business_name: 'Fixture Ltd', postcode: 'SW1A 1AA', business_phone: '020 0000 0000', primary_source_type: 'directory', primary_source_url: 'https://directory.test/fixture' };
  const second = { business_name: 'Fixture', postcode: 'SW1A1AA', business_email: 'office@fixture.test', primary_source_type: 'official_website', primary_source_url: 'https://fixture.test' };
  const result = deduplicateLeads([first, second], 'UK');
  assert.equal(result.leads.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.leads[0].business_email, 'office@fixture.test');
  assert.equal(result.leads[0].primary_source_type, 'official_website');
});

test('Excel workbooks generate, reopen, and sanitize formula injection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zynqora-excel-'));
  const usResult = { dataset:'US', target:500, qualified_count:1, manual_count:0, duplicates:0, rejected_count:0, shortfall_reason:'fixture', leads:[{ lead_id:'=1+1', business_name:'Fixture Roofing', category:'Roofing', priority:'High', verification_status:'verified', lead_score:90, date_collected:new Date(), primary_source_url:'https://fixture.test' }] };
  const ukResult = { dataset:'UK', target:500, qualified_count:1, manual_count:0, duplicates:0, rejected_count:0, shortfall_reason:'fixture', leads:[{ lead_id:'UK-1', business_name:'Fixture Taxi', category:'Taxi company', business_type:'taxi', confidence_level:'High', confidence_score:85, verification_status:'verified', date_collected:new Date(), primary_source_url:'https://fixture.test' }] };
  const us = await exportUsWorkbook(usResult, dir);
  const uk = await exportUkWorkbook(ukResult, dir);
  assert.equal(fs.existsSync(us.path), true); assert.equal(fs.existsSync(uk.path), true);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(us.path);
  assert.deepEqual(workbook.worksheets.map(s => s.name), ['High Priority Leads','Medium Priority Leads','Needs Manual Verification','Sources & Run Summary']);
  assert.equal(workbook.getWorksheet('High Priority Leads').getCell('A2').value, "'=1+1");
});

test('data dashboard contains no outreach controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /Data Mode: Active/);
  assert.match(html, /Google Maps API/);
  assert.match(html, /Live activity/);
  assert.doesNotMatch(html, /Connect Gmail|Send Follow-Ups|warmup/i);
});

test('localhost health endpoint and dashboard load without production services', async () => {
  const port = 3187;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zynqora-db-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIRECTORY: dataDir, GOOGLE_SHEET_ID: '', GOOGLE_SERVICE_ACCOUNT_EMAIL: '', GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '', DATA_COLLECTION_SCHEDULE_ENABLED: 'false' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { health = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json()); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(health?.status, 'ok');
    assert.equal(health?.data_collection_only, true);
    const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
    assert.match(html, /Business Lead Intelligence/);
  } finally {
    child.kill();
  }
});

test.after(() => { google.auth.JWT = originalJwt; google.sheets = originalSheets; });
