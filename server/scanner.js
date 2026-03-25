const fs = require('fs');
const path = require('path');
const config = require('./config');
const parser = require('./parser');

/**
 * Encode a project path to match Claude Code's directory naming
 * /home/user/projects/MyApp -> -home-user-projects-MyApp
 */
function encodeProjectPath(projectPath) {
  return projectPath.replace(/\//g, '-');
}

/**
 * Scan the configured root folder for Claude Code projects
 * A project is any directory that has a .claude/ subdirectory
 */
function discoverProjects() {
  const cfg = config.get();
  const scanPath = cfg.scanPath;
  const claudeDir = cfg.claudeDir;

  if (!fs.existsSync(scanPath)) return [];

  const entries = fs.readdirSync(scanPath, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden dirs, trash, etc.
    if (entry.name.startsWith('.') || entry.name.startsWith('trash')) continue;

    const projectPath = path.join(scanPath, entry.name);
    const claudeSubdir = path.join(projectPath, '.claude');

    if (fs.existsSync(claudeSubdir)) {
      const encodedPath = encodeProjectPath(projectPath);
      const sessionsDir = path.join(claudeDir, 'projects', encodedPath);

      projects.push({
        name: entry.name,
        path: projectPath,
        encodedPath,
        sessionsDir,
        hasSessionData: fs.existsSync(sessionsDir)
      });
    }
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List session JSONL files for a project.
 * Discovers both top-level session files and subagent files in
 * {uuid}/subagents/*.jsonl, linking subagents to their parent session.
 */
function listSessionFiles(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];

  const entries = fs.readdirSync(sessionsDir);
  const sessions = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(sessionsDir, entry);
    const stat = fs.statSync(filePath);
    // Skip tiny files (< 100 bytes)
    if (stat.size < 100) continue;

    const sessionId = entry.replace('.jsonl', '');
    sessions.push({
      id: sessionId,
      filePath,
      size: stat.size,
      modified: stat.mtime
    });

    // Check for subagent files in {uuid}/subagents/
    const subagentsDir = path.join(sessionsDir, sessionId, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      const subEntries = fs.readdirSync(subagentsDir);
      for (const subEntry of subEntries) {
        if (!subEntry.endsWith('.jsonl')) continue;
        const subPath = path.join(subagentsDir, subEntry);
        const subStat = fs.statSync(subPath);
        if (subStat.size < 100) continue;

        sessions.push({
          id: subEntry.replace('.jsonl', ''),
          filePath: subPath,
          size: subStat.size,
          modified: subStat.mtime,
          parentSessionId: sessionId
        });
      }
    }
  }

  // Sort newest first
  return sessions.sort((a, b) => b.modified - a.modified);
}

/**
 * Get active Claude Code sessions (currently running)
 */
function getActiveSessions() {
  const cfg = config.get();
  const sessionsDir = path.join(cfg.claudeDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const active = [];
  const entries = fs.readdirSync(sessionsDir);

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, entry), 'utf8'));
      // Check if PID is still running
      try {
        process.kill(data.pid, 0); // Signal 0 tests existence
        active.push(data);
      } catch {
        // Process not running
      }
    } catch {
      continue;
    }
  }

  return active;
}

// Cache for parsed sessions
const sessionCache = new Map();

/**
 * Merge a subagent's parsed metrics into a parent session object.
 */
function mergeSubagentMetrics(parent, subagent) {
  const pm = parent.metrics;
  const sm = subagent.metrics;

  pm.totalInputTokens += sm.totalInputTokens;
  pm.totalOutputTokens += sm.totalOutputTokens;
  pm.totalCacheReadTokens += sm.totalCacheReadTokens;
  pm.totalCacheWriteTokens += sm.totalCacheWriteTokens;
  pm.totalCost += sm.totalCost;
  pm.totalDurationMs += sm.totalDurationMs;
  pm.turnCount += sm.turnCount;
  pm.toolCallCount += sm.toolCallCount;
  pm.messageCount += sm.messageCount;

  for (const [model, tokens] of Object.entries(sm.tokensByModel)) {
    if (!pm.tokensByModel[model]) {
      pm.tokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    }
    pm.tokensByModel[model].input += tokens.input;
    pm.tokensByModel[model].output += tokens.output;
    pm.tokensByModel[model].cacheRead += tokens.cacheRead;
    pm.tokensByModel[model].cacheWrite += tokens.cacheWrite;
    pm.tokensByModel[model].cost += tokens.cost;
  }

  // Merge model list
  for (const model of subagent.models) {
    if (!parent.models.includes(model)) {
      parent.models.push(model);
    }
  }
}

