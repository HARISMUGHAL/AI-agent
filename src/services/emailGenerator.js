/**
 * emailGenerator.js — Phase 3: AI-Powered Personalization Engine
 * Zynqora Edge Autonomous Agent
 *
 * Upgrade summary:
 *  - High-conversion copywriting prompt with full lead context
 *  - AI returns { subject_lines[], email_body, follow_up } → we pick 1 subject randomly
 *  - follow_up stored in DB (whatsapp_draft column) for dispatch 2–3 days later
 *  - AI provider abstraction: swap Gemini → OpenAI by changing getAIModel()
 *  - Fallback template if AI fails — same output shape, never crashes
 *  - DO NOT modify Gmail sending logic, scheduler timing, or DB schema
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  updateLeadEmail,
  updateLeadWhatsApp,
  markDraftsReady,
  getLeadsByStatus
} = require('../database/db');

// ─── AI Provider Abstraction ──────────────────────────────────────────────────
// To switch to OpenAI: replace this function only.
// Keep the same interface: returns an object with generateContent(prompt) → { text }
// ─────────────────────────────────────────────────────────────────────────────
let _geminiInstance = null;

function getAIModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;

  if (!_geminiInstance) {
    _geminiInstance = new GoogleGenerativeAI(apiKey);
  }
  const model = _geminiInstance.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Normalised interface — makes future OpenAI swap a 1-file change
  return {
    async generateContent(prompt) {
      const result = await model.generateContent(prompt);
      return { text: result.response.text().trim() };
    }
  };
}

// ─── Sender Context ───────────────────────────────────────────────────────────
function getSenderContext() {
  return {
    name:    process.env.YOUR_NAME    || 'Alex',
    company: process.env.YOUR_COMPANY || 'Your Company',
    website: process.env.YOUR_WEBSITE || '',
    phone:   process.env.YOUR_PHONE   || ''
  };
}

// ─── Signature Block ──────────────────────────────────────────────────────────
function buildSignature(sender) {
  const lines = [`\n\nBest regards,\n${sender.name}\n${sender.company}`];
  if (sender.website) lines.push(sender.website);
  if (sender.phone)   lines.push(sender.phone);
  return lines.join('\n');
}

// ─── JSON Parser (tolerant) ───────────────────────────────────────────────────
function safeParseJSON(raw) {
  try {
    // Strip markdown fences if present
    const cleaned = raw
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

// ─── Main Prompt (high-conversion copywriting framework) ─────────────────────
/**
 * Builds the Phase 3 personalization prompt.
 * Injects all available lead context so the AI writes as if it knows the business.
 */
function buildPersonalizationPrompt(lead, sender) {
  const ratingLine = lead.rating
    ? `${lead.rating}/5 stars (${lead.review_count || 0} reviews)`
    : `Unrated — newer business`;

  const websiteLine = lead.website
    ? `Has a website: ${lead.website} (may be outdated or lack automation)`
    : `No website detected — high-value opportunity`;

  const serviceLine = lead.service_type || 'AI Automation / WhatsApp Marketing';

  return `You are a world-class B2B copywriter specialising in high-conversion cold outreach for digital transformation services.

Write a personalised cold outreach email for the following business. Use the context below to make the email feel like it was written specifically for them — not blasted to a list.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEAD CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Business Name:  ${lead.business_name}
Industry:       ${lead.niche || 'Local Business'}
Location:       ${lead.location || 'their city'}
Reputation:     ${ratingLine}
Online Status:  ${websiteLine}
Our Offering:   ${serviceLine}
Sender:         ${sender.name}, ${sender.company}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
COPYWRITING FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Apply this structure precisely:

1. HOOK (line 1):
   - If rating ≥ 4.0: open with a genuine compliment on their reputation in ${lead.location || 'their area'}.
   - If rating < 4.0 or missing: open with a provocative industry insight — e.g. "${lead.niche || 'local'} businesses are losing 30% of leads by not responding within 60 seconds."

2. PROBLEM (1–2 sentences):
   Identify the specific growth gap for a ${lead.niche || 'local business'} at their stage. 
   Reference their rating/review count naturally. Do NOT sound generic.

3. SOLUTION (2–3 sentences):
   Explain how ${sender.company} solves this with ${serviceLine}.
   Be specific — mention one concrete outcome (e.g. "bookings increase 40% in 30 days").

4. SOCIAL PROOF (1 sentence):
   Brief, credible claim — e.g. "We've helped 20+ ${lead.niche || 'local'} businesses in ${lead.location || 'your region'} double their inquiry-to-booking rate."

5. CTA (1 sentence):
   Soft ask — "Would a 10-minute call to show you exactly how this works make sense this week?"

EMAIL CONSTRAINTS:
- MUST include ${lead.business_name}, ${lead.niche || 'your industry'}, and ${lead.location || 'your location'} naturally.
- Max 150 words in the body
- Professional but conversational tone
- NO marketing jargon (e.g. "synergize", "leverage", "unlock")
- NO exclamation marks
- Use "you/your" not "your business"

━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOLLOW-UP MESSAGE (for 2–3 days later)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write a SHORT follow-up (80 words max) that:
- References the first email without re-selling
- Adds one new piece of value or a quick question
- Ends with a soft CTA

━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT (strict JSON, no markdown, no extra text)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "subject_lines": [
    "Subject option 1 (curiosity-based)",
    "Subject option 2 (result-focused)",
    "Subject option 3 (personalised to their name/niche)"
  ],
  "email_body": "Full email body here. Use \\n for line breaks. Do NOT include subject or greeting — start from the hook.",
  "follow_up": "Follow-up message body here. Use \\n for line breaks."
}`;
}

