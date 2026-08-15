const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLitellm, appendIfChanged, resolvePricing, matchConfigPricing } = require('./pricing');

describe('normalizeLitellm', () => {
  it('converts anthropic claude entries to per-MTok and drops the rest', () => {
    const out = normalizeLitellm({
      'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 },
      'gpt-x': { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
      'claude-broken': { litellm_provider: 'anthropic' },
    });
    assert.deepEqual(Object.keys(out), ['claude-opus-5']);
    assert.deepEqual(out['claude-opus-5'], { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });
});

describe('appendIfChanged', () => {
  it('appends first entry, skips identical, appends changed', () => {
    const h = { entries: [] };
    const snap = { 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
    assert.equal(appendIfChanged(h, snap, '2026-08-13'), true);
    assert.equal(appendIfChanged(h, { ...snap }, '2026-08-14'), false);
    assert.equal(appendIfChanged(h, { 'claude-opus-5': { input: 6, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }, '2026-08-15'), true);
    assert.equal(h.entries.length, 2);
  });
});

describe('resolvePricing', () => {
  const h = { entries: [
    { effectiveFrom: '2025-01-01', prices: { 'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } },
    { effectiveFrom: '2026-09-01', prices: { 'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } },
  ]};
  it('resolves by date', () => {
    assert.equal(resolvePricing(h, 'claude-sonnet-5', Date.parse('2026-08-01')).input, 2);
    assert.equal(resolvePricing(h, 'claude-sonnet-5', Date.parse('2026-10-01')).input, 3);
  });
  it('null timestamp uses latest entry', () => {
    assert.equal(resolvePricing(h, 'claude-sonnet-5', null).input, 3);
  });
  it('prefix-matches dated model ids', () => {
    assert.equal(resolvePricing(h, 'claude-sonnet-5-20260601', Date.parse('2026-10-01')).input, 3);
  });
  it('unknown model returns null', () => {
    assert.equal(resolvePricing(h, 'gpt-4', Date.parse('2026-10-01')), null);
  });
  it('NaN timestamp (unparseable date) uses latest entry, not the oldest', () => {
    assert.equal(resolvePricing(h, 'claude-sonnet-5', Date.parse('not-a-date')).input, 3);
  });
});

describe('matchConfigPricing', () => {
  const table = {
    'claude-sonnet-5': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
  };
  it('matches exact model id', () => {
    assert.equal(matchConfigPricing(table, 'claude-sonnet-5'), table['claude-sonnet-5']);
  });
  it('matches by prefix for dated model ids', () => {
    assert.equal(matchConfigPricing(table, 'claude-sonnet-5-20260601'), table['claude-sonnet-5']);
  });
  it('returns null when nothing matches', () => {
    assert.equal(matchConfigPricing(table, 'claude-opus-5'), null);
  });
});

describe('init and refresh', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { init, getHistory, refresh, _resetForTesting } = require('./pricing');

  it('initializes history from seed when missing and appends on refresh', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-'));
    const seedPath = path.join(dir, 'seed.json');
    const historyPath = path.join(dir, 'history.json');
    fs.writeFileSync(seedPath, JSON.stringify({ entries: [{ effectiveFrom: '2025-01-01', prices: { 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } }] }));
    init({ historyPath, seedPath });
    assert.equal(getHistory().entries.length, 1);
    const fakeFetch = async () => ({ ok: true, json: async () => ({ 'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 6e-6, output_cost_per_token: 2.5e-5 } }) });
    assert.equal(await refresh(fakeFetch), true);
    assert.equal(getHistory().entries.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(historyPath)).entries.length, 2);
  });
  it('refresh failure resolves false and keeps history', async () => {
    const failFetch = async () => { throw new Error('offline'); };
    assert.equal(await refresh(failFetch), false);
  });
  it('re-seeds and does not throw when the history file is corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-corrupt-'));
    const seedPath = path.join(dir, 'seed.json');
    const historyPath = path.join(dir, 'history.json');
    fs.writeFileSync(seedPath, JSON.stringify({ entries: [{ effectiveFrom: '2025-01-01', prices: { 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } }] }));
    fs.writeFileSync(historyPath, '{not valid json');
    assert.doesNotThrow(() => init({ historyPath, seedPath }));
    assert.equal(getHistory().entries.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(historyPath, 'utf-8')).entries.length, 1);
  });
  it('refresh resolves false instead of throwing when pre-init', async () => {
    _resetForTesting();
    const fakeFetch = async () => ({ ok: true, json: async () => ({ 'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 6e-6, output_cost_per_token: 2.5e-5 } }) });
    assert.equal(await refresh(fakeFetch), false);
  });
});

describe('getPricing with lazy init', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { getPricing, _resetForTesting, _setConfigForTest } = require('./pricing');

  it('returns seed pricing without explicit init when config is empty', () => {
    // Check if pricing-history.json existed before test
    const historyPath = path.join(__dirname, '..', 'pricing-history.json');
    const existedBefore = fs.existsSync(historyPath);

    try {
      _resetForTesting();
      _setConfigForTest({});
      const price = getPricing('claude-opus-5', null);
      assert.ok(price, 'getPricing should return a price object');
      assert.equal(price.input, 5, 'should use seed pricing for opus input');
      assert.equal(price.output, 25, 'should use seed pricing for opus output');
    } finally {
      // Clean up: remove pricing-history.json if test created it
      if (!existedBefore && fs.existsSync(historyPath)) {
        fs.unlinkSync(historyPath);
      }
      // Reset module state
      _resetForTesting();
    }
  });
});

describe('getPricing with config override', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { getPricing, init, _resetForTesting, _setConfigForTest } = require('./pricing');

  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-override-'));
    const seedPath = path.join(dir, 'seed.json');
    const historyPath = path.join(dir, 'history.json');
    fs.writeFileSync(seedPath, JSON.stringify({ entries: [{ effectiveFrom: '2025-01-01', prices: {
      'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    } }] }));
    _resetForTesting();
    init({ historyPath, seedPath });
  };

  it('exact match in the override table wins over history', () => {
    setup();
    _setConfigForTest({ pricing: { 'claude-opus-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
    assert.deepEqual(getPricing('claude-opus-5', null), { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    _resetForTesting();
  });

  it('prefix match in the override table wins over history', () => {
    setup();
    _setConfigForTest({ pricing: { 'claude-opus-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
    assert.deepEqual(getPricing('claude-opus-5-20260601', null), { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    _resetForTesting();
  });

  it('falls through to history when the model is not in the override table', () => {
    setup();
    _setConfigForTest({ pricing: { 'claude-sonnet-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
    assert.deepEqual(getPricing('claude-opus-5', null), { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    _resetForTesting();
  });
});
