'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

let moduleHistory = null;
let moduleHistoryPath = null;

function normalizeLitellm(json) {
  const out = {};
  for (const [key, v] of Object.entries(json || {})) {
    if (v?.litellm_provider !== 'anthropic' || !key.startsWith('claude')) continue;
    if (typeof v.input_cost_per_token !== 'number' || typeof v.output_cost_per_token !== 'number') continue;
    out[key] = {
      input: v.input_cost_per_token * 1e6,
      output: v.output_cost_per_token * 1e6,
      cacheRead: (v.cache_read_input_token_cost || 0) * 1e6,
      cacheWrite: (v.cache_creation_input_token_cost || 0) * 1e6,
    };
  }
  return out;
}

// simpler deep-equal: stringify with sorted keys at each level
function sortedStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']';
  return '{' + Object.keys(v).sort((a, b) => a.localeCompare(b)).map((k) => JSON.stringify(k) + ':' + sortedStringify(v[k])).join(',') + '}';
}

function appendIfChanged(history, snapshot, dateStr) {
  const last = history.entries[history.entries.length - 1];
  if (last && sortedStringify(last.prices) === sortedStringify(snapshot)) return false;
  history.entries.push({ effectiveFrom: dateStr, prices: snapshot });
  return true;
}

function matchConfigPricing(table, model) {
  if (table[model]) return table[model];
  for (const key of Object.keys(table)) {
    if (model.startsWith(key.split('-').slice(0, -1).join('-'))) {
      return table[key];
    }
  }
  return null;
}

function entryEffectiveAt(entries, timestampMs) {
  if (!Number.isFinite(timestampMs)) return entries[entries.length - 1];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (Date.parse(entries[i].effectiveFrom) <= timestampMs) return entries[i];
  }
  return entries[0];
}

function longestPrefixPricing(prices, model) {
  let best = null;
  for (const key of Object.keys(prices)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? prices[best] : null;
}

function resolvePricing(history, model, timestampMs) {
  const entries = history.entries;
  if (!entries.length) return null;
  const entry = entryEffectiveAt(entries, timestampMs);
  if (entry.prices[model]) return entry.prices[model];
  return longestPrefixPricing(entry.prices, model);
}

function ensureHistory() {
  try {
    return getHistory();
  } catch {
    try {
      init({});
      return getHistory();
    } catch {
      return { entries: [] };
    }
  }
}

function writeHistoryAtomic(historyPath, history) {
  const tmpPath = `${historyPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2));
  fs.renameSync(tmpPath, historyPath);
}

function seedHistory(historyPath, seedPath) {
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  moduleHistory = seed;
  writeHistoryAtomic(historyPath, seed);
  return moduleHistory;
}

function init(opts = {}) {
  moduleHistoryPath = opts.historyPath || path.join(__dirname, '..', 'pricing-history.json');
  const seedPath = opts.seedPath || path.join(__dirname, 'pricing-seed.json');

  if (fs.existsSync(moduleHistoryPath)) {
    try {
      moduleHistory = JSON.parse(fs.readFileSync(moduleHistoryPath, 'utf-8'));
    } catch {
      console.log('pricing: history corrupt, re-seeded');
      seedHistory(moduleHistoryPath, seedPath);
    }
  } else {
    seedHistory(moduleHistoryPath, seedPath);
  }

  return moduleHistory;
}

function getHistory() {
  if (!moduleHistory) throw new Error('pricing.init() not called');
  return moduleHistory;
}

async function refresh(fetchFn = global.fetch) {
  try {
    if (!moduleHistory) throw new Error('pricing.init() not called');

    const res = await fetchFn(LITELLM_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const normalized = normalizeLitellm(json);
    const today = new Date().toISOString().slice(0, 10);
    const changed = appendIfChanged(moduleHistory, normalized, today);
    if (changed) {
      writeHistoryAtomic(moduleHistoryPath, moduleHistory);
    }
    return changed;
  } catch (err) {
    console.log(`pricing: using last known prices (${err.message})`);
    return false;
  }
}

function startAutoRefresh(intervalMs = 24 * 60 * 60 * 1000) {
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
}

function _resetForTesting() {
  moduleHistory = null;
  moduleHistoryPath = null;
  testConfig = null;
}

let testConfig = null;

function _setConfigForTest(c) {
  testConfig = c;
}

function getPricing(model, timestampMs) {
  const cfg = testConfig || require('./config').get();
  if (cfg.pricing && Object.keys(cfg.pricing).length) {
    const p = matchConfigPricing(cfg.pricing, model);
    if (p) return p;
  }
  const history = ensureHistory();
  const resolved = resolvePricing(history, model, timestampMs);
  if (resolved) return resolved;
  console.warn(`pricing: no rate for model "${model}", falling back to sonnet/$0`);
  const latest = history.entries[history.entries.length - 1];
  return latest?.prices['claude-sonnet-5'] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

module.exports = {
  LITELLM_URL,
  normalizeLitellm,
  appendIfChanged,
  matchConfigPricing,
  resolvePricing,
  getPricing,
  init,
  getHistory,
  refresh,
  startAutoRefresh,
  _resetForTesting,
  _setConfigForTest
};