// ─── Follow-Up Prompt ─────────────────────────────────────────────────────────
function buildFollowUpPrompt(lead, sender) {
  return `You are a senior B2B sales consultant writing a concise follow-up email.

CONTEXT:
- Business: ${lead.business_name} (${lead.niche || 'local business'} in ${lead.location || 'their city'})
- We sent them an email 2–3 days ago about ${lead.service_type || 'AI Automation / WhatsApp Marketing'}
- No reply received yet
- Sender: ${sender.name}, ${sender.company}

Write a SHORT follow-up (80 words max) that:
1. Opens with a brief reference to the previous email (no re-selling)
2. Adds ONE new compelling insight or question specific to ${lead.niche || 'their industry'}
3. Ends with a soft, low-friction CTA

OUTPUT FORMAT (strict JSON, no markdown):
{
  "subject_lines": [
    "Follow-up subject option 1",
    "Follow-up subject option 2"
  ],
  "email_body": "Follow-up body here. Use \\n for line breaks.",
  "follow_up": ""
}`;
}

// ─── Core Generation Function ─────────────────────────────────────────────────
/**
 * Generate a personalised email for a lead.
 *
 * Returns { subject, body } — the single selected email ready for sending.
 * Stores follow_up in whatsapp_draft column for 2–3 day dispatch.
 * Falls back gracefully on AI failure — never throws.
 *
 * @param {object}  lead         Lead object from DB
 * @param {boolean} isFollowUp   true = generate follow-up email instead
 */
async function generateEmailForLead(lead, isFollowUp = false) {
  const sender = getSenderContext();
  const ai     = getAIModel();

  if (!ai) {
    console.log(`⚠️  AI not configured. Using fallback template for ${lead.business_name}.`);
    return generateFallbackEmail(lead, sender, isFollowUp);
  }

  const prompt = isFollowUp
    ? buildFollowUpPrompt(lead, sender)
    : buildPersonalizationPrompt(lead, sender);

  try {
    const { text } = await ai.generateContent(prompt);
    const parsed   = safeParseJSON(text);

    if (!parsed || !Array.isArray(parsed.subject_lines) || !parsed.email_body || parsed.email_body.trim() === '') {
      console.warn(`⚠️  AI returned invalid or empty format for ${lead.business_name}. Using fallback.`);
      return generateFallbackEmail(lead, sender, isFollowUp);
    }

    // RULE 1: Randomly pick one subject line from the array
    const subjectLines = parsed.subject_lines.filter(s => s && s.trim() !== '');
    if (subjectLines.length === 0) {
      return generateFallbackEmail(lead, sender, isFollowUp);
    }
    const subject = subjectLines[Math.floor(Math.random() * subjectLines.length)];
    const body    = parsed.email_body.trim() + buildSignature(sender);

    // RULE 2 & 3: Output Validation & Follow-up Protection
    if (!subject || !body) {
      return generateFallbackEmail(lead, sender, isFollowUp);
    }

    // ONLY store follow_up ONCE. Do NOT overwrite existing.
    const existingFollowUp = lead.whatsapp_draft ? safeParseJSON(lead.whatsapp_draft) : null;
    if (existingFollowUp && existingFollowUp.subject && existingFollowUp.body) {
      console.log(`🔒 Lead ${lead.business_name} already has a follow-up. Preserving it.`);
      // No need to update DB for whatsapp_draft
    } else {
      const followUpText = (parsed.follow_up || '').trim();
      if (followUpText !== '') {
        const followUpObj  = {
          subject: subjectLines[subjectLines.length - 1] || `Quick follow-up — ${lead.business_name}`,
          body:    followUpText + buildSignature(sender)
        };
        updateLeadWhatsApp(lead.id, JSON.stringify(followUpObj));
      }
    }

    updateLeadEmail(lead.id, JSON.stringify({ subject, body }));
    markDraftsReady(lead.id);

    console.log(`✉️  Generated email for ${lead.business_name} | Subject: "${subject}"`);
    return { subject, body };

  } catch (error) {
    console.error(`❌ AI generation failed for ${lead.business_name}: ${error.message}`);
    return generateFallbackEmail(lead, sender, isFollowUp);
  }
}

