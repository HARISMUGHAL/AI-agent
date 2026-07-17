/**
 * replyHandler.js — AI-Powered Reply Detection and Closing System
 * Zynqora Edge Autonomous Agent
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  fetchUnreadReplies,
  markMessageAsRead,
  sendEmailViaAccount
} = require('./gmailService');
const {
  getLeadByEmail,
  isMessageProcessed,
  markMessageProcessed,
  updateOutreachResponseStatus,
  updateLeadStatus
} = require('../database/db');

let _geminiInstance = null;
function getAIModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;

  if (!_geminiInstance) {
    _geminiInstance = new GoogleGenerativeAI(apiKey);
  }
  return _geminiInstance.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

function getSenderContext() {
  return {
    name:    process.env.YOUR_NAME    || 'Alex',
    company: process.env.YOUR_COMPANY || 'Your Company',
    phone:   process.env.YOUR_PHONE   || ''
  };
}

function safeParseJSON(raw) {
  try {
    const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

/**
 * Feeds the incoming reply to AI to determine the classification + auto-response.
 */
async function classifyAndGenerateReply(lead, incomingMessageText, sender) {
  const ai = getAIModel();
  if (!ai) return null; // Gracefully fail if API key is missing

  const prompt = `You are a senior sales closer for ${sender.company}.
You are handling a reply from a cold outreach email sent to ${lead.business_name} (${lead.niche}).

We offer ${lead.service_type || 'AI Automation and Digital Workflows'}.

INCOMING MESSAGE FROM ${lead.business_name}:
"${incomingMessageText}"

YOUR TASK:
1. Classify the intent of their reply as EXACTLY ONE of: "interested", "maybe", or "not_interested".
2. Write a SHORT, human-like response (max 70 words) directly replying to them. 
   - No robotic language. No jargon.
   - If "interested": be confident, suggest a quick 10-minute demo call, and push for a time.
   - If "maybe": answer their hesitation briefly and ask a low-friction question.
   - If "not_interested": be extremely polite, thank them for their time, and graciously exit. DO NOT PUSH.

OUTPUT FORMAT (Respond ONLY in JSON, no markdown):
{
  "classification": "interested", 
  "reply_body": "Hi there! Glad it caught your eye. Are you free for a quick 10-minute chat this Thursday to see how it works?"
}`;

  try {
    const result = await ai.generateContent(prompt);
    const parsed = safeParseJSON(result.response.text());
    
    // Ensure fallback formats if AI hallucinates fields
    if (parsed && parsed.classification && parsed.reply_body) {
      if (!['interested', 'maybe', 'not_interested'].includes(parsed.classification)) {
         parsed.classification = 'maybe'; 
      }
      return parsed;
    }
  } catch (error) {
    console.error(`❌ Reply generation error for ${lead.business_name}:`, error.message);
  }

  // Fallback if AI fails completely
  return {
    classification: 'maybe',
    reply_body: `Thanks for getting back to me! I'd love to share a bit more about how we help businesses like ${lead.business_name}. Do you have 5 minutes later this week?`
  };
}

/**
 * Main orchestration function for reading replies and dispatching auto-responses.
 * Integrated into the scheduler.
 */
async function processInbox() {
  assertOutreachDisabled('Inbox reading and reply classification');
  console.log('\n📩 Checking active accounts for unread replies...');
  
  let unreadMessages = [];
  try {
    unreadMessages = await fetchUnreadReplies();
  } catch (e) {
    console.log('⚠️  Could not fetch replies (OAuth scope may be missing). Skipping.');
    return;
  }

  if (unreadMessages.length === 0) {
    console.log('✅ No new replies detected.');
    return;
  }

  let processedCount = 0;

  for (const msg of unreadMessages) {
    // 1. Safety check
    if (isMessageProcessed(msg.messageId)) {
      await markMessageAsRead(msg.account, msg.id); // clean up label
      continue;
    }

    // 2. Identify the lead
    const lead = getLeadByEmail(msg.from);
    if (!lead) {
      // Message is not an outreach reply. Ignore it, but mark processed to save DB scans
      markMessageProcessed(msg.messageId); 
      continue;
    }

    console.log(`\n💬 Received reply from: ${lead.business_name} (${msg.from})`);

    // 3. Classify and Generate Response
    const sender = getSenderContext();
    const result = await classifyAndGenerateReply(lead, msg.body, sender);

    if (!result) {
      // AI missing, don't crash, just skip and leave unread so we can try again
      console.log('⚠️  AI unavailable to process reply. Leaving message unread.');
      continue;
    }

    const { classification, reply_body } = result;
    console.log(`   🏷️  Classification: [${classification.toUpperCase()}]`);

    // 4. Update Database + Apply Closing Business Rules
    updateOutreachResponseStatus(lead.id, classification);

    let finalReply = reply_body + `\n\nBest regards,\n${sender.name}\n${sender.company}`;

    if (classification === 'interested') {
      console.log(`   🔥 HIGH PRIORITY LEAD: ${lead.business_name} is interested! Stopping automated follow-ups.`);
      updateLeadStatus(lead.id, 'closing_stage');
      // Lead moves out of standard rotation (getLeadsNeedingFollowUp won't fetch 'closing_stage')
    } else if (classification === 'not_interested') {
      console.log(`   🛑 STOPPING OUTREACH: ${lead.business_name} declined.`);
      updateLeadStatus(lead.id, 'rejected'); // Stop future sends
    } else {
      console.log(`   ⏳ CONTINUING OUTREACH: ${lead.business_name} is a maybe. automation will continue.`);
      // Status remains 'contacted' -> eligible for follow_ups later
    }

    // 5. Send Email via Gmail API (In-Thread)
    try {
      await sendEmailViaAccount(msg.account, msg.from, msg.subject, finalReply, {
        threadId: msg.threadId,
        messageId: msg.messageId
      });
      console.log(`   ✅ Sent auto-reply: "${finalReply.substring(0, 40)}..."`);
    } catch (e) {
      console.error(`   ❌ Failed to send reply to ${msg.from}:`, e.message);
      // Skip marking as read so we can retry on next loop
      continue; 
    }

    // 6. Finalize
    markMessageProcessed(msg.messageId);
    await markMessageAsRead(msg.account, msg.id);
    processedCount++;
  }

  console.log(`✅ Inbox processing complete: handled ${processedCount} replies.`);
}

module.exports = {
  processInbox
};
const { assertOutreachDisabled } = require('../security/dataOnlyGuard');
