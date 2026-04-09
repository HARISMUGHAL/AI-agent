const cheerio = require('cheerio');

/**
 * Scrapes a website URL to extract an email address.
 * Looks for mailto: links first, then matches a regex pattern in the body.
 */
async function scrapeEmailFromWebsite(url) {
  if (!url || !url.startsWith('http')) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Technique 1: Look for mailto: links directly
    let email = null;
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        let extracted = href.replace('mailto:', '').split('?')[0].trim();
        if (extracted && extracted.includes('@')) {
          email = extracted;
          return false; // Break the cheerio loop
        }
      }
    });

    if (email) return email;

    // Technique 2: Regex extraction from raw body text
    const text = $('body').text();
    // Basic email regex
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
    const matches = text.match(emailRegex);

    if (matches && matches.length > 0) {
      // Filter out obvious fake emails (sentry, support@wix, etc.)
      const filtered = matches.filter(e => {
        const lower = e.toLowerCase();
        return !lower.includes('sentry') && !lower.includes('.png') && !lower.includes('example.com');
      });

      if (filtered.length > 0) {
        return filtered[0]; // Return the first decent match
      }
    }

    return null;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`⚠️  Scrape timeout for ${url}`);
    }
    return null;
  }
}

module.exports = { scrapeEmailFromWebsite };
