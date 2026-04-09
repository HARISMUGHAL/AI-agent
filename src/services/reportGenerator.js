const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getLeadsCreatedToday, updateLeadStatus } = require('../database/db');
const { sendEmail, isAuthenticated } = require('./gmailService');

let genAI = null;

function getModel() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

/**
 * Generate and send the "Lead-to-Inbox" daily report
 */
async function sendDailyReport() {
  console.log('📊 Generating daily lead report...');
  
  if (!isAuthenticated()) {
    console.log('⚠️  Gmail not authenticated. Cannot send daily report.');
    return { success: false, message: 'Gmail not authenticated' };
  }

  const todayLeads = getLeadsCreatedToday();
  if (todayLeads.length === 0) {
    console.log('✅ No new leads found today. Skipping report.');
    return { success: true, message: 'No new leads' };
  }

  const model = getModel();
  if (!model) {
    console.log('⚠️  Gemini API not configured. Cannot generate detailed report.');
    return { success: false, message: 'Gemini not configured' };
  }

  const recipient = process.env.REPORT_RECIPIENT || 'Irtazamir728@gmail.com';
  const date = new Date().toLocaleDateString();

  // Prepare leads info for the AI
  const leadsContext = todayLeads.map(l => ({
    id: l.id,
    name: l.business_name,
    niche: l.niche,
    location: l.location,
    phone: l.phone,
    website: l.website,
    service: l.service_type || 'AI Automation'
  }));

  const prompt = `
    You are a Lead Liaison agent. Analyze these ${todayLeads.length} leads found today:
    ${JSON.stringify(leadsContext, null, 2)}

    TASK:
    1. Identify the "Warmest" (Top Priority) lead.
    2. Provide a 1-sentence reason why they are high-quality.
    3. Generate a personalized "First Touch" message using the template:
       "Hi [Lead Name], I noticed your work on [Specific Project/Topic]. I’ve helped similar businesses in [Industry] solve [Pain Point], and I’d love to share a few ideas with you. Do you have 5 minutes this week?"
       (Customize the bracketed parts specifically for THIS lead).

    Respond ONLY in JSON (no markdown block formatting):
    {
      "topLeadId": number,
      "whyThem": "string",
      "firstTouch": "string"
    }
  `;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const analysis = JSON.parse(jsonStr);

    const topLead = todayLeads.find(l => l.id === analysis.topLeadId) || todayLeads[0];
    const otherLeads = todayLeads.filter(l => l.id !== topLead.id);

    const emailBody = `
⚡ ${date} Lead Report: ${todayLeads.length} New Opportunities Found

Hello, here is your lead summary for today:

🔥 Top Priority Lead:
* Name: ${topLead.business_name}
* Location: ${topLead.location || 'N/A'}
* Phone: ${topLead.phone || 'N/A'}
* Pitched Service: ${topLead.service_type || 'AI Automation'}
* Why them? ${analysis.whyThem}
* Suggested "First Touch" Message:
> "${analysis.firstTouch}"

📊 All Other Leads:
${otherLeads.map(l => `* ${l.business_name} | ${l.niche} | ${l.location || 'N/A'} | ${l.phone || 'N/A'} | ${l.website || 'No website'}`).join('\n')}

Next Steps:
I have updated the "Status" column in your Sheet to 'Reported'. I will follow up on these specifically during the 2:00 PM session.
    `.trim();

    const subject = `⚡ ${date} Lead Report: ${todayLeads.length} New Opportunities Found`;
    
    await sendEmail(recipient, subject, emailBody);

    // Update status to 'reported'
    for (const lead of todayLeads) {
      updateLeadStatus(lead.id, 'reported');
    }

    console.log(`✅ Daily report sent to ${recipient} for ${todayLeads.length} leads.`);
    return { success: true, count: todayLeads.length };

  } catch (error) {
    console.error('❌ Error generating daily report with AI:', error.message);
    
    // Fallback to basic report
    const fallbackResult = await sendBasicReport(todayLeads, recipient, date);
    return fallbackResult;
  }
}

/**
 * Fallback: Generate a simple report without AI
 */
async function sendBasicReport(leads, recipient, date) {
  const topLead = leads[0];
  const otherLeads = leads.slice(1);
  const subject = `⚡ ${date} Lead Report: ${leads.length} New Opportunities Found (Basic)`;

  const emailBody = `
⚡ ${date} Lead Report: ${leads.length} New Opportunities Found

Hello, here is your lead summary for today:

🔥 Top Priority Lead:
* Name: ${topLead.business_name}
* Location: ${topLead.location || 'N/A'}
* Phone: ${topLead.phone || 'N/A'}
* Pitched Service: ${topLead.service_type || 'AI Automation'}
* Suggested "First Touch" Message:
> "Hi ${topLead.business_name}, I noticed your business in ${topLead.location}. I've helped similar businesses in your industry solve lead capture problems, and I’d love to share a few ideas with you. Do you have 5 minutes this week?"

📊 All Other Leads:
${otherLeads.map(l => `* ${l.business_name} | ${l.niche} | ${l.location || 'N/A'} | ${l.phone || 'N/A'} | ${l.website || 'No website'}`).join('\n')}

Next Steps:
I have updated the "Status" column in your Sheet to 'Reported'. I will follow up on these specifically during the 2:00 PM session.
  `.trim();

  try {
    await sendEmail(recipient, subject, emailBody);
    for (const lead of leads) {
      updateLeadStatus(lead.id, 'reported');
    }
    return { success: true, count: leads.length, mode: 'basic' };
  } catch (e) {
    console.error('❌ Failed to send fallback report:', e.message);
    return { success: false, message: e.message };
  }
}

module.exports = { sendDailyReport };
