/**
 * googleSheets.js — Google Sheets Integration
 * Zynqora Edge — Service Account auth via environment variables
 */

const { google } = require('googleapis');

const SPREADSHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const DATA_MODE_HEADERS = [
  'Lead ID', 'Business Name', 'Contact Name', 'Business Email', 'Alternate Email',
  'Phone', 'Contact Method', 'Website', 'Contact Page', 'Business Category', 'Niche',
  'City', 'State/Region', 'Country', 'Full Address', 'Google Maps URL', 'Google Place ID',
  'Rating', 'Review Count', 'Last Review Date', 'Website Status', 'Website Issues',
  'Website Evidence', 'Needs Website', 'Needs Website Redesign', 'AI Opportunity Score',
  'Needs AI Services', 'Recommended Service', 'Qualification Reason', 'Lead Score',
  'Data Source', 'Date Collected', 'Verification Status', 'Outreach Status'
];

const OUTREACH_HEADERS = [
  'Date Found', 'Business Name', 'Niche', 'Location', 'Email', 'Phone', 'Website',
  'Rating', 'Reviews', 'Score', 'Status', 'Outreach Status'
];

const MAX_ROWS_SCAN = 5000;
const MASTER_HEADERS = [
  'Dataset','Lead ID','Business Name','Trading Name','Category','Business Type','Company Number','Verified Director Name','Owner Verification',
  'Contact Person','Phone','Alternate Phone','Email','Alternate Email','Website','Contact Page','Address','City','State/Region','Postcode','Country',
  'Primary Source','Primary Source URL','Secondary Source URL','Companies House URL','Phone Source URL','Email Source URL','Owner Source URL',
  'Website Status','Website Problems','Website Evidence','AI Opportunity','Recommended Service','Lead Score','Priority','Confidence Score',
  'Confidence Level','Verification Status','Date Collected','Notes','Source Listing ID'
];

function normalizePrivateKey(raw) {
  if (!raw) return null;
  return raw.replace(/\\n/g, '\n').trim();
}

function validateGoogleSheetsConfig() {
  const missing = [];
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const privateKey = normalizePrivateKey(rawKey);

  if (!sheetId || sheetId === 'your_google_sheet_id_here') missing.push('GOOGLE_SHEET_ID');
  if (!email) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!rawKey) missing.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  else if (!privateKey || !privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (invalid format)');
  }

  if (missing.length > 0) {
    return { status: 'configuration_required', missing };
  }
  return { status: 'ok' };
}

