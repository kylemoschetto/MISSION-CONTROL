'use strict';
function toMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') { const n = Date.parse(ts); return Number.isFinite(n) ? n : null; }
  return null;
}
function parseDay(s, endOfDay) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(s + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
  if (!Number.isFinite(n)) return null;
  // Validate that components round-trip (reject day/month overflow like 02-30, 13-01)
  const d = new Date(n);
  const [year, month, day] = s.split('-').map(Number);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) {
    return null;
  }
  return n;
}
function parseRange(query) {
  return { from: parseDay(query.from, false), to: parseDay(query.to, true) };
}
function inRange(ts, range) {
  const n = toMs(ts);
  if (n === null) return false;
  if (range.from !== null && n < range.from) return false;
  if (range.to !== null && n > range.to) return false;
  return true;
}
function filterSessions(sessions, range) {
  if (range.from === null && range.to === null) return sessions;
  return sessions.filter((s) => inRange(s.firstTimestamp, range));
}
function filterByProject(sessions, encodedPath) {
  if (!encodedPath) return sessions;
  return sessions.filter((s) => s.encodedPath === encodedPath);
}
module.exports = { toMs, parseRange, inRange, filterSessions, filterByProject };
