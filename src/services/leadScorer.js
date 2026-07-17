const { GoogleGenerativeAI } = require('@google/generative-ai');
const { updateLeadScore, updateLeadStatus, getUnscoredLeads, isDataCollectionOnly } = require('../database/db');

const MIN_LEAD_SCORE = parseInt(process.env.MIN_LEAD_SCORE || '65', 10);

function scoreUsLead(lead, audit = {}) {
  let score = 0;
  const reasons = [];
  const add = (condition, points, reason) => { if (condition) { score += points; reasons.push(reason); } };
  add(!audit.has_website, 40, 'No website is publicly listed');
  add(['broken', 'unreachable'].includes(audit.website_status), 35, `Website status: ${audit.website_status}`);
  add(audit.has_website && !audit.has_https, 10, 'Website does not use HTTPS');
  add(audit.has_website && !audit.has_mobile_viewport, 20, 'Mobile viewport meta tag missing');
  add(audit.has_website && !audit.has_contact_form, 15, 'Contact form not detected');
  add(audit.has_website && !audit.has_booking_system && !audit.has_ordering_system, 15, 'Booking/order system not detected');
  add(audit.has_website && !audit.has_cta, 10, 'Clear CTA not detected');
  add(audit.has_website && !audit.has_chatbot, 10, 'Chatbot not detected');
  add(audit.has_website && !audit.has_visible_phone && !audit.has_visible_email, 10, 'Visible phone/email not detected');
  add(audit.slow_response, 10, `Slow response (${audit.response_time_ms || 0}ms)`);
  add(audit.has_website && !audit.page_title, 5, 'Page title missing');
  add(audit.has_website && !audit.meta_description, 5, 'Meta description missing');
  add(audit.placeholder_content, 20, 'Broken or placeholder content detected');
  score = Math.min(100, score);
  const priority = score >= 80 ? 'High' : score >= 60 ? 'Medium' : 'Needs Manual Verification';
  let recommendedService = 'inquiry automation';
  if (!audit.has_website) recommendedService = 'new website';
  else if (['broken', 'unreachable'].includes(audit.website_status) || !audit.has_mobile_viewport || !audit.has_https) recommendedService = 'website redesign';
  else if (!audit.has_chatbot && (!audit.has_contact_form || !audit.has_cta)) recommendedService = 'combined web and AI solution';
  else if (!audit.has_chatbot) recommendedService = 'AI chatbot';
  else if (!audit.has_booking_system && !audit.has_ordering_system) recommendedService = 'booking automation';
  else if (!audit.has_contact_form) recommendedService = 'lead capture automation';
  return { lead_score: score, priority, recommended_service: recommendedService, ai_opportunity: reasons.join('; '), why_this_lead: reasons.join('; ') };
}

const APPOINTMENT_NICHES = [
  'restaurant', 'dental', 'medical', 'clinic', 'aesthetic', 'salon', 'spa',
  'barber', 'gym', 'real estate', 'law', 'auto repair', 'home service',
  'property management', 'retail', 'tutoring', 'professional'
];

const HIGH_INQUIRY_NICHES = [
  'dental', 'medical', 'law', 'real estate', 'auto repair', 'home service', 'clinic'
];

let genAI = null;

function getModel() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

function nicheMatches(lead, keywords) {
  const niche = (lead.niche || '').toLowerCase();
  return keywords.some(k => niche.includes(k));
}

function qualifyLeadForDataMode(lead, websiteAudit = {}) {
  const audit = websiteAudit || {};
  let aiOpportunityScore = 0;
  const aiReasons = [];

  if (nicheMatches(lead, APPOINTMENT_NICHES)) {
    aiOpportunityScore += 25;
    aiReasons.push('appointment/booking-based business');
  }
  if (nicheMatches(lead, HIGH_INQUIRY_NICHES)) {
    aiOpportunityScore += 10;
    aiReasons.push('high customer-inquiry category');
  }
  if (!audit.has_chatbot) {
    aiOpportunityScore += 15;
    aiReasons.push('no chatbot/automated response detected');
  }
  if (!audit.has_booking_system && !audit.has_ordering_system) {
    aiOpportunityScore += 15;
    aiReasons.push('no online booking/ordering system');
  }
  if (lead.phone && !audit.has_contact_form) {
    aiOpportunityScore += 10;
    aiReasons.push('phone/manual inquiry dependent');
  }
  if (lead.phone && lead.email) {
    aiOpportunityScore += 5;
    aiReasons.push('multiple contact channels needing routing');
  }
  if (!audit.has_website) {
    aiOpportunityScore += 20;
    aiReasons.push('no website — high digital opportunity');
  }

  aiOpportunityScore = Math.min(100, aiOpportunityScore);
  const needsAiServices = aiOpportunityScore >= 50;

  const needsWebsite = audit.needs_website || !audit.has_website || !lead.website;
  const needsRedesign = audit.needs_website_redesign || audit.website_status === 'outdated' || audit.website_status === 'broken';

  let leadScore = 0;
  const rating = parseFloat(lead.rating) || 0;
  const reviews = parseInt(lead.review_count, 10) || 0;

  if (rating >= 3.5 && rating <= 4.8) leadScore += 15;
  if (reviews >= 5) leadScore += 10;
  if (reviews >= 20) leadScore += 5;
  if (lead.email) leadScore += 15;
  else if (lead.phone) leadScore += 8;
  if (lead.website) leadScore += 5;
  leadScore += Math.round((audit.website_opportunity_score || 0) * 0.25);
  leadScore += Math.round(aiOpportunityScore * 0.25);
  if (nicheMatches(lead, APPOINTMENT_NICHES)) leadScore += 10;
  if (lead.country === 'United States' || lead.country === 'United Kingdom') leadScore += 10;
  leadScore = Math.min(100, leadScore);

  let recommendedService = 'combined_web_and_ai_solution';
  if (needsWebsite) recommendedService = 'new_website';
  else if (needsRedesign && needsAiServices) recommendedService = 'combined_web_and_ai_solution';
  else if (needsRedesign) recommendedService = 'website_redesign';
  else if (!audit.has_booking_system) recommendedService = 'booking_automation';
  else if (!audit.has_chatbot) recommendedService = 'ai_chatbot';
  else if (needsAiServices) recommendedService = 'inquiry_automation';
  else recommendedService = 'lead_capture_automation';

  const passed = leadScore >= MIN_LEAD_SCORE &&
    (needsWebsite || needsRedesign || needsAiServices);

  const qualificationReason = passed
    ? `Qualified: lead_score=${leadScore}, ai_score=${aiOpportunityScore}. ${aiReasons.join('; ')}`
    : `Rejected: lead_score=${leadScore} (min ${MIN_LEAD_SCORE}) or no opportunity flags`;

  return {
    passed,
    lead_score: leadScore,
    ai_opportunity_score: aiOpportunityScore,
    needs_ai_services: needsAiServices,
    needs_website: needsWebsite,
    needs_website_redesign: needsRedesign,
    recommended_service: recommendedService,
    qualification_reason: qualificationReason,
    website_status: audit.website_status || (lead.website ? 'unknown' : 'no_website'),
    website_issues: audit.website_issues || [],
    website_evidence: audit.website_evidence || [],
    contact_method: lead.email ? 'email' : (lead.phone ? 'phone' : 'unknown'),
    contact_page_url: audit.contact_page_url || '',
    alternate_email: ''
  };
}