function logConfigStatus() {
  const cfg = validateGoogleSheetsConfig();
  console.log(`[Sheets] Service account email configured: ${!!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
  console.log(`[Sheets] Private key configured: ${!!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY}`);
  console.log(`[Sheets] Spreadsheet ID configured: ${!!process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SHEET_ID !== 'your_google_sheet_id_here'}`);
  if (cfg.status === 'configuration_required') {
    console.log(`[Sheets] Configuration required. Missing: ${cfg.missing.join(', ')}`);
  }
  return cfg;
}

function getServiceAccountAuth() {
  const cfg = validateGoogleSheetsConfig();
  if (cfg.status !== 'ok') return null;

  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    scopes: [SPREADSHEETS_SCOPE]
  });
}

function getSheetsClient() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId || spreadsheetId === 'your_google_sheet_id_here') return null;
  const auth = getServiceAccountAuth();
  if (!auth) return null;
  return { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId, auth };
}

function getMasterWorksheetName() {
  return process.env.MASTER_WORKSHEET || process.env.GOOGLE_SHEETS_MASTER_WORKSHEET || 'Master Leads';
}

function getDailyWorksheetName(dataset = 'US') {
  const prefix = dataset === 'UK' ? (process.env.UK_DAILY_WORKSHEET_PREFIX || 'UK Leads') : (process.env.US_DAILY_WORKSHEET_PREFIX || 'US Leads');
  const tz = process.env.DATA_COLLECTION_TIMEZONE || 'Asia/Karachi';
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return `${prefix} ${dateStr}`;
}

function columnName(number) {
  let output = '';
  while (number > 0) { number--; output = String.fromCharCode(65 + (number % 26)) + output; number = Math.floor(number / 26); }
  return output;
}

async function verifyGoogleSheetsConnection() {
  const cfg = validateGoogleSheetsConfig();
  if (cfg.status !== 'ok') {
    return { connected: false, configured: false, error: 'Google Sheets configuration incomplete.', ...cfg };
  }

  const ctx = getSheetsClient();
  if (!ctx) {
    return { connected: false, configured: false, error: 'Could not create Sheets client.' };
  }

  try {
    await ctx.auth.authorize();
    const meta = await ctx.sheets.spreadsheets.get({ spreadsheetId: ctx.spreadsheetId });
    const title = meta.data.properties?.title || 'Unknown';

    let writeAccess = false;
    try {
      await ctx.sheets.spreadsheets.batchUpdate({
        spreadsheetId: ctx.spreadsheetId,
        requestBody: { requests: [{
          updateSpreadsheetProperties: { properties: { title }, fields: 'title' }
        }] }
      });
      writeAccess = true;
    } catch (writeErr) {
      const writeMessage = writeErr.message || String(writeErr);
      if (/permission|403|forbidden/i.test(writeMessage)) {
        return {
          connected: false,
          configured: true,
          spreadsheet_title: title,
          write_access: false,
          error: 'Share the Google Sheet with the service account email as Editor.'
        };
      }
      return { connected: true, configured: true, spreadsheet_title: title, write_access: false, error: `Write verification failed: ${writeMessage}` };
    }

    return {
      connected: true,
      configured: true,
      spreadsheet_title: title,
      write_access: writeAccess,
      master_worksheet: getMasterWorksheetName(),
      us_worksheet: getDailyWorksheetName('US'),
      uk_worksheet: getDailyWorksheetName('UK')
    };
  } catch (error) {
    const msg = error.message || String(error);
    if (msg.includes('permission') || msg.includes('403') || msg.includes('not found')) {
      return {
        connected: false,
        configured: true,
        write_access: false,
        error: 'Share the Google Sheet with the service account email as Editor.'
      };
    }
    return { connected: false, configured: true, error: msg };
  }
}

async function ensureWorksheet(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = (meta.data.sheets || []).find(s => s.properties?.title === title);
  if (existing) return existing.properties.sheetId;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }]
    }
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function initWorksheetHeaders(sheets, spreadsheetId, worksheetName, headers) {
  await ensureWorksheet(sheets, spreadsheetId, worksheetName);
  const range = `'${worksheetName}'!A1:${columnName(headers.length)}1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers] }
  });
}

async function initDataModeHeaders() {
  const ctx = getSheetsClient();
  if (!ctx) {
    logConfigStatus();
    return { success: false, message: 'Google Sheets not configured' };
  }

  try {
    const master = getMasterWorksheetName();
    const us = getDailyWorksheetName('US');
    const uk = getDailyWorksheetName('UK');
    await initWorksheetHeaders(ctx.sheets, ctx.spreadsheetId, master, MASTER_HEADERS);
    await initWorksheetHeaders(ctx.sheets, ctx.spreadsheetId, us, MASTER_HEADERS);
    await initWorksheetHeaders(ctx.sheets, ctx.spreadsheetId, uk, MASTER_HEADERS);
    console.log(`[Sheets] Data-mode worksheets initialized: "${master}", "${us}", "${uk}"`);
    return { success: true, master_worksheet: master, us_worksheet: us, uk_worksheet: uk };
  } catch (error) {
    console.error('[Sheets] Header init error:', error.message);
    return { success: false, message: error.message };
  }
}

function leadToRow(lead) {
  const issues = typeof lead.website_issues === 'string' ? lead.website_issues : JSON.stringify(lead.website_issues || []);
  const evidence = typeof lead.website_evidence === 'string' ? lead.website_evidence : JSON.stringify(lead.website_evidence || []);
  return [
    lead.id || lead.place_id || '',
    lead.business_name || '',
    lead.owner_or_contact_name || '',
    lead.email || '',
    lead.alternate_email || '',
    lead.phone || '',
    lead.contact_method || '',
    lead.website || '',
    lead.contact_page_url || '',
    lead.niche || '',
    lead.niche || '',
    lead.city || '',
    lead.state_or_region || '',
    lead.country || '',
    lead.address || lead.location || '',
    lead.google_maps_url || '',
    lead.place_id || '',
    lead.rating || 0,
    lead.review_count || 0,
    lead.last_review_date || '',
    lead.website_status || '',
    issues,
    evidence,
    lead.needs_website ? 'Yes' : 'No',
    lead.needs_website_redesign ? 'Yes' : 'No',
    lead.ai_opportunity_score || 0,
    lead.needs_ai_services ? 'Yes' : 'No',
    lead.recommended_service || '',
    lead.qualification_reason || '',
    lead.lead_score || lead.score || 0,
    lead.data_source || 'google_maps',
    new Date().toISOString(),
    lead.verification_status || 'pending',
    lead.outreach_status || 'not_contacted'
  ];
}

