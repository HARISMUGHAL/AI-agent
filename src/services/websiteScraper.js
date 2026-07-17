const cheerio = require('cheerio');

const DEFAULT_CONCURRENCY = parseInt(process.env.MAX_WEBSITE_AUDIT_CONCURRENCY || '5', 10);
let activeAudits = 0;
const auditQueue = [];

function runWithConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeAudits++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        activeAudits--;
        if (auditQueue.length > 0) {
          const next = auditQueue.shift();
          next();
        }
      }
    };
    if (activeAudits < DEFAULT_CONCURRENCY) run();
    else auditQueue.push(run);
  });
}

async function fetchPage(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ZynqoraEdgeBot/1.0 (+https://zynqora.com)' },
      redirect: 'follow'
    });
    clearTimeout(timeout);
    const html = response.ok ? await response.text() : '';
    return { response, html, finalUrl: response.url || url, responseTimeMs: Date.now() - startedAt };
  } catch (error) {
    clearTimeout(timeout);
    return { response: null, html: '', finalUrl: url, error, responseTimeMs: Date.now() - startedAt };
  }
}

function extractEmailsFromHtml(html) {
  const $ = cheerio.load(html);
  let email = null;
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const extracted = href.replace('mailto:', '').split('?')[0].trim();
      if (extracted && extracted.includes('@')) {
        email = extracted;
        return false;
      }
    }
  });
  if (email) return email;

  const text = $('body').text();
  const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
  const matches = text.match(emailRegex);
  if (matches) {
    const filtered = matches.filter(e => {
      const lower = e.toLowerCase();
      return !lower.includes('sentry') && !lower.includes('.png') && !lower.includes('example.com');
    });
    if (filtered.length > 0) return filtered[0];
  }
  return null;
}

async function scrapeEmailFromWebsite(url) {
  if (!url || !url.startsWith('http')) return null;
  const { html } = await fetchPage(url, 8000);
  if (!html) return null;
  return extractEmailsFromHtml(html);
}

async function scrapeContactPages(baseUrl) {
  const paths = ['/contact', '/contact-us', '/about', '/about-us'];
  let email = null;
  let contactPageUrl = '';
  try {
    const origin = new URL(baseUrl).origin;
    for (const path of paths) {
      const { html, finalUrl } = await fetchPage(`${origin}${path}`, 8000);
      if (!html) continue;
      const found = extractEmailsFromHtml(html);
      if (found) {
        email = found;
        contactPageUrl = finalUrl;
        break;
      }
    }
  } catch (e) { /* ignore */ }
  return { email, contactPageUrl };
}

function detectWebsiteSignals($, html, httpStatus) {
  const bodyText = $('body').text().toLowerCase();
  const htmlLower = html.toLowerCase();
  const issues = [];
  const evidence = [];

  const hasMobileViewport = $('meta[name="viewport"]').length > 0;
  if (!hasMobileViewport) {
    issues.push('missing_mobile_viewport');
    evidence.push('No viewport meta tag found');
  }

  const hasContactForm = $('form').length > 0 && (
    bodyText.includes('contact') || $('input[type="email"]').length > 0
  );
  const hasCta = $('button, .btn, a.cta, [class*="book"], [class*="schedule"]').length > 0;
  const hasBooking = bodyText.includes('book') || bodyText.includes('appointment') || htmlLower.includes('calendly') || htmlLower.includes('acuity');
  const hasOrdering = bodyText.includes('order online') || htmlLower.includes('toasttab') || htmlLower.includes('opentable');
  const hasChatbot = htmlLower.includes('intercom') || htmlLower.includes('drift') || htmlLower.includes('tidio') || htmlLower.includes('chatbot');
  const hasSocial = $('a[href*="facebook"], a[href*="instagram"], a[href*="linkedin"], a[href*="twitter"], a[href*="x.com"]').length > 0;
  const hasVisiblePhone = /(\+?\d[\d\s().-]{8,}\d)/.test(bodyText);
  const hasVisibleEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(bodyText);
  const placeholderContent = /\b(coming soon|under construction|website suspended|domain (is )?for sale|default web site page|lorem ipsum)\b/i.test(bodyText);

  if (!$('title').text().trim()) { issues.push('missing_page_title'); evidence.push('No HTML title element text found'); }
  if (!$('meta[name="description"]').attr('content')) { issues.push('missing_meta_description'); evidence.push('No meta description content found'); }
  if (placeholderContent) {
    issues.push('placeholder_content');
    evidence.push('Common placeholder or suspended-site text detected');
  }

  const copyrightMatch = html.match(/©\s*(20\d{2})|copyright\s*(20\d{2})/i);
  const copyrightYear = copyrightMatch ? parseInt(copyrightMatch[1] || copyrightMatch[2], 10) : null;
  if (copyrightYear && copyrightYear < new Date().getFullYear() - 3) {
    issues.push('outdated_copyright');
    evidence.push(`Copyright year ${copyrightYear}`);
  }

  if (httpStatus >= 400) {
    issues.push('http_error');
    evidence.push(`HTTP status ${httpStatus}`);
  }

  let websiteStatus = 'modern';
  if (httpStatus === 0 || !html) websiteStatus = 'unreachable';
  else if (httpStatus >= 400) websiteStatus = 'broken';
  else if (issues.includes('outdated_copyright') || (!hasMobileViewport && !hasContactForm)) websiteStatus = 'outdated';

  let websiteOpportunityScore = 0;
  if (!hasMobileViewport) websiteOpportunityScore += 20;
  if (!hasContactForm) websiteOpportunityScore += 15;
  if (!hasCta) websiteOpportunityScore += 10;
  if (!hasBooking) websiteOpportunityScore += 15;
  if (!hasChatbot) websiteOpportunityScore += 15;
  if (websiteStatus === 'outdated') websiteOpportunityScore += 15;
  if (websiteStatus === 'broken' || websiteStatus === 'unreachable') websiteOpportunityScore += 30;

  return {
    has_mobile_viewport: hasMobileViewport,
    page_title: $('title').text().trim() || '',
    meta_description: $('meta[name="description"]').attr('content') || '',
    has_contact_form: hasContactForm,
    has_cta: hasCta,
    has_booking_system: hasBooking,
    has_ordering_system: hasOrdering,
    has_chatbot: hasChatbot,
    copyright_year: copyrightYear,
    has_social_links: hasSocial,
    has_visible_phone: hasVisiblePhone,
    has_visible_email: hasVisibleEmail,
    placeholder_content: placeholderContent,
    website_status: websiteStatus,
    website_issues: issues,
    website_evidence: evidence,
    website_opportunity_score: Math.min(100, websiteOpportunityScore)
  };
}

