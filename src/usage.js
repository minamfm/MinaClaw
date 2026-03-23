'use strict';

const fs   = require('fs');
const path = require('path');

const USAGE_PATH = process.env.NODE_ENV === 'production'
  ? '/app/config/usage-log.json'
  : path.join(__dirname, '..', 'config', 'usage-log.json');

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function load() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function save(entries) {
  try {
    fs.writeFileSync(USAGE_PATH, JSON.stringify(entries));
  } catch (e) {
    console.error('Usage log save failed:', e.message);
  }
}

// Record a usage event. Prunes entries older than 24h on every write.
function record(provider, model, input = 0, output = 0) {
  if (!input && !output) return;
  const entries = load();
  entries.push({ ts: Date.now(), provider, model, input, output });
  const cutoff = Date.now() - WINDOW_MS;
  save(entries.filter(e => e.ts >= cutoff));
}

// Return aggregated usage per provider+model for the last 24 hours.
function getLast24h() {
  const cutoff = Date.now() - WINDOW_MS;
  const entries = load().filter(e => e.ts >= cutoff);

  const agg = {};
  for (const e of entries) {
    const key = `${e.provider}|${e.model}`;
    if (!agg[key]) agg[key] = { provider: e.provider, model: e.model, input: 0, output: 0, requests: 0 };
    agg[key].input    += e.input;
    agg[key].output   += e.output;
    agg[key].requests += 1;
  }

  return Object.values(agg).sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

module.exports = { record, getLast24h };
