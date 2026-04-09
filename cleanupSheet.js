require('dotenv').config();
const { initDatabase, getSetting } = require('./src/database/db');
const { google } = require('googleapis');
const { getOAuth2Client } = require('./src/services/gmailService');

async function cleanup() {
  console.log('🧹 Preparing to cleanup Google Sheet...');
  await initDatabase();
  
  const client = getOAuth2Client();
  if (!client) {
    console.error('❌ Authentication failed. Is GMAIL_CLIENT_ID set in .env?');
    process.exit(1);
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth: client });

  try {
    console.log('🔍 Identifying empty rows...');
    const res = await sheets.spreadsheets.values.get({ 
      spreadsheetId, 
      range: 'Sheet1!A1:A500' 
    });

    const values = res.data.values || [];
    let firstDataRow = -1;
    
    // Find the first row that actually has a Lead Name (Column B is index 1)
    // Actually, Column A is Date Found. Let's find first row with data after row 1.
    for (let i = 1; i < values.length; i++) {
        if (values[i] && values[i][0]) {
            firstDataRow = i + 1;
            break;
        }
    }

    if (firstDataRow === -1) {
        // If not in first 500, we know it's at 369 from previous log
        firstDataRow = 369;
    }

    if (firstDataRow > 2) {
      console.log(`🧹 Deleting empty rows 2 through ${firstDataRow - 1}...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: 0,
                dimension: 'ROWS',
                startIndex: 1, // Row 2
                endIndex: firstDataRow - 1
              }
            }
          }]
        }
      });
      console.log('✨ Cleanup complete! Leads are now at the top.');
    } else {
      console.log('✅ Leads are already at the top or no empty rows found.');
    }

  } catch (error) {
    console.error('❌ Cleanup failed:', error.message);
  }
  process.exit(0);
}

cleanup();