async function auditWebsite(url) {
  return runWithConcurrencyLimit(async () => {
    if (!url || !url.startsWith('http')) {
      const auditTimestamp = new Date().toISOString();
      return {
        has_website: false,
        http_status: 0,
        final_url: '',
        has_https: false,
        timed_out: false,
        website_status: 'unreachable',
        website_issues: ['no_website'],
        website_evidence: ['Business has no website URL'],
        audit_timestamp: auditTimestamp,
        audit_findings: [{ issue_name: 'no_website', evidence: 'Business has no website URL', source_url: '', audit_timestamp: auditTimestamp }],
        needs_website: true,
        needs_website_redesign: false,
        website_opportunity_score: 100,
        email: null,
        contact_page_url: ''
      };
    }

    const { response, html, finalUrl, error, responseTimeMs } = await fetchPage(url, Number(process.env.REQUEST_TIMEOUT_MS || 10000));
    const timedOut = error?.name === 'AbortError';
    const httpStatus = response?.status || 0;
    const hasHttps = finalUrl.startsWith('https://');

    let email = null;
    let contactPageUrl = '';
    if (html) {
      email = extractEmailsFromHtml(html);
      if (!email) {
        const contact = await scrapeContactPages(url);
        email = contact.email;
        contactPageUrl = contact.contactPageUrl;
      }
    }

    const signals = html
      ? detectWebsiteSignals(cheerio.load(html), html, httpStatus)
      : {
          has_mobile_viewport: false, page_title: '', meta_description: '',
          has_contact_form: false, has_cta: false, has_booking_system: false,
          has_ordering_system: false, has_chatbot: false, copyright_year: null,
          has_social_links: false, has_visible_phone: false, has_visible_email: false,
          website_status: timedOut ? 'unreachable' : 'broken',
          website_issues: [timedOut ? 'timeout' : 'fetch_failed'],
          website_evidence: [timedOut ? 'Request timed out' : 'Could not fetch homepage'],
          website_opportunity_score: 80
        };

    const needsWebsite = false;
    const needsRedesign = signals.website_status === 'outdated' || signals.website_status === 'broken';
    const auditTimestamp = new Date().toISOString();
    const issueEvidence = new Map(signals.website_issues.map((issue, index) => [issue, signals.website_evidence[index] || issue.replace(/_/g, ' ')]));
    if (!hasHttps) issueEvidence.set('missing_https', 'Final website URL does not use HTTPS');
    if (responseTimeMs >= 4000) issueEvidence.set('slow_response', `Homepage response took ${responseTimeMs}ms`);
    if (timedOut) issueEvidence.set('timeout', 'Homepage request exceeded the configured timeout');
    signals.website_issues = [...issueEvidence.keys()];
    signals.website_evidence = [...issueEvidence.values()];

    return {
      has_website: true,
      http_status: httpStatus,
      final_url: finalUrl,
      has_https: hasHttps,
      timed_out: timedOut,
      response_time_ms: responseTimeMs,
      slow_response: responseTimeMs >= 4000,
      audit_timestamp: auditTimestamp,
      audit_findings: [...issueEvidence].map(([issue_name, evidence]) => ({ issue_name, evidence, source_url: finalUrl || url, audit_timestamp: auditTimestamp })),
      email,
      contact_page_url: contactPageUrl,
      needs_website: needsWebsite,
      needs_website_redesign: needsRedesign,
      ...signals
    };
  });
}

module.exports = { scrapeEmailFromWebsite, auditWebsite, extractEmailsFromHtml, fetchPage };
