'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.resolve(process.env.HTTP_CACHE_DIRECTORY || 'data/cache');

function cachePath(key) {
  const hash = crypto.createHash('sha256').update(String(key)).digest('hex');
  return path.join(CACHE_DIR, `${hash}.json`);
}

function getCached(key, ttlHours = Number(process.env.HTTP_CACHE_TTL_HOURS || 24)) {
  const file = cachePath(key);
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - entry.stored_at > ttlHours * 3600000) return null;
    return entry.value;
  } catch { return null; }
}

function setCached(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(key);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ stored_at: Date.now(), value }), 'utf8');
  fs.renameSync(temp, file);
  return value;
}

module.exports = { getCached, setCached, cachePath };