async function getExistingSheetEmails(worksheetName) {
  const ctx = getSheetsClient();
  if (!ctx) return new Set();

  const sheet = worksheetName || getMasterWorksheetName();
  try {
    const res = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: ctx.spreadsheetId,
      range: `'${sheet}'!D2:D${MAX_ROWS_SCAN}`
    });
    return new Set((res.data.values || []).map(r => (r[0] || '').toLowerCase()).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

async function batchWriteQualifiedLeads(leads, worksheetName) {
  if (!leads || leads.length === 0) return { success: true, synced: 0 };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheets not configured' };

  const master = worksheetName || getMasterWorksheetName();
  const daily = getDailyWorksheetName();

  try {
    await initWorksheetHeaders(ctx.sheets, ctx.spreadsheetId, master, DATA_MODE_HEADERS);
    await initWorksheetHeaders(ctx.sheets, ctx.spreadsheetId, daily, DATA_MODE_HEADERS);

    const existingEmails = await getExistingSheetEmails(master);
    const newLeads = leads.filter(l => {
      if (!l.email) return true;
      return !existingEmails.has(l.email.toLowerCase());
    });

    if (newLeads.length === 0) {
      return { success: true, synced: 0, skipped: leads.length };
    }

    const values = newLeads.map(leadToRow);

    for (const sheet of [master, daily]) {
      await ctx.sheets.spreadsheets.values.append({
        spreadsheetId: ctx.spreadsheetId,
        range: `'${sheet}'!A:AH`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values }
      });
    }

    console.log(`[Sheets] Batch synced ${newLeads.length} qualified leads to Master and Daily worksheets.`);
    return { success: true, synced: newLeads.length };
  } catch (error) {
    console.error('[Sheets] Batch write error:', error.message);
    return { success: false, message: error.message };
  }
}

const MASTER_FIELD_KEYS = [
  '_dataset','lead_id','business_name','trading_name','category','business_type','company_number','verified_director_name','owner_verification',
  'contact_person','_phone','alternate_phone','_email','alternate_email','website','contact_page','address','city','_region','postcode','country',
  'primary_source','primary_source_url','secondary_source_url','companies_house_url','phone_source_url','email_source_url','owner_source_url',
  'website_status','website_problems','website_evidence','ai_opportunity','recommended_service','lead_score','priority','confidence_score',
  'confidence_level','verification_status','date_collected','notes','source_listing_id'
];

function masterRow(lead, dataset) {
  const aliases = {
    _dataset: dataset,
    _phone: lead.phone || lead.business_phone || '',
    _email: lead.public_email || lead.email || lead.business_email || '',
    _region: lead.state || lead.region || lead.state_or_region || ''
  };
  return MASTER_FIELD_KEYS.map(key => {
    let value = key.startsWith('_') ? aliases[key] : lead[key];
    if (Array.isArray(value) || (value && typeof value === 'object' && !(value instanceof Date))) value = JSON.stringify(value);
    if (typeof value === 'string' && /^[=+\-@]/.test(value)) value = `'${value}`;
    return value ?? '';
  });
}

async function initializeWorksheets() {
  return initDataModeHeaders();
}

async function syncDatasetLeads(dataset, leads) {
  if (!['US', 'UK'].includes(dataset)) return { success: false, synced: 0, message: 'Dataset must be US or UK' };
  if (!leads?.length) return { success: true, synced: 0 };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, synced: 0, message: 'Google Sheets not configured' };
  await initializeWorksheets();
  const master = getMasterWorksheetName();
  const daily = getDailyWorksheetName(dataset);
  const values = leads.map(lead => masterRow(lead, dataset));
  for (const worksheet of [master, daily]) {
    await ctx.sheets.spreadsheets.values.append({
      spreadsheetId: ctx.spreadsheetId,
      range: `'${worksheet}'!A:AO`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });
  }
  return { success: true, synced: leads.length, worksheet: daily };
}

