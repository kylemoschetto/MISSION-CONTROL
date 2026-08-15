'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { inRange } = require('./timerange');

const SUCCESS_TTL_MS = 60_000;
const ERROR_TTL_MS = 5_000; // keep transient bd failures from being reported as "zero beads" for a full minute
const cache = new Map(); // projectPath -> { at, records, ok }

function hasBeads(projectPath) {
  return fs.existsSync(path.join(projectPath, '.beads'));
}

function parseExport(stdout) {
  const records = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r._type && r._type !== 'issue') continue;
    records.push({ created_at: r.created_at || null, closed_at: r.closed_at || null, status: r.status || null });
  }
  return records;
}

function countBeads(records, range) {
  let created = 0, closed = 0;
  for (const r of records) {
    if (r.created_at && inRange(r.created_at, range)) created++;
    if (r.closed_at && inRange(r.closed_at, range)) closed++;
  }
  return { created, closed };
}

function runExport(projectPath) {
  return new Promise((resolve) => {
    execFile('bd', ['export', '-'], { cwd: projectPath, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, stdout });
    });
  });
}

// `now` and `runner` are injectable seams for tests; production callers use the defaults.
async function getBeadRecords(projectPath, { now = Date.now, runner = runExport } = {}) {
  const hit = cache.get(projectPath);
  if (hit) {
    const ttl = hit.ok ? SUCCESS_TTL_MS : ERROR_TTL_MS;
    if (now() - hit.at < ttl) return hit.records;
  }
  const { err, stdout } = await runner(projectPath);
  const ok = !err;
  if (!ok) {
    console.warn(`[beads] bd export failed for ${projectPath}: ${err.message}`);
  }
  const records = ok ? parseExport(stdout) : [];
  cache.set(projectPath, { at: now(), records, ok });
  return records;
}

module.exports = { hasBeads, parseExport, countBeads, getBeadRecords };