// ─── Fallback Templates ───────────────────────────────────────────────────────
/**
 * RULE 6: Fallback on AI failure.
 * Outputs the same shape as the AI path — never crashes the pipeline.
 * Falls back by niche then to a universal template.
 */
const FALLBACK_TEMPLATES = {
  restaurants: {
    subjects: [
      `A growth gap I noticed at ${'{name}'}`,
      `${'{name}'}: are you capturing every table reservation inquiry?`,
      `Quick question about ${'{name}'}'s online bookings`
    ],
    hook: `Restaurants with {rating} stars on Google are often at a turning point — strong enough to attract interest, but losing a significant share of inquiries by not responding fast enough.`,
    problem: `Most {niche} businesses in {location} are missing 20–40% of prospective bookings simply because initial inquiries go unanswered for hours.`,
    solution: `At {company}, we implement {service} that handles every inquiry in seconds — 24/7 — ensuring your {rating}-star reputation converts into actual revenue.`,
    cta: `Would a 10-minute call to walk through exactly how this works make sense for you this week?`
  },
  salons: {
    subjects: [
      `${'{name}'}: a quick observation about your booking flow`,
      `Salons in {location} and the 30% inquiry drop-off`,
      `A question about how ${'{name}'} handles new client inquiries`
    ],
    hook: `Salons with a strong reputation like {name} face a common challenge: the gap between when a potential client reaches out and when they actually get a response.`,
    problem: `In the beauty industry, 67% of clients book with whoever responds first. A delayed reply means the appointment goes to a competitor.`,
    solution: `{company} builds {service} that captures and responds to every inquiry instantly — so {name} books more clients without adding staff.`,
    cta: `Can I show you a 10-minute demo of how this works for {niche} businesses specifically?`
  },
  default: {
    subjects: [
      `Something I noticed about ${'{name}'}`,
      `${'{name}'}: a growth opportunity worth 10 minutes`,
      `Quick question for the team at ${'{name}'}`
    ],
    hook: `I came across {name} while researching {niche} businesses in {location} — your {rating}-star reputation makes you stand out in a crowded market.`,
    problem: `Most {niche} businesses at your stage are losing potential clients in the gap between initial inquiry and first response — often 30–70% of inbound interest.`,
    solution: `{company} specialises in {service} that closes this gap. Our clients typically see a 35–50% increase in inquiry-to-client conversion within the first 30 days.`,
    cta: `Would a 10-minute call to walk through what this would look like for {name} be worthwhile?`
  }
};

const FOLLOW_UP_TEMPLATE = {
  subjects: [
    `Re: ${'{name}'} — a thought I had`,
    `Following up on my note to ${'{name}'}`
  ],
  body: `Hi,\n\nI sent a note a few days ago about how {niche} businesses in {location} are handling inquiry response times — wanted to surface one specific statistic.\n\nBusinesses that respond to inquiries within 5 minutes are 9x more likely to convert that lead. Most in your space are averaging 4–24 hours.\n\nIf this is something {name} is working on, I'd love to share what's working for similar businesses.\n\nWould 10 minutes make sense?`
};

