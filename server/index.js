const express = require('express');
const path = require('node:path');
const config = require('./config');
const scanner = require('./scanner');
const parser = require('./parser');
const restore = require('./restore');
const sessionState = require('./session-state');
const timerange = require('./timerange');
const beads = require('./beads');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load config and session state on startup
config.load();
sessionState.load();

// Initialize pricing with history persistence
const pricing = require('./pricing');
pricing.init({});
pricing.refresh().then((changed) => { if (changed) console.log('pricing: history updated from LiteLLM'); });
pricing.startAutoRefresh();

// Build history index on startup (async)
let historyIndex = {};
const cfg = config.get();
parser.buildHistoryIndex(path.join(cfg.claudeDir, 'history.jsonl'))
  .then(idx => {
    historyIndex = idx;
    console.log(`History index: ${Object.keys(idx).length} sessions indexed`);
  })
  .catch(err => console.error('Failed to build history index:', err.message));

// --- API Routes ---

// List all discovered projects with aggregate stats
app.get('/api/projects', async (req, res) => {
  try {
    const projects = scanner.discoverProjects();
    const results = [];

    for (const project of projects) {
      if (!project.hasSessionData) {
        results.push({
          ...project,
          sessionCount: 0,
          aggregate: null
        });
        continue;
      }

      const sessions = await scanner.getProjectSessions(project, historyIndex);
      const aggregate = scanner.aggregateSessions(sessions);

      results.push({
        name: project.name,
        path: project.path,
        encodedPath: project.encodedPath,
        sessionCount: sessions.length,
        aggregate
      });
    }

    // Sort by session count descending
    results.sort((a, b) => b.sessionCount - a.sessionCount);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List sessions for a project
app.get('/api/projects/:encodedPath/sessions', async (req, res) => {
  try {
    const cfg = config.get();
    const sessionsDir = path.join(cfg.claudeDir, 'projects', req.params.encodedPath);

    const project = {
      sessionsDir,
      encodedPath: req.params.encodedPath
    };

    const sessions = await scanner.getProjectSessions(project, historyIndex);

    // Return lightweight session list (no full metrics detail for list view)
    const list = sessions.map(s => {
      const ss = sessionState.getStatus(s.sessionId);
      const summaryOverride = sessionState.getSummary(s.sessionId);
      return {
        sessionId: s.sessionId,
        sessionName: s.sessionName || null,
        summary: summaryOverride != null ? summaryOverride : s.summary,
        primaryModel: s.primaryModel,
        models: s.models,
        firstTimestamp: s.firstTimestamp,
        lastTimestamp: s.lastTimestamp,
        totalTokens: s.metrics.totalInputTokens + s.metrics.totalOutputTokens +
                     s.metrics.totalCacheReadTokens + s.metrics.totalCacheWriteTokens,
        totalCost: s.metrics.totalCost,
        durationMs: s.metrics.totalDurationMs,
        turnCount: s.metrics.turnCount,
        toolCallCount: s.metrics.toolCallCount,
        subagentCount: s.subagentCount,
        timeSaved: s.timeSaved,
        status: ss ? ss.status : null,
        statusNote: ss ? ss.note : null
      };
    });

    // Deduplicate by sessionId — keep the one with the latest lastTimestamp
    const seen = new Map();
    for (const s of list) {
      const existing = seen.get(s.sessionId);
      if (!existing || (s.lastTimestamp || 0) > (existing.lastTimestamp || 0)) {
        seen.set(s.sessionId, s);
      }
    }
    const filtered = timerange.filterSessions(Array.from(seen.values()), timerange.parseRange(req.query));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All sessions across all projects (lightweight list)
app.get('/api/sessions/all', async (req, res) => {
  try {
    const allSessions = Array.from(scanner.sessionCache.values());
    const dedupedSessions = scanner.dedupeBySessionId(allSessions);

    const entries = dedupedSessions.map(s => {
      const ss = sessionState.getStatus(s.sessionId);
      const summaryOverride = sessionState.getSummary(s.sessionId);
      return {
        sessionId: s.sessionId,
        sessionName: s.sessionName || null,
        summary: summaryOverride != null ? summaryOverride : s.summary,
        primaryModel: s.primaryModel,
        models: s.models,
        firstTimestamp: s.firstTimestamp,
        lastTimestamp: s.lastTimestamp,
        totalTokens: s.metrics.totalInputTokens + s.metrics.totalOutputTokens +
                     s.metrics.totalCacheReadTokens + s.metrics.totalCacheWriteTokens,
        totalCost: s.metrics.totalCost,
        durationMs: s.metrics.totalDurationMs,
        turnCount: s.metrics.turnCount,
        toolCallCount: s.metrics.toolCallCount,
        subagentCount: s.subagentCount,
        timeSaved: s.timeSaved,
        status: ss ? ss.status : null,
        statusNote: ss ? ss.note : null,
        projectName: s.projectName,
        encodedPath: s.encodedPath,
        projectPath: s.projectPath
      };
    });

    // Sort newest first
    const range = timerange.parseRange(req.query);
    const filtered = timerange.filterSessions(entries, range).sort((a, b) =>
      (b.firstTimestamp || 0) - (a.firstTimestamp || 0)
    );
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get detailed metrics for a single session
app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const cached = Array.from(scanner.sessionCache.values())
      .find(s => s.sessionId === req.params.sessionId);

    if (cached) {
      res.json(cached);
    } else {
      res.status(404).json({ error: 'Session not found in cache. Load the project first.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search session descriptions
app.get('/api/search', async (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase().trim();
    if (!query) return res.json([]);

    const results = [];
    for (const [, session] of scanner.sessionCache) {
      if (session.summary?.toLowerCase().includes(query) ||
          session.sessionId?.toLowerCase().includes(query) ||
          session.sessionName?.toLowerCase().includes(query)) {
        results.push({
          sessionId: session.sessionId,
          sessionName: session.sessionName || null,
          summary: session.summary,
          primaryModel: session.primaryModel,
          firstTimestamp: session.firstTimestamp,
          totalCost: session.metrics.totalCost,
          durationMs: session.metrics.totalDurationMs
        });
      }
    }

    // Also search history index
    for (const [sid, entry] of Object.entries(historyIndex)) {
      if (entry.display.toLowerCase().includes(query) || sid.toLowerCase().includes(query)) {
        // Avoid duplicates
        if (!results.some(r => r.sessionId === sid)) {
          results.push({
            sessionId: sid,
            summary: entry.display,
            project: entry.project,
            firstTimestamp: entry.timestamp
          });
        }
      }
    }

    const range = timerange.parseRange(req.query);
    const filtered = timerange.filterSessions(results, range);
    res.json(filtered.slice(0, 50)); // Limit results
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global aggregate stats
app.get('/api/stats', async (req, res) => {
  try {
    const allSessions = Array.from(scanner.sessionCache.values());
    const dedupedSessions = scanner.dedupeBySessionId(allSessions);
    const range = timerange.parseRange(req.query);
    const projectSessions = timerange.filterByProject(dedupedSessions, req.query.project);
    const sessions = timerange.filterSessions(projectSessions, range);
    const aggregate = scanner.aggregateSessions(sessions);
    const activeSessions = scanner.getActiveSessions();

    res.json({
      ...aggregate,
      activeSessions,
      projectCount: scanner.discoverProjects().length,
      multiplier: config.get().timeSaved.multiplier
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily stats — aggregate tokens and cost per day
app.get('/api/daily-stats', async (req, res) => {
  try {
    let allSessions = Array.from(scanner.sessionCache.values());
    if (req.query.project) {
      allSessions = allSessions.filter(s => s.encodedPath === req.query.project);
    }
    allSessions = timerange.filterSessions(allSessions, timerange.parseRange(req.query));
    const dailyMap = {}; // 'YYYY-MM-DD' -> { tokens, cost, sessions, durationMs }

    for (const s of allSessions) {
      if (!s.firstTimestamp) continue;
      const date = new Date(s.firstTimestamp).toISOString().split('T')[0];
      if (!dailyMap[date]) {
        dailyMap[date] = { date, tokens: 0, cost: 0, sessions: 0, durationMs: 0, models: {} };
      }
      dailyMap[date].tokens += s.metrics.totalInputTokens + s.metrics.totalOutputTokens +
                               s.metrics.totalCacheReadTokens + s.metrics.totalCacheWriteTokens;
      dailyMap[date].cost += s.metrics.totalCost;
      dailyMap[date].sessions++;
      dailyMap[date].durationMs += s.metrics.totalDurationMs;
      // Aggregate model token usage per day
      for (const [model, mtokens] of Object.entries(s.metrics.tokensByModel || {})) {
        if (!dailyMap[date].models[model]) {
          dailyMap[date].models[model] = 0;
        }
        dailyMap[date].models[model] += mtokens.input + mtokens.output + mtokens.cacheRead + mtokens.cacheWrite;
      }
    }

    // Sort by date
    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    res.json(daily);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monthly stats — aggregate tokens and cost per month
app.get('/api/monthly-stats', async (req, res) => {
  try {
    let allSessions = Array.from(scanner.sessionCache.values());
    if (req.query.project) {
      allSessions = allSessions.filter(s => s.encodedPath === req.query.project);
    }
    allSessions = timerange.filterSessions(allSessions, timerange.parseRange(req.query));
    const monthlyMap = {}; // 'YYYY-MM' -> { month, cost, tokens, sessions, durationMs }

    for (const s of allSessions) {
      if (!s.firstTimestamp) continue;
      const month = new Date(s.firstTimestamp).toISOString().slice(0, 7);
      if (!monthlyMap[month]) {
        monthlyMap[month] = { month, tokens: 0, cost: 0, sessions: 0, durationMs: 0 };
      }
      monthlyMap[month].tokens += s.metrics.totalInputTokens + s.metrics.totalOutputTokens +
                                   s.metrics.totalCacheReadTokens + s.metrics.totalCacheWriteTokens;
      monthlyMap[month].cost += s.metrics.totalCost;
      monthlyMap[month].sessions++;
      monthlyMap[month].durationMs += s.metrics.totalDurationMs;
    }

    const monthly = Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month));
    res.json(monthly);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active sessions
app.get('/api/active', (req, res) => {
  try {
    res.json(scanner.getActiveSessions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a session in the configured terminal
app.post('/api/restore/:sessionId', async (req, res) => {
  try {
    const { cwd } = req.body;
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const terminal = config.get().terminal || 'ghostty';
    const result = await restore.restoreSession(req.params.sessionId, cwd, terminal);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Config endpoints
app.get('/api/config', (req, res) => {
  res.json(config.get());
});

app.put('/api/config', (req, res) => {
  try {
    const updated = config.save(req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Session status (WIP tracking)
app.put('/api/sessions/:sessionId/status', (req, res) => {
  try {
    const { status, note } = req.body;
    if (status && !['wip', 'complete'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "wip", "complete", or null' });
    }
    const result = sessionState.setStatus(req.params.sessionId, status || null, note);
    res.json({ sessionId: req.params.sessionId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sessions/:sessionId/summary', (req, res) => {
  try {
    const { summary } = req.body;
    if (typeof summary !== 'string') {
      return res.status(400).json({ error: 'summary must be a string' });
    }
    const result = sessionState.setSummary(req.params.sessionId, summary);
    res.json({ sessionId: req.params.sessionId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wip', (req, res) => {
  try {
    const wip = sessionState.getWipSessions();
    res.json(wip);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/beads', async (req, res) => {
  try {
    const range = timerange.parseRange(req.query);
    const projects = scanner.discoverProjects();
    const targets = req.query.project
      ? projects.filter((p) => p.encodedPath === req.query.project)
      : projects;
    const withBeads = targets.filter((p) => beads.hasBeads(p.path));
    if (withBeads.length === 0) return res.json({ hasBeads: false, created: 0, closed: 0 });
    let created = 0, closed = 0;
    for (const p of withBeads) {
      const counts = beads.countBeads(await beads.getBeadRecords(p.path), range);
      created += counts.created; closed += counts.closed;
    }
    res.json({ hasBeads: true, created, closed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
const port = cfg.port || 9000;
app.listen(port, () => {
  console.log(`CC-Mission-Control running at http://localhost:${port}`);
  console.log(`Scanning: ${cfg.scanPath}`);
  console.log(`Claude data: ${cfg.claudeDir}`);
});
