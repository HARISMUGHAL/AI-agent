const { GoogleGenerativeAI } = require('@google/generative-ai');
const { updateLeadEmail, updateLeadWhatsApp, markDraftsReady, getLeadsByStatus } = require('../database/db');

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
 * Generate a personalized email and whatsapp pitch for a lead
 */
async function generateEmailForLead(lead, isFollowUp = false) {
  const model = getModel();
  const senderName = process.env.YOUR_NAME || 'Your Name';
  const company = process.env.YOUR_COMPANY || 'Nexastra';
  const website = process.env.YOUR_WEBSITE || '';
  const phone = process.env.YOUR_PHONE || '';

  if (!model) {
    return generateBasicEmail(lead, senderName, company, website, phone, isFollowUp);
  }

  const prompt = isFollowUp
    ? `Write a SHORT follow-up message to ${lead.business_name}. Reference previous outreach. Warm, professional. End with CTA. 

We need TWO formats:
1. Follow-up Email
2. Follow-up WhatsApp Message (very short, emojis ok)

Sender: ${senderName}, ${company}

Respond ONLY in JSON (no markdown block formatting, just the raw JSON object):
{"emailSubject": "Subject line", "emailBody": "Email body", "whatsappMessage": "WhatsApp text"}`
    : `Act as a Senior Business Growth Consultant specializing in Digital Transformation. Your goal is to write a high-stakes, consultative email and WhatsApp message that secures a meeting with ${lead.business_name}.

CONTEXT:
- Business: ${lead.business_name} (${lead.niche} in ${lead.location})
- Reputation: ${lead.rating ? `${lead.rating} stars` : 'Reputed'} with ${lead.review_count || 0} customer reviews.
- Problem: They lack modern ${lead.service_type} features which their competitors are using to steal market share.
- Our Value: We help ${lead.niche} leaders like ${lead.business_name} capture and convert online interest into revenue using ${lead.service_type}.
- Sender: ${senderName}, Principal Consultant at ${company}

CATCHING THE CUSTOMER'S MIND (The "Hook"):
- If rating is high: "Congratulations on the ${lead.rating}-star reputation in ${lead.location}. That level of excellence is rare."
- If rating is missing: "I identified a significant opportunity to professionalize how ${lead.business_name} handles online inquiries."
- Niche Insight: Mention how ${lead.niche} businesses are currently losing ~30% of revenue by not responding to inquiries within 60 seconds (The "Speed-to-Lead" gap).

PROFESSIONAL STRUCTURE:
1. THE GROWTH GAP: Start with a professional observation about their current online presence.
2. THE REVENUE LEAK: Explain that 78% of customers buy from the business that responds FIRST. ${lead.service_type} ensures ${lead.business_name} is always first.
3. THE SOLUTION: Briefly explain how ${company} implements ${lead.service_type} to act as their "24/7 Digital Growth Engine."
4. THE PROFESSIONAL CTA: A 10-minute "Efficiency Audit" to show them exactly where their inquiries are dropping off.

Respond ONLY in JSON (no markdown):
{
  "emailSubject": "Growth Brief for ${lead.business_name}: Capturing missed inquiries",
  "emailBody": "Professional email body content here... with \\n for line breaks.",
  "whatsappMessage": "Short, high-impact WhatsApp pitch"
}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const generated = JSON.parse(jsonStr);

    const emailObj = {
      subject: generated.emailSubject,
      body: generated.emailBody + `\n\nBest regards,\n${senderName}\n${company}${website ? `\n${website}` : ''}${phone ? `\n${phone}` : ''}`
    };

    updateLeadEmail(lead.id, JSON.stringify(emailObj));
    updateLeadWhatsApp(lead.id, JSON.stringify({ body: generated.whatsappMessage }));
    markDraftsReady(lead.id);
    
    return emailObj;
  } catch (error) {
    console.error(`❌ Error generating messages for ${lead.business_name}:`, error.message);
    return generateBasicEmail(lead, senderName, company, website, phone, isFollowUp);
  }
}

function generateBasicEmail(lead, name, company, website, phone, isFollowUp) {
  // Professional Fallback Templates by Niche
  const templates = {
    'restaurants': {
      subject: `Strategic Growth: Automation for ${lead.business_name}`,
      body: `Hi ${lead.business_name},\n\nI’ve been analyzing the ${lead.niche} landscape in ${lead.location}, and your reputation stands out. However, I noticed a gap in how digital inquiries are being handled—which often leads to missed bookings.\n\nAt ${company}, we specialize in ${lead.service_type} that ensures every customer query is handled instantly, 24/7, turning lost leads into consistent revenue.\n\nWould you be open to a brief efficiency audit this week?\n\nBest,\n${name}`
    },
    'default': {
      subject: `Professional Inquiry regarding ${lead.business_name} Growth`,
      body: `Hi ${lead.business_name},\n\nI’ve been following your work in the ${lead.niche} sector. You have a stellar reputation, but in the current digital climate, speed-to-lead is the #1 predictor of growth.\n\nI help businesses like ${lead.business_name} implement ${lead.service_type} to automate lead capture and inquiry response, ensuring you never lose a high-value customer to a competitor due to a delayed reply.\n\nDo you have 10 minutes for a consultative chat about your current automation strategy?\n\nBest regards,\n${name}`
    }
  };

  const selected = templates[lead.niche?.toLowerCase()] || templates.default;
  const email = isFollowUp ? {
    subject: `Efficiency Follow-up — ${lead.business_name}`,
    body: `Hi,\n\nI’m following up on my previous note regarding digital growth for ${lead.business_name}. \n\nIn our experience with ${lead.niche} firms, automating initial lead handling is the fastest way to increase top-line revenue without increasing overhead.\n\nIs this a priority for your team this quarter?\n\nBest regards,\n${name}`
  } : selected;

  const wa = isFollowUp 
    ? { body: `Hi! Following up on my growth proposal for ${lead.business_name}. I'd love to share how our automation boosts inquiry conversion for ${lead.niche} leaders. Safe to chat?` }
    : { body: `Hi, I'm ${name}. I identified a lead-capture gap at ${lead.business_name} that's likely costing you revenue. I have a solution tailored for ${lead.niche} firms. Can we chat?` };

  updateLeadEmail(lead.id, JSON.stringify(email));
  updateLeadWhatsApp(lead.id, JSON.stringify(wa));
  markDraftsReady(lead.id);
  
  return email;
}

/**
 * Generate emails for all scored leads
 */
async function generateAllEmails() {
  const leads = getLeadsByStatus('scored');
  if (leads.length === 0) {
    console.log('✅ No scored leads needing message generation.');
    return 0;
  }

  console.log(`\n✉️  Generating Email & WhatsApp messages for ${leads.length} leads...`);
  let generated = 0;

  for (const lead of leads) {
    await generateEmailForLead(lead);
    generated++;
    await new Promise(r => setTimeout(r, 1500));
    if (generated % 5 === 0) console.log(`   Generated messages for ${generated} leads...`);
  }

  console.log(`✅ Generated messages for ${generated} leads.`);
  return generated;
}

module.exports = { generateEmailForLead, generateAllEmails };
