require('dotenv').config();
const { generateEmailForLead } = require('./src/services/emailGenerator');

const mockLeads = [
  {
    id: 999,
    business_name: "Premium Homes Real Estate",
    niche: "real estate",
    location: "Dubai",
    rating: 4.8,
    review_count: 156,
    service_type: "AI Inbound Agent"
  },
  {
    id: 998,
    business_name: "Elite Fitness Club",
    niche: "gyms",
    location: "London",
    rating: 4.2,
    review_count: 89,
    service_type: "WhatsApp Automation"
  },
  {
    id: 997,
    business_name: "Smile Dental Clinic",
    niche: "dental",
    location: "New York",
    rating: 3.5,
    review_count: 42,
    service_type: "AI Appointment Booker"
  }
];

async function test() {
  console.log("🚀 Testing High-Power Email Generation...");
  for (const lead of mockLeads) {
    console.log(`\n--- Testing Niche: ${lead.niche} ---`);
    const email = await generateEmailForLead(lead);
    console.log("SUBJECT:", email.subject);
    console.log("BODY:\n", email.body);
    console.log("------------------------------------------");
  }
}

test();