async function getSheetFingerprints(dataset) {
  const ctx = getSheetsClient();
  if (!ctx) return new Set();
  const { fingerprints } = require('./leadDeduplicator');
  const output = new Set();
  for (const worksheet of [getMasterWorksheetName(), getDailyWorksheetName(dataset)]) {
    try {
      const response = await ctx.sheets.spreadsheets.values.get({ spreadsheetId: ctx.spreadsheetId, range: `'${worksheet}'!A1:AO` });
      const [headers = [], ...rows] = response.data.values || [];
      for (const row of rows) {
        const record = {};
        headers.forEach((header, index) => {
          const key = String(header || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          record[key] = row[index] || '';
        });
        for (const key of fingerprints(record, dataset)) output.add(key);
      }
    } catch (error) {
      if (!/unable to parse range|not found/i.test(error.message || '')) throw error;
    }
  }
  return output;
}

async function getWorksheetFingerprints(dataset, worksheet) {
  const ctx = getSheetsClient();
  if (!ctx) return new Set();
  const { fingerprints } = require('./leadDeduplicator');
  const output = new Set();
  try {
    const response = await ctx.sheets.spreadsheets.values.get({ spreadsheetId: ctx.spreadsheetId, range: `'${worksheet}'!A1:AO` });
    const [headers = [], ...rows] = response.data.values || [];
    for (const row of rows) {
      const record = {};
      headers.forEach((header, index) => {
        const key = String(header || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        record[key] = row[index] || '';
      });
      for (const key of fingerprints(record, dataset)) output.add(key);
    }
  } catch (error) {
    if (!/unable to parse range|not found/i.test(error.message || '')) throw error;
  }
  return output;
}

async function syncDatasetLeadBatch(dataset, entries) {
  if (!entries?.length) return { success: true, master_synced: 0, daily_synced: 0 };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, master_synced: 0, daily_synced: 0, message: 'Google Sheets not configured' };
  const { getPendingSheetSync, updateSheetSyncStatus } = require('../database/db');
  await initializeWorksheets();
  const pending = new Map(getPendingSheetSync(dataset).map(row => [row.fingerprint, row]));
  const sheets = [
    { kind: 'master', name: getMasterWorksheetName(), status: 'master_status' },
    { kind: 'daily', name: getDailyWorksheetName(dataset), status: 'daily_status' }
  ];
  const result = { success: true, master_synced: 0, daily_synced: 0 };
  for (const sheet of sheets) {
    const existing = await getWorksheetFingerprints(dataset, sheet.name);
    const required = entries.filter(entry => {
      const state = pending.get(entry.fingerprint);
      return state && state[sheet.status] !== 'synced';
    });
    const missing = [];
    for (const entry of required) {
      if (existing.has(entry.fingerprint)) updateSheetSyncStatus(dataset, entry.fingerprint, sheet.kind, 'synced');
      else missing.push(entry);
    }
    if (!missing.length) continue;
    try {
      await ctx.sheets.spreadsheets.values.append({
        spreadsheetId: ctx.spreadsheetId, range: `'${sheet.name}'!A:AO`, valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS', requestBody: { values: missing.map(entry => masterRow(entry.lead, dataset)) }
      });
      for (const entry of missing) updateSheetSyncStatus(dataset, entry.fingerprint, sheet.kind, 'synced');
      result[`${sheet.kind}_synced`] += missing.length;
    } catch (error) {
      result.success = false;
      result[`${sheet.kind}_error`] = error.message;
      for (const entry of missing) updateSheetSyncStatus(dataset, entry.fingerprint, sheet.kind, 'pending', error.message);
    }
  }
  return result;
}

// ─── Legacy outreach sheet functions (service account, Sheet1) ───────────────

async function initSheetHeaders() {
  const { isDataCollectionOnly } = require('../database/db');
  if (isDataCollectionOnly()) return initDataModeHeaders();

  const ctx = getSheetsClient();
  if (!ctx) return;
  try {
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: ctx.spreadsheetId,
      range: 'Sheet1!A1:L1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [OUTREACH_HEADERS] }
    });
    console.log('[Sheets] Outreach headers initialized.');
  } catch (e) { /* headers may exist */ }
}

async function findLeadRowByEmail(email) {
  if (!email) return null;
  const ctx = getSheetsClient();
  if (!ctx) return null;
  try {
    const res = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: ctx.spreadsheetId,
      range: `Sheet1!E2:E${MAX_ROWS_SCAN}`
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toLowerCase() === email.toLowerCase()) return i + 2;
    }
  } catch (e) {
    console.error('[Sheets] Duplicate check error:', e.message);
  }
  return null;
}

