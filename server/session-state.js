const fs = require('node:fs');
const path = require('node:path');

const STATE_PATH = path.join(__dirname, '..', 'session-state.json');

let state = null;

function load() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    state = { sessions: {} };
  }
  return state;
}

function get() {
  if (!state) load();
  return state;
}

function save() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(get(), null, 2));
  return state;
}

function setStatus(sessionId, status, note) {
  const s = get();
  if (!status) {
    delete s.sessions[sessionId];
  } else {
    s.sessions[sessionId] = {
      status,
      note: note || '',
      updatedAt: new Date().toISOString()
    };
  }
  save();
  return s.sessions[sessionId] || null;
}

function getStatus(sessionId) {
  return get().sessions[sessionId] || null;
}

function getWipSessions() {
  const s = get();
  const result = {};
  for (const [id, entry] of Object.entries(s.sessions)) {
    if (entry.status === 'wip') {
      result[id] = entry;
    }
  }
  return result;
}

function setSummary(sessionId, summary) {
  const s = get();
  if (!s.sessions[sessionId]) {
    s.sessions[sessionId] = {};
  }
  s.sessions[sessionId].summary = summary;
  s.sessions[sessionId].updatedAt = new Date().toISOString();
  save();
  return s.sessions[sessionId];
}

function getSummary(sessionId) {
  const entry = get().sessions[sessionId];
  return entry?.summary != null ? entry.summary : null;
}

module.exports = { load, get, save, setStatus, getStatus, getWipSessions, setSummary, getSummary };
