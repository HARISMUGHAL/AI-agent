const { insertLead, checkDuplicate } = require('../database/db');
const { scrapeEmailFromWebsite } = require('./websiteScraper');

async function searchBusinesses(query, niche, location) {
  const leads = [];
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey || apiKey === 'your_google_maps_api_key_here') {
    console.error('❌ Google Maps API Key is missing or invalid.');
    return leads;
  }

  try {
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.rating,places.userRatingCount'
      },
      body: JSON.stringify({
        textQuery: `${query} in ${location}`,
        pageSize: 20
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error(`❌ Google Maps API error:`, err.error?.message || response.statusText);
      return leads;
    }

    const data = await response.json();
    const places = data.places || [];

    for (const place of places) {
      if (checkDuplicate(place.id)) continue;

      // Automatically attempt to scrape email from website
      let extractedEmail = '';
      if (place.websiteUri) {
        console.log(`   🌐 Scraping website for email: ${place.websiteUri}`);
        extractedEmail = await scrapeEmailFromWebsite(place.websiteUri) || '';
      }

      const lead = {
        place_id: place.id,
        business_name: place.displayName?.text || 'Unknown Business',
        niche: niche,
        location: location,
        address: place.formattedAddress || '',
        website: place.websiteUri || '',
        phone: place.nationalPhoneNumber || '',
        email: extractedEmail,
        rating: place.rating || 0,
        review_count: place.userRatingCount || 0
      };

      try {
        insertLead(lead);
        leads.push(lead);
      } catch (e) {
        // Ignore constraints
      }
    }

    console.log(`✅ Found ${leads.length} new leads for "${niche}" in ${location}`);
    return leads;

  } catch (error) {
    console.error(`❌ Error searching Google Maps:`, error.message);
    return leads;
  }
}

async function runDiscovery() {
  const niches = (process.env.TARGET_NICHES || 'restaurants').split(',').map(s => s.trim());
  const locations = (process.env.TARGET_LOCATIONS || 'New York').split(',').map(s => s.trim());
  const dailyLimit = parseInt(process.env.DAILY_LIMIT) || 50;

  let totalFound = 0;
  console.log('\n🔍 Starting lead discovery using Google Maps...');

  for (const location of locations) {
    for (const niche of niches) {
      if (totalFound >= dailyLimit) {
        console.log(`📊 Daily limit reached (${dailyLimit}). Stopping discovery.`);
        return totalFound;
      }

      const leads = await searchBusinesses(niche, niche, location);
      totalFound += leads.length;
    }
  }

  console.log(`\n📊 Discovery complete. Total new leads: ${totalFound}`);
  return totalFound;
}

module.exports = { searchBusinesses, runDiscovery };
