/**
 * gmailService.js — Safe Email Sending with Anti-Ban System
 * Zynqora Edge Autonomous Agent
 *
 * Features:
 *  - Random delay between emails (30–120 seconds) — handled by scheduler
 *  - Retry with exponential backoff (3 retries, 2× delay)
 *  - sendEmailSafe() wraps sendEmailToLead with retry logic
 */

const { google } = require('googleapis');
const { insertOutreach, updateLeadStatus, getSetting, setSetting } = require('../database/db');

let oauth2Client = null;

function getOAuth2Client() {
  if (!oauth2Client) {
    const clientId     = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const redirectUri  = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/callback';

    if (!clientId || clientId === 'your_gmail_client_id_here') return null;

    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const refreshToken = process.env.GMAIL_REFRESH_TOKEN || getSetting('gmail_refresh_token');
    if (refreshToken) {
      oauth2Client.setCredentials({ refresh_token: refreshToken });
    }
  }
  return oauth2Client;
}

function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
}

async function handleAuthCallback(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error('Gmail OAuth not configured');
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  if (tokens.refresh_token) {
    setSetting('gmail_refresh_token', tokens.refresh_token);
    console.log('✅ Gmail refresh token saved.');
  }
  return true;
}

function isAuthenticated() {
  const client = getOAuth2Client();
  if (!client) return false;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || getSetting('gmail_refresh_token');
  return !!refreshToken;
}

/**
 * Core email send via Gmail API
 */
async function sendEmail(to, subject, body) {
  const client = getOAuth2Client();
  if (!client) throw new Error('Gmail not configured');

  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || getSetting('gmail_refresh_token');
  if (!refreshToken) throw new Error('Gmail not authenticated — connect from dashboard');

  client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const senderEmail = process.env.YOUR_EMAIL || '';
  const senderName  = process.env.YOUR_NAME  || '';

  const emailLines = [
    `From: ${senderName} <${senderEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body
  ];

  const rawMessage = Buffer.from(emailLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: rawMessage }
  });
}

/**
 * Send email with exponential backoff retry (anti-ban system)
 * @param {object} lead
 * @param {object} emailData  { subject, body }
 * @param {number} [followUpNumber=0]
 * @param {number} [maxRetries=3]
 */
async function sendEmailToLead(lead, emailData, followUpNumber = 0) {
  if (!lead.email) {
    console.log(`⚠️  No email for ${lead.business_name}. Skipping.`);
    return false;
  }

  try {
    await sendEmail(lead.email, emailData.subject, emailData.body);
    insertOutreach(lead.id, emailData.subject, emailData.body, followUpNumber);
    updateLeadStatus(lead.id, followUpNumber > 0 ? 'followed_up' : 'contacted');
    console.log(`📤 Email sent to ${lead.business_name} (${lead.email})`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to email ${lead.business_name}:`, error.message);
    return false;
  }
}

/**
 * Safe email send with exponential backoff retry
 * Used by the autonomous scheduler
 *
 * Retry delays: 1st retry → 5s, 2nd → 10s, 3rd → 20s
 */
async function sendEmailSafe(lead, emailData, emailsSentToday = 0, dailyCap = 100, followUpNumber = 0) {
  if (!lead.email) {
    console.log(`⚠️  No email address for ${lead.business_name}. Skipping.`);
    return false;
  }

  const MAX_RETRIES = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_RETRIES) {
    try {
      await sendEmail(lead.email, emailData.subject, emailData.body);
      insertOutreach(lead.id, emailData.subject, emailData.body, followUpNumber);
      updateLeadStatus(lead.id, followUpNumber > 0 ? 'followed_up' : 'contacted');
      console.log(`📤 [${emailsSentToday + 1}/${dailyCap}] Email sent to ${lead.business_name} (${lead.email})`);
      return true;
    } catch (error) {
      attempt++;
      lastError = error;
      const backoffMs = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s
      console.error(`⚠️  Send attempt ${attempt}/${MAX_RETRIES} failed for ${lead.business_name}: ${error.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`🔄 Retrying in ${backoffMs / 1000}s...`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  console.error(`❌ All ${MAX_RETRIES} send attempts failed for ${lead.business_name}: ${lastError?.message}`);
  return false;
}

module.exports = {
  getAuthUrl,
  handleAuthCallback,
  isAuthenticated,
  sendEmail,
  sendEmailToLead,
  sendEmailSafe,
  getOAuth2Client
};