/**
 * Recompute primaryModel from tokensByModel (highest total tokens wins).
 */
function computePrimaryModel(parsed) {
  const entries = Object.entries(parsed.metrics.tokensByModel);
  if (entries.length === 0) {
    parsed.primaryModel = parsed.models.length > 0 ? parsed.models[0] : 'unknown';
    return;
  }
  parsed.primaryModel = entries
    .sort((a, b) => {
      const totalA = a[1].input + a[1].output + a[1].cacheRead + a[1].cacheWrite;
      const totalB = b[1].input + b[1].output + b[1].cacheRead + b[1].cacheWrite;
      return totalB - totalA;
    })[0][0];
}

/**
 * Parse all sessions for a project (with caching).
 * Subagent files are merged into their parent session's metrics.
 */
async function getProjectSessions(project, historyIndex) {
  const files = listSessionFiles(project.sessionsDir);
  const parentFiles = files.filter(f => !f.parentSessionId);
  const subagentFiles = files.filter(f => f.parentSessionId);

  // Group subagent files by parent session ID
  const subagentsByParent = {};
  for (const sf of subagentFiles) {
    if (!subagentsByParent[sf.parentSessionId]) {
      subagentsByParent[sf.parentSessionId] = [];
    }
    subagentsByParent[sf.parentSessionId].push(sf);
  }

  const sessions = [];

  for (const file of parentFiles) {
    const subFiles = subagentsByParent[file.id] || [];
    // Cache key includes parent + all subagent mtimes for invalidation
    const subMtimes = subFiles.map(sf => sf.modified.getTime()).sort().join(',');
    const cacheKey = `${file.filePath}:${file.modified.getTime()}:${subMtimes}`;
    if (sessionCache.has(cacheKey)) {
      sessions.push(sessionCache.get(cacheKey));
      continue;
    }

    try {
      const parsed = await parser.parseSessionFile(file.filePath);

      // Parse and merge each subagent's metrics
      for (const subFile of subFiles) {
        try {
          const subParsed = await parser.parseSessionFile(subFile.filePath);
          mergeSubagentMetrics(parsed, subParsed);
        } catch (err) {
          console.error(`Error parsing subagent ${subFile.filePath}: ${err.message}`);
        }
      }

      // Recompute primaryModel after merging
      computePrimaryModel(parsed);

      // Enrich summary from history index if available
      if (parsed.sessionId && historyIndex[parsed.sessionId]) {
        const histEntry = historyIndex[parsed.sessionId];
        if (histEntry.display && (!parsed.summary || parsed.summary.length < histEntry.display.length)) {
          parsed.summary = histEntry.display;
        }
      }
      parsed.encodedPath = project.encodedPath;
      parsed.projectName = project.name;
      parsed.projectPath = project.path;
      parsed.fileSize = file.size;
      parsed.modified = file.modified;
      sessionCache.set(cacheKey, parsed);
      sessions.push(parsed);
    } catch (err) {
      console.error(`Error parsing ${file.filePath}: ${err.message}`);
    }
  }

  return sessions;
}

/**
 * Aggregate metrics across multiple sessions
 */
function aggregateSessions(sessions) {
  const agg = {
    sessionCount: sessions.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    totalToolCalls: 0,
    totalMessages: 0,
    tokensByModel: {},
    timeSavedMs: 0
  };

  for (const s of sessions) {
    const m = s.metrics;
    agg.totalInputTokens += m.totalInputTokens;
    agg.totalOutputTokens += m.totalOutputTokens;
    agg.totalCacheReadTokens += m.totalCacheReadTokens;
    agg.totalCacheWriteTokens += m.totalCacheWriteTokens;
    agg.totalCost += m.totalCost;
    agg.totalDurationMs += m.totalDurationMs;
    agg.totalTurns += m.turnCount;
    agg.totalToolCalls += m.toolCallCount;
    agg.totalMessages += m.messageCount;
    agg.timeSavedMs += (s.timeSaved ? s.timeSaved.timeSavedMs : 0);

    for (const [model, tokens] of Object.entries(m.tokensByModel)) {
      if (!agg.tokensByModel[model]) {
        agg.tokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      }
      agg.tokensByModel[model].input += tokens.input;
      agg.tokensByModel[model].output += tokens.output;
      agg.tokensByModel[model].cacheRead += tokens.cacheRead;
      agg.tokensByModel[model].cacheWrite += tokens.cacheWrite;
      agg.tokensByModel[model].cost += tokens.cost;
    }
  }

  return agg;
}

module.exports = {
  encodeProjectPath,
  discoverProjects,
  listSessionFiles,
  getActiveSessions,
  getProjectSessions,
  aggregateSessions,
  sessionCache
};
