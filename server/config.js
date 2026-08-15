const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');

let config = null;

function expandHome(p) {
  if (p?.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function load() {
  const filePath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
  config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  config.scanPath = expandHome(config.scanPath);
  config.claudeDir = expandHome(config.claudeDir);
  return config;
}

function get() {
  if (!config) load();
  return config;
}

function save(updates) {
  const current = get();
  const merged = { ...current, ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  config = merged;
  return merged;
}

// Default pricing for unknown models — use Sonnet pricing as fallback
function getPricing(model) {
  const cfg = get();
  const { matchConfigPricing } = require('./pricing');
  // Try exact match first, then prefix match
  const matched = matchConfigPricing(cfg.pricing || {}, model);
  if (matched) return matched;
  // Fallback to Sonnet pricing
  return cfg.pricing?.['claude-sonnet-4-6'] || { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
}

module.exports = { load, get, save, getPricing };