async function syncLeadToSheets(lead) {
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };
  try {
    if (lead.email) {
      const existingRow = await findLeadRowByEmail(lead.email);
      if (existingRow) return { success: true, skipped: true };
    }
    const values = [[
      new Date().toLocaleString(), lead.business_name || '', lead.niche || '',
      lead.location || '', lead.email || 'N/A', lead.phone || 'N/A',
      lead.website || 'N/A', lead.rating || 0, lead.review_count || 0,
      lead.score || 0, lead.status || 'new', 'pending'
    ]];
    await ctx.sheets.spreadsheets.values.append({
      spreadsheetId: ctx.spreadsheetId,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function updateLeadStatusInSheet(email, outreachStatus) {
  if (!email) return { success: false, message: 'No email provided' };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };
  try {
    const rowNumber = await findLeadRowByEmail(email);
    if (!rowNumber) return { success: false, message: 'Lead not found in sheet' };
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: ctx.spreadsheetId,
      range: `Sheet1!L${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[outreachStatus]] }
    });
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function updateLeadScoreAndStatus(email, score, outreachStatus) {
  if (!email) return { success: false, message: 'No email provided' };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };
  try {
    const rowNumber = await findLeadRowByEmail(email);
    if (!rowNumber) return { success: false, message: 'Lead not found in sheet' };
    await ctx.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `Sheet1!J${rowNumber}`, values: [[score]] },
          { range: `Sheet1!L${rowNumber}`, values: [[outreachStatus]] }
        ]
      }
    });
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function batchSyncLeads(leads) {
  if (!leads || leads.length === 0) return { success: true, synced: 0 };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };
  try {
    const res = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: ctx.spreadsheetId,
      range: `Sheet1!E2:E${MAX_ROWS_SCAN}`
    });
    const existingEmails = new Set((res.data.values || []).map(r => (r[0] || '').toLowerCase()));
    const newLeads = leads.filter(l => !l.email || !existingEmails.has(l.email.toLowerCase()));
    if (newLeads.length === 0) return { success: true, synced: 0 };
    const values = newLeads.map(lead => [
      new Date().toLocaleString(), lead.business_name || '', lead.niche || '',
      lead.location || '', lead.email || 'N/A', lead.phone || 'N/A',
      lead.website || 'N/A', lead.rating || 0, lead.review_count || 0,
      lead.score || 0, lead.status || 'new', 'pending'
    ]);
    await ctx.sheets.spreadsheets.values.append({
      spreadsheetId: ctx.spreadsheetId,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    return { success: true, synced: newLeads.length };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function getSheetsStatus() {
  const cfg = validateGoogleSheetsConfig();
  if (cfg.status !== 'ok') {
    return {
      configured: false,
      connected: false,
      write_access: false,
      master_worksheet_ready: false,
      us_worksheet_ready: false,
      uk_worksheet_ready: false,
      ...cfg
    };
  }

  const connection = await verifyGoogleSheetsConnection();
  let masterReady = false;
  let usReady = false;
  let ukReady = false;

  if (connection.connected) {
    const ctx = getSheetsClient();
    try {
      const meta = await ctx.sheets.spreadsheets.get({ spreadsheetId: ctx.spreadsheetId });
      const titles = (meta.data.sheets || []).map(s => s.properties?.title);
      masterReady = titles.includes(getMasterWorksheetName());
      usReady = titles.includes(getDailyWorksheetName('US'));
      ukReady = titles.includes(getDailyWorksheetName('UK'));
    } catch (e) { /* ignore */ }
  }

  return {
    configured: true,
    connected: connection.connected,
    write_access: connection.write_access || false,
    spreadsheet_title: connection.spreadsheet_title || null,
    master_worksheet: getMasterWorksheetName(),
    us_worksheet: getDailyWorksheetName('US'),
    uk_worksheet: getDailyWorksheetName('UK'),
    master_worksheet_ready: masterReady,
    us_worksheet_ready: usReady,
    uk_worksheet_ready: ukReady,
    error: connection.error || null
  };
}

module.exports = {
  validateGoogleSheetsConfig,
  logConfigStatus,
  verifyGoogleSheetsConnection,
  getSheetsStatus,
  initDataModeHeaders,
  initializeWorksheets,
  syncDatasetLeads,
  getSheetFingerprints,
  getWorksheetFingerprints,
  syncDatasetLeadBatch,
  batchWriteQualifiedLeads,
  getExistingSheetEmails,
  getMasterWorksheetName,
  getDailyWorksheetName,
  DATA_MODE_HEADERS,
  MASTER_HEADERS,
  syncLeadToSheets,
  initSheetHeaders,
  updateLeadStatusInSheet,
  updateLeadScoreAndStatus,
  batchSyncLeads,
  findLeadRowByEmail,
  normalizePrivateKey
};
