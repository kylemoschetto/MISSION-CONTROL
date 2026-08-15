const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pricing = require('./pricing');
const { calculateMessageCost } = require('./cost');

describe('date-aware message cost', () => {
  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
    const seedPath = path.join(dir, 'seed.json');
    fs.writeFileSync(seedPath, JSON.stringify({ entries: [
      { effectiveFrom: '2025-01-01', prices: { 'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } },
      { effectiveFrom: '2026-09-01', prices: { 'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } },
    ]}));
    pricing.init({ historyPath: path.join(dir, 'history.json'), seedPath });
    pricing._setConfigForTest({});
  });
  it('prices a message at the rate in force on its date', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    assert.equal(calculateMessageCost(usage, 'claude-sonnet-5', Date.parse('2026-08-01')), 2);
    assert.equal(calculateMessageCost(usage, 'claude-sonnet-5', Date.parse('2026-10-01')), 3);
  });
  it('omitted timestamp uses latest prices', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    assert.equal(calculateMessageCost(usage, 'claude-sonnet-5'), 3);
  });
});
