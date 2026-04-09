/**
 * googleSheets.js — Enhanced Google Sheets Integration
 * Zynqora Edge Autonomous Agent
 *
 * Features:
 *  - syncLeadToSheets: Append new lead (with duplicate check by email)
 *  - updateLeadStatusInSheet: Update outreach status column for existing row
 *  - batchSyncLeads: Batch append multiple leads for performance
 *  - initSheetHeaders: Initialize column headers (idempotent)
 */

const { google } = require('googleapis');
const { getOAuth2Client } = require('./gmailService');

const SHEET_RANGE    = 'Sheet1';
const HEADERS        = ['Date Found', 'Business Name', 'Niche', 'Location', 'Email', 'Phone', 'Website', 'Rating', 'Reviews', 'Status', 'Outreach Status'];
const MAX_ROWS_SCAN  = 1000; // How many rows to scan for duplicates

/**
 * Get authenticated sheets client
 */
function getSheetsClient() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId || spreadsheetId === 'your_google_sheet_id_here') return null;
  const client = getOAuth2Client();
  if (!client) return null;
  return { sheets: google.sheets({ version: 'v4', auth: client }), spreadsheetId };
}

/**
 * Initialize sheet headers (safe to call multiple times)
 */
async function initSheetHeaders() {
  const ctx = getSheetsClient();
  if (!ctx) return;
  try {
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: ctx.spreadsheetId,
      range: `${SHEET_RANGE}!A1:K1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] }
    });
    console.log('✅ Google Sheet headers initialized.');
  } catch (e) {
    // Silently fail — headers may already exist
  }
}

/**
 * Find the row number (1-indexed) of a lead by email address.
 * Returns null if not found.
 */
async function findLeadRowByEmail(email) {
  if (!email) return null;
  const ctx = getSheetsClient();
  if (!ctx) return null;

  try {
    const res = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: ctx.spreadsheetId,
      range: `${SHEET_RANGE}!E2:E${MAX_ROWS_SCAN}` // Email column
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toLowerCase() === email.toLowerCase()) {
        return i + 2; // +2 because we start at row 2 (row 1 = headers)
      }
    }
  } catch (e) {
    console.error('❌ Sheet duplicate check error:', e.message);
  }
  return null;
}

/**
 * Sync a single lead to Google Sheets.
 * Skips if a row with the same email already exists.
 */
async function syncLeadToSheets(lead) {
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };

  try {
    // Duplicate check
    if (lead.email) {
      const existingRow = await findLeadRowByEmail(lead.email);
      if (existingRow) {
        console.log(`📊 Lead already in sheet (row ${existingRow}): ${lead.business_name}`);
        return { success: true, skipped: true };
      }
    }

    const values = [[
      new Date().toLocaleString(),
      lead.business_name  || '',
      lead.niche          || '',
      lead.location       || '',
      lead.email          || 'N/A',
      lead.phone          || 'N/A',
      lead.website        || 'N/A',
      lead.rating         || 0,
      lead.review_count   || 0,
      lead.status         || 'new',
      'pending'           // Outreach Status
    ]];

    const response = await ctx.sheets.spreadsheets.values.append({
      spreadsheetId: ctx.spreadsheetId,
      range: `${SHEET_RANGE}!A:K`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    const updatedRange = response.data.updates?.updatedRange || 'unknown';
    console.log(`📊 Lead synced to Sheet: ${lead.business_name} (${updatedRange})`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Sheet sync error:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Update the "Outreach Status" column (column K) for an existing lead row.
 * Status values: 'pending' | 'sent' | 'replied' | 'followed_up'
 */
async function updateLeadStatusInSheet(email, outreachStatus) {
  if (!email) return { success: false, message: 'No email provided' };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };

  try {
    const rowNumber = await findLeadRowByEmail(email);
    if (!rowNumber) {
      return { success: false, message: 'Lead not found in sheet' };
    }

    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: ctx.spreadsheetId,
      range: `${SHEET_RANGE}!K${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[outreachStatus]] }
    });

    console.log(`📊 Updated outreach status → ${outreachStatus} for row ${rowNumber}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Sheet status update error:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Batch sync multiple leads to Google Sheets (performance optimized).
 * Filters out duplicates before appending.
 */
async function batchSyncLeads(leads) {
  if (!leads || leads.length === 0) return { success: true, synced: 0 };
  const ctx = getSheetsClient();
  if (!ctx) return { success: false, message: 'Google Sheet not configured' };

  try {
    // Fetch existing emails for bulk dedup check
    const res = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: ctx.spreadsheetId,
      range: `${SHEET_RANGE}!E2:E${MAX_ROWS_SCAN}`
    });
    const existingEmails = new Set(
      (res.data.values || []).map(r => (r[0] || '').toLowerCase())
    );

    // Filter out duplicates
    const newLeads = leads.filter(l => {
      if (!l.email) return true; // No email = can't dedup, include it
      return !existingEmails.has(l.email.toLowerCase());
    });

    if (newLeads.length === 0) {
      console.log('📊 Batch sync: all leads already in sheet.');
      return { success: true, synced: 0 };
    }

    const values = newLeads.map(lead => [
      new Date().toLocaleString(),
      lead.business_name  || '',
      lead.niche          || '',
      lead.location       || '',
      lead.email          || 'N/A',
      lead.phone          || 'N/A',
      lead.website        || 'N/A',
      lead.rating         || 0,
      lead.review_count   || 0,
      lead.status         || 'new',
      'pending'
    ]);

    await ctx.sheets.spreadsheets.values.append({
      spreadsheetId: ctx.spreadsheetId,
      range: `${SHEET_RANGE}!A:K`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    console.log(`📊 Batch synced ${newLeads.length} leads to Google Sheets.`);
    return { success: true, synced: newLeads.length };
  } catch (error) {
    console.error(`❌ Batch sheet sync error:`, error.message);
    return { success: false, message: error.message };
  }
}

module.exports = {
  syncLeadToSheets,
  initSheetHeaders,
  updateLeadStatusInSheet,
  batchSyncLeads,
  findLeadRowByEmail
};