async function scoreLead(lead) {
  if (isDataCollectionOnly()) {
    return qualifyLeadForDataMode(lead, {});
  }
  const model = getModel();
  if (!model) {
    console.log('⚠️  Gemini API key not configured. Using basic scoring.');
    return basicScore(lead);
  }

  const prompt = `You are a lead qualification expert for a company that sells two services:
1. **AI Agent Solutions** — chatbots, booking systems, lead handling automation
2. **WhatsApp Marketing/Automation** — customer communication, broadcasts, auto-replies

Analyze this business and score them as a potential client:

Business Name: ${lead.business_name}
Niche: ${lead.niche}
Location: ${lead.location}
Website: ${lead.website || 'NO WEBSITE'}
Phone: ${lead.phone || 'Not listed'}
Rating: ${lead.rating}/5 (${lead.review_count} reviews)

Score them 1-100 based on how LIKELY they need our services.
Also decide which service fits better: "AI Agent" or "WhatsApp Automation" or "Both"

Respond ONLY in this exact JSON format (no markdown):
{
  "score": 75,
  "service_type": "AI Agent",
  "recommendation": "Target this business — they have no website and would benefit from an AI booking agent.",
  "reasoning": "Being a salon without a website or online booking system, they are losing customers."
}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const analysis = JSON.parse(jsonStr);
    const score = Math.min(100, Math.max(1, analysis.score));
    updateLeadScore(lead.id, score, analysis.service_type, analysis.recommendation, analysis.reasoning);
    return analysis;
  } catch (error) {
    console.error(`❌ Error scoring lead ${lead.business_name}:`, error.message);
    return basicScore(lead);
  }
}

function basicScore(lead) {
  let score = 50;
  if (!lead.website) score += 25;
  if (!lead.phone) score += 5;
  if (lead.rating < 3.5) score += 10;
  if (lead.review_count < 20) score += 10;
  const highNeedNiches = ['salons', 'restaurants', 'gyms', 'clinics', 'spas', 'tutoring'];
  if (highNeedNiches.some(n => lead.niche?.toLowerCase().includes(n))) score += 10;
  score = Math.min(100, score);
  const service_type = ['restaurants', 'salons', 'spas', 'gyms'].some(n => lead.niche?.toLowerCase().includes(n))
    ? 'WhatsApp Automation' : 'AI Agent';
  const result = {
    score,
    service_type,
    recommendation: `Target this business — ${!lead.website ? 'they have no website' : 'they could improve their online presence'}.`,
    reasoning: `Basic scoring applied. ${lead.niche} businesses in ${lead.location} typically need digital growth tools.`
  };
  updateLeadScore(lead.id, result.score, result.service_type, result.recommendation, result.reasoning);
  return result;
}

async function scoreAllLeads() {
  if (isDataCollectionOnly()) {
    console.log('✅ Data collection mode — use qualifyLeadForDataMode in pipeline.');
    return 0;
  }
  const leads = getUnscoredLeads();
  if (leads.length === 0) {
    console.log('✅ No unscored leads to process.');
    return 0;
  }
  console.log(`\n📊 Scoring ${leads.length} leads (threshold: ≥${MIN_LEAD_SCORE})...`);
  let scored = 0, passed = 0, rejected = 0;
  for (const lead of leads) {
    const analysis = await scoreLead(lead);
    scored++;
    if (analysis.score < MIN_LEAD_SCORE) {
      updateLeadStatus(lead.id, 'skipped');
      rejected++;
    } else {
      passed++;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`✅ Scoring complete: ${scored} total | ${passed} passed | ${rejected} rejected`);
  return passed;
}

module.exports = { scoreLead, scoreAllLeads, qualifyLeadForDataMode, scoreUsLead, MIN_LEAD_SCORE };
