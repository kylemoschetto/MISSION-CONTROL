const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRange, inRange, filterSessions, filterByProject } = require('./timerange');

describe('parseRange', () => {
  it('parses from/to as UTC day bounds', () => {
    const r = parseRange({ from: '2026-04-01', to: '2026-04-30' });
    assert.equal(r.from, Date.parse('2026-04-01T00:00:00.000Z'));
    assert.equal(r.to, Date.parse('2026-04-30T23:59:59.999Z'));
  });
  it('missing or invalid params yield null bounds', () => {
    assert.deepEqual(parseRange({}), { from: null, to: null });
    assert.deepEqual(parseRange({ from: 'garbage' }), { from: null, to: null });
  });
  it('rejects day overflow dates (2026-02-30)', () => {
    assert.deepEqual(parseRange({ from: '2026-02-30' }), { from: null, to: null });
  });
  it('rejects month overflow dates (2026-13-01)', () => {
    assert.deepEqual(parseRange({ to: '2026-13-01' }), { from: null, to: null });
  });
});

describe('filterSessions', () => {
  const mk = (iso) => ({ firstTimestamp: Date.parse(iso) });
  const sessions = [mk('2026-03-15T12:00:00Z'), mk('2026-04-10T12:00:00Z'), mk('2026-05-01T12:00:00Z')];
  it('keeps only sessions inside the window', () => {
    const r = parseRange({ from: '2026-04-01', to: '2026-04-30' });
    assert.equal(filterSessions(sessions, r).length, 1);
  });
  it('open bounds pass everything and return the same array', () => {
    const r = parseRange({});
    assert.equal(filterSessions(sessions, r), sessions);
  });
  it('accepts ISO-string firstTimestamp', () => {
    const r = parseRange({ from: '2026-04-01' });
    assert.equal(filterSessions([{ firstTimestamp: '2026-04-10T00:00:00Z' }], r).length, 1);
  });
});

describe('filterByProject', () => {
  const sessions = [
    { encodedPath: '-home-a', firstTimestamp: 1 },
    { encodedPath: '-home-b', firstTimestamp: 2 },
    { encodedPath: '-home-a', firstTimestamp: 3 }
  ];
  it('keeps only sessions matching the encodedPath', () => {
    const filtered = filterByProject(sessions, '-home-a');
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((s) => s.encodedPath === '-home-a'));
  });
  it('returns the same array unchanged when encodedPath is falsy', () => {
    assert.equal(filterByProject(sessions, undefined), sessions);
    assert.equal(filterByProject(sessions, ''), sessions);
  });
  it('composes with filterSessions (project filter applied first)', () => {
    const withDates = [
      { encodedPath: '-home-a', firstTimestamp: Date.parse('2026-03-01T00:00:00Z') },
      { encodedPath: '-home-a', firstTimestamp: Date.parse('2026-08-01T00:00:00Z') },
      { encodedPath: '-home-b', firstTimestamp: Date.parse('2026-08-01T00:00:00Z') }
    ];
    const range = parseRange({ from: '2026-08-01', to: '2026-08-31' });
    const result = filterSessions(filterByProject(withDates, '-home-a'), range);
    assert.equal(result.length, 1);
    assert.equal(result[0].encodedPath, '-home-a');
  });
});
