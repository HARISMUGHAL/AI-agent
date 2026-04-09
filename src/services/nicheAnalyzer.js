const { GoogleGenerativeAI } = require('@google/generative-ai');
const { upsertNiche, getAllNiches, getNicheData } = require('../database/db');

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
 * Analyze all niches and decide which services fit best
 */
async function analyzeNiches() {
  const model = getModel();
  const nicheData = getNicheData();

  if (nicheData.length === 0) {
    console.log('⚠️  No niche data to analyze yet.');
    return [];
  }

  console.log(`\n🧠 Analyzing ${nicheData.length} niches...`);

  for (const niche of nicheData) {
    let bestService = 'Both';
    let reasoning = '';

    if (model) {
      try {
        const prompt = `You are a digital marketing strategist. Analyze this business niche:

Niche: ${niche.niche}
Total Leads: ${niche.total}
Avg Score: ${Math.round(niche.avg_score || 0)}/100
Contacted: ${niche.contacted}
Responses: ${niche.responses}

Decide best service: "AI Agent", "WhatsApp Automation", or "Both"

Respond ONLY in JSON (no markdown):
{"best_service": "AI Agent", "reasoning": "One sentence why."}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const analysis = JSON.parse(jsonStr);
        bestService = analysis.best_service;
        reasoning = analysis.reasoning;
      } catch (e) {
        bestService = inferService(niche.niche);
        reasoning = 'Auto-classified based on niche characteristics.';
      }
    } else {
      bestService = inferService(niche.niche);
      reasoning = 'Auto-classified based on niche characteristics.';
    }

    upsertNiche(niche.niche, niche.total, bestService, reasoning);
  }

  console.log(`✅ Niche analysis complete.`);
  return getAllNiches();
}

function inferService(niche) {
  const n = (niche || '').toLowerCase();
  const whatsapp = ['restaurants', 'food', 'cafe', 'bakery', 'salon', 'spa', 'barbershop', 'pet', 'retail', 'clothing', 'florist'];
  const ai = ['real estate', 'law', 'legal', 'dental', 'clinic', 'doctor', 'insurance', 'financial', 'consulting', 'tutoring'];
  if (whatsapp.some(w => n.includes(w))) return 'WhatsApp Automation';
  if (ai.some(a => n.includes(a))) return 'AI Agent';
  return 'Both';
}

module.exports = { analyzeNiches };
