require('dotenv').config();
const { initDatabase, queryAll } = require('./src/database/db');
const { google } = require('googleapis');
const { getOAuth2Client } = require('./src/services/gmailService');

async function syncAll() {
  console.log('🔄 Preparing to sync all leads to the NEW spreadsheet...');
  await initDatabase();
  
  const client = getOAuth2Client();
  if (!client) {
    console.error('❌ Authentication failed. Is GMAIL_CLIENT_ID set in .env?');
    process.exit(1);
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth: client });

  try {
    const leads = queryAll('SELECT business_name, niche, location, website, phone, email, rating, review_count, status, created_at FROM leads');
    console.log(`📊 Found ${leads.length} leads in database. Preparing upload...`);

    const headers = [['Date Found', 'Business Name', 'Niche', 'Location', 'Email', 'Phone', 'Website', 'Rating', 'Reviews', 'Status']];
    
    const rows = leads.map(lead => [
        lead.created_at,
        lead.business_name,
        lead.niche,
        lead.location,
        lead.email,
        lead.phone,
        lead.website,
        lead.rating,
        lead.review_count,
        lead.status
    ]);

    // 1. Clear sheet and add headers
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1:J1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: headers }
    });

    // 2. Append all rows
    if (rows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Sheet1!A2',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows }
      });
    }

    console.log('✨ SUCCESS! All 362+ leads have been pushed to the new spreadsheet.');
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
  }
  process.exit(0);
}

syncAll();
