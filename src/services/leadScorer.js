const { GoogleGenerativeAI } = require('@google/generative-ai');
const { updateLeadScore, updateLeadStatus, getUnscoredLeads } = require('../database/db');

const MIN_LEAD_SCORE = 60; // Reject leads scoring below this threshold

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
 * Score a lead using Gemini AI analysis
 */
async function scoreLead(lead) {
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

/**
 * Fallback basic scoring when AI is unavailable
 */
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

/**
 * Score all unscored leads.
 * Leads scoring below MIN_LEAD_SCORE are marked 'skipped' immediately.
 */
async function scoreAllLeads() {
  const leads = getUnscoredLeads();
  if (leads.length === 0) {
    console.log('✅ No unscored leads to process.');
    return 0;
  }

  console.log(`\n📊 Scoring ${leads.length} leads (threshold: ≥${MIN_LEAD_SCORE})...`);
  let scored       = 0;
  let passed       = 0;
  let rejected     = 0;

  for (const lead of leads) {
    const analysis = await scoreLead(lead);
    scored++;

    // RULE 5 + strict filtering: drop low-quality leads from the pipeline
    if (analysis.score < MIN_LEAD_SCORE) {
      updateLeadStatus(lead.id, 'skipped');
      rejected++;
      console.log(`   📉 Rejected (score ${analysis.score} < ${MIN_LEAD_SCORE}): ${lead.business_name}`);
    } else {
      passed++;
    }

    await new Promise(r => setTimeout(r, 1500));
    if (scored % 10 === 0) console.log(`   Scored ${scored}/${leads.length}... (passed: ${passed}, rejected: ${rejected})`);
  }

  console.log(`✅ Scoring complete: ${scored} total | ${passed} passed | ${rejected} rejected (score < ${MIN_LEAD_SCORE})`);
  return passed; // Return only count that passed the threshold
}

module.exports = { scoreLead, scoreAllLeads };
