const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasBeads, parseExport, countBeads, getBeadRecords } = require('./beads');
const { parseRange } = require('./timerange');

describe('parseExport', () => {
  it('parses JSONL and keeps issue records', () => {
    const out = parseExport('{"created_at":"2026-04-02T10:00:00Z","status":"open"}\n\n{"_type":"memory","created_at":"2026-04-03T00:00:00Z"}\nnot-json\n');
    assert.equal(out.length, 1);
  });
});

describe('countBeads', () => {
  const recs = [
    { created_at: '2026-04-02T10:00:00Z', closed_at: '2026-04-20T10:00:00Z', status: 'closed' },
    { created_at: '2026-04-05T10:00:00Z', closed_at: null, status: 'open' },
    { created_at: '2026-03-01T10:00:00Z', closed_at: '2026-04-11T10:00:00Z', status: 'closed' },
    { created_at: '2026-05-02T10:00:00Z', closed_at: '2026-05-03T10:00:00Z', status: 'closed' },
  ];
  it('counts created and closed within the window independently', () => {
    const r = parseRange({ from: '2026-04-01', to: '2026-04-30' });
    assert.deepEqual(countBeads(recs, r), { created: 2, closed: 2 });
  });
  it('open range counts everything', () => {
    assert.deepEqual(countBeads(recs, parseRange({})), { created: 4, closed: 3 });
  });
  it('empty window (range matching nothing) counts zero', () => {
    const r = parseRange({ from: '2020-01-01', to: '2020-01-31' });
    assert.deepEqual(countBeads(recs, r), { created: 0, closed: 0 });
  });
});

describe('hasBeads', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('no-beads project: false when .beads does not exist', () => {
    assert.equal(hasBeads(tmpDir), false);
  });

  it('true when .beads exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.beads'));
    assert.equal(hasBeads(tmpDir), true);
  });
});

describe('getBeadRecords', () => {
  it('logs a warning and returns [] when the export fails', async () => {
    const originalWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => warnCalls.push(args.join(' '));
    try {
      const runner = async () => ({ err: new Error('boom'), stdout: '' });
      const records = await getBeadRecords('/some/project', { now: () => 1000, runner });
      assert.deepEqual(records, []);
      assert.equal(warnCalls.length, 1);
      assert.match(warnCalls[0], /\/some\/project/);
      assert.match(warnCalls[0], /boom/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('caches a failure for only the short error TTL, not the success TTL', async () => {
    let calls = 0;
    const runner = async () => { calls++; return { err: new Error('boom'), stdout: '' }; };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      let now = 0;
      const clock = () => now;

      await getBeadRecords('/err/project', { now: clock, runner });
      assert.equal(calls, 1);

      // Still within the short error TTL (5s) — should reuse the cached failure, not re-run.
      now = 4_000;
      await getBeadRecords('/err/project', { now: clock, runner });
      assert.equal(calls, 1);

      // Past the short error TTL but well within the old 60s success TTL — must retry.
      now = 6_000;
      await getBeadRecords('/err/project', { now: clock, runner });
      assert.equal(calls, 2);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('caches a success for the full success TTL', async () => {
    let calls = 0;
    const runner = async () => { calls++; return { err: null, stdout: '{"created_at":"2026-01-01T00:00:00Z"}\n' }; };
    let now = 0;
    const clock = () => now;

    const first = await getBeadRecords('/ok/project', { now: clock, runner });
    assert.equal(calls, 1);
    assert.equal(first.length, 1);

    now = 30_000; // well past the 5s error TTL, still within the 60s success TTL
    await getBeadRecords('/ok/project', { now: clock, runner });
    assert.equal(calls, 1);
  });
});
