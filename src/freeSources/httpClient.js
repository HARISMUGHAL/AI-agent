'use strict';

const { getCached, setCached } = require('./cache');

const hostLastRequest = new Map();
let active = 0;
const waiters = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquire() {
  const max = Math.max(1, Number(process.env.MAX_CONCURRENCY || 2));
  if (active >= max) await new Promise(resolve => waiters.push(resolve));
  active++;
}

function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

async function respectfulFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body || '';
  const cacheKey = `${method}|${url}|${body}`;
  const cached = options.cache === false ? null : getCached(cacheKey, options.cacheTtlHours);
  if (cached) return { ...cached, cache_hit: true };

  await acquire();
  try {
    const host = new URL(url).host;
    const configuredMin = Number(options.requestDelayMs || process.env.REQUEST_DELAY_MIN_MS || 1500);
    const configuredMax = Number(process.env.REQUEST_DELAY_MAX_MS || 4000);
    const minimumDelay = Math.max(0, configuredMin + Math.floor(Math.random() * Math.max(1, configuredMax - configuredMin + 1)));
    const elapsed = Date.now() - (hostLastRequest.get(host) || 0);
    if (elapsed < minimumDelay) await sleep(minimumDelay - elapsed);

    const retries = Math.max(0, Number(options.retries ?? 2));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || process.env.REQUEST_TIMEOUT_MS || 10000));
      try {
        hostLastRequest.set(host, Date.now());
        const response = await fetch(url, {
          ...options,
          headers: {
            'User-Agent': process.env.PUBLIC_SOURCE_USER_AGENT || 'ZynqoraEdgeDataResearch/1.0 (local respectful research)',
            Accept: options.accept || 'application/json,text/html;q=0.9,*/*;q=0.5',
            ...(options.headers || {})
          },
          signal: controller.signal
        });
        const text = await response.text();
        const result = { ok: response.ok, status: response.status, url: response.url || url, text, headers: Object.fromEntries(response.headers.entries()), cache_hit: false };
        if (response.ok) return options.cache === false ? result : setCached(cacheKey, result);
        if (![429, 500, 502, 503, 504].includes(response.status)) return result;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) { lastError = error; }
      finally { clearTimeout(timeout); }
      if (attempt < retries) await sleep(Math.min(15000, 1000 * (2 ** attempt)));
    }
    throw lastError || new Error('Public-source request failed');
  } finally { release(); }
}

async function fetchJson(url, options = {}) {
  const response = await respectfulFetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  try { return { data: JSON.parse(response.text), response }; }
  catch { throw new Error(`Invalid JSON from ${new URL(url).host}`); }
}

module.exports = { respectfulFetch, fetchJson, sleep };
