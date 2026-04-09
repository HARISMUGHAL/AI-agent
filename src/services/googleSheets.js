const { google } = require('googleapis');
const { getOAuth2Client } = require('./gmailService');

/**
 * Sync lead data to Google Sheet
 */
async function syncLeadToSheets(lead) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId || spreadsheetId === 'your_google_sheet_id_here') {
    return { success: false, message: 'Google Sheet ID not configured' };
  }

  const client = getOAuth2Client();
  if (!client) {
    return { success: false, message: 'Google OAuth not configured' };
  }

  const sheets = google.sheets({ version: 'v4', auth: client });

  try {
    // Lead data to append
    const values = [[
      new Date().toLocaleString(),
      lead.business_name,
      lead.niche,
      lead.location,
      lead.email || 'N/A',
      lead.phone || 'N/A',
      lead.website || 'N/A',
      lead.rating || 0,
      lead.review_count || 0,
      lead.status || 'new'
    ]];

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:J',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    const updatedRange = response.data.updates.updatedRange;
    console.log(`📊 Lead synced to Google Sheets: ${lead.business_name} (Location: ${updatedRange})`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error syncing to Google Sheets:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Initialize headers if needed (optional helper)
 */
async function initSheetHeaders() {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const client = getOAuth2Client();
    if (!client || !spreadsheetId) return;

    const sheets = google.sheets({ version: 'v4', auth: client });
    const headers = [['Date Found', 'Business Name', 'Niche', 'Location', 'Email', 'Phone', 'Website', 'Rating', 'Reviews', 'Status']];

    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: 'Sheet1!A1:J1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: headers }
        });
        console.log('✅ Google Sheet headers initialized.');
    } catch (e) {
        // Silently fail if headers already exist or sheet unreachable
    }
}

module.exports = { syncLeadToSheets, initSheetHeaders };