function fillTemplate(template, lead, sender) {
  const rating = lead.rating ? `${lead.rating}-star` : 'well-reviewed';
  return template
    .replace(/\{name\}/g,     lead.business_name || 'your business')
    .replace(/\{niche\}/g,    lead.niche         || 'local business')
    .replace(/\{location\}/g, lead.location      || 'your area')
    .replace(/\{rating\}/g,   rating)
    .replace(/\{company\}/g,  sender.company)
    .replace(/\{service\}/g,  lead.service_type  || 'AI Automation');
}

function generateFallbackEmail(lead, sender, isFollowUp = false) {
  if (isFollowUp) {
    const subjectPool = FOLLOW_UP_TEMPLATE.subjects.map(s => fillTemplate(s, lead, sender));
    const subject     = subjectPool[Math.floor(Math.random() * subjectPool.length)];
    const body        = fillTemplate(FOLLOW_UP_TEMPLATE.body, lead, sender) + buildSignature(sender);

    const emailObj = { subject, body };
    // Follow-up goes directly into email_draft when called from runFollowUps()
    updateLeadEmail(lead.id, JSON.stringify(emailObj));
    markDraftsReady(lead.id);
    return emailObj;
  }

  const nicheKey = (lead.niche || '').toLowerCase();
  const tpl      = Object.keys(FALLBACK_TEMPLATES).find(k => nicheKey.includes(k))
    ? FALLBACK_TEMPLATES[nicheKey] || FALLBACK_TEMPLATES.default
    : FALLBACK_TEMPLATES.default;

  // Pick random subject from pool
  const subjectPool = tpl.subjects.map(s => fillTemplate(s, lead, sender));

  // Compose body from sections
  const bodyParts = [
    `Hi,\n`,
    fillTemplate(tpl.hook,    lead, sender),
    `\n\n`,
    fillTemplate(tpl.problem, lead, sender),
    `\n\n`,
    fillTemplate(tpl.solution, lead, sender),
    `\n\n`,
    fillTemplate(tpl.cta,     lead, sender)
  ];

  // Simulate the struct of the AI output to ensure compliance
  const fallbackStruct = {
    subject_lines: subjectPool,
    email_body: bodyParts.join(''),
    follow_up: fillTemplate(FOLLOW_UP_TEMPLATE.body, lead, sender)
  };

  const subject = fallbackStruct.subject_lines[Math.floor(Math.random() * fallbackStruct.subject_lines.length)];
  const body = fallbackStruct.email_body + buildSignature(sender);

  // RULE 3: Follow-up Protection for Fallbacks too
  const existingFollowUp = lead.whatsapp_draft ? safeParseJSON(lead.whatsapp_draft) : null;
  if (!existingFollowUp || !existingFollowUp.subject || !existingFollowUp.body) {
    const followUpObj = { 
      subject: `Re: ${lead.business_name} — a thought I had`, 
      body: fallbackStruct.follow_up + buildSignature(sender) 
    };
    updateLeadWhatsApp(lead.id, JSON.stringify(followUpObj));
  }

  updateLeadEmail(lead.id, JSON.stringify({ subject, body }));
  markDraftsReady(lead.id);

  console.log(`✉️  Fallback email for ${lead.business_name} | Subject: "${subject}"`);
  return { subject, body };
}

// ─── Batch Generation ─────────────────────────────────────────────────────────
/**
 * Generate emails for all leads in 'scored' status.
 * Returns count of successfully generated drafts.
 */
async function generateAllEmails() {
  const leads = getLeadsByStatus('scored');

  if (leads.length === 0) {
    console.log('✅ No scored leads needing email generation.');
    return 0;
  }

  console.log(`\n✉️  Generating personalised emails for ${leads.length} leads...`);
  let generated = 0;
  let failed    = 0;

  for (const lead of leads) {
    try {
      await generateEmailForLead(lead);
      generated++;
    } catch (e) {
      // Should never reach here — generateEmailForLead has internal fallback
      console.error(`❌ Unexpected error for ${lead.business_name}: ${e.message}`);
      failed++;
    }

    // Pace AI calls: 1.5s between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 1500));

    if (generated % 5 === 0 && generated > 0) {
      console.log(`   ✉️  Progress: ${generated}/${leads.length} emails generated...`);
    }
  }

  console.log(`✅ Email generation complete: ${generated} generated | ${failed} failed | ${leads.length - generated - failed} skipped`);
  return generated;
}

module.exports = { generateEmailForLead, generateAllEmails };
