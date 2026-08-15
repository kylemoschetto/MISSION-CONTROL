const fs = require('node:fs');
const readline = require('node:readline');
const cost = require('./cost');

/**
 * Pick the model with the highest total token usage.
 * Falls back to first model in the set if no token data.
 */
function pickPrimaryModel(tokensByModel, models) {
  const entries = Object.entries(tokensByModel);
  if (entries.length > 0) {
    const sorted = entries.toSorted((a, b) => {
      const totalA = a[1].input + a[1].output + a[1].cacheRead + a[1].cacheWrite;
      const totalB = b[1].input + b[1].output + b[1].cacheRead + b[1].cacheWrite;
      return totalB - totalA;
    });
    return sorted[0][0];
  }
  return models.size > 0 ? Array.from(models)[0] : 'unknown';
}

/**
 * Track earliest/latest entry timestamps on the session state
 */
function updateTimestamps(entry, session) {
  if (!entry.timestamp) return;
  const ts = new Date(entry.timestamp).getTime();
  if (!session.firstTimestamp || ts < session.firstTimestamp) session.firstTimestamp = ts;
  if (!session.lastTimestamp || ts > session.lastTimestamp) session.lastTimestamp = ts;
}

/**
 * Extract session name (last one wins — renamed sessions have multiple)
 */
function extractSessionName(entry, current) {
  const raw = (entry.type === 'custom-title' && entry.customTitle)
    || (entry.type === 'agent-name' && entry.agentName);
  if (!raw) return current;
  // A name made only of styling codes leaves nothing to display — keep the previous one
  return stripAnsi(raw).trim() || current;
}

/**
 * Pull display text out of a user message's content (string or block array)
 */
function extractUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find(c => c.type === 'text');
    if (textPart) return textPart.text;
  }
  return '';
}

/**
 * Remove ANSI SGR/CSI escape sequences left behind by terminal styling
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * True if text looks like a tool ID, UUID, file path, or other noise
 */
function isNoiseText(text) {
  return /^(toolu_|[a-f0-9]{8,}$|\/private\/tmp|\/var\/|msg_)/.test(text)
    || /^[a-z0-9]{6,12}$/i.test(text)
    || /toolu_\w{10,}/.test(text)
    || /\/private\/tmp\//.test(text)
    || text.startsWith('[Request interrupted');
}

/**
 * Capture first few user messages for richer summary,
 * skipping meta/system messages, tool results, and IDs/noise
 */
function collectUserMessage(entry, userMessages) {
  if (userMessages.length >= 5 || !entry.message) return;
  let text = extractUserText(entry.message.content);
  if (!text || entry.isMeta || text.length <= 5) return;
  // Strip ANSI escape sequences — terminal styling captured from pasted output
  text = stripAnsi(text);
  // Strip XML/HTML tags. (?=([^>]+))\1 emulates an atomic group so the
  // engine never re-tries shorter matches (avoids super-linear backtracking).
  text = text.replace(/<(?=([^>]+))\1>/g, '').trim();
  if (text.length > 5 && !isNoiseText(text)) userMessages.push(text);
}

/**
 * Accumulate token usage and cost into totals and per-model breakdown
 */
function accumulateUsage(u, model, timestamp, metrics) {
  const inputTk = u.input_tokens || 0;
  const outputTk = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;

  metrics.totalInputTokens += inputTk;
  metrics.totalOutputTokens += outputTk;
  metrics.totalCacheReadTokens += cacheRead;
  metrics.totalCacheWriteTokens += cacheWrite;

  if (!metrics.tokensByModel[model]) {
    metrics.tokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }
  const byModel = metrics.tokensByModel[model];
  byModel.input += inputTk;
  byModel.output += outputTk;
  byModel.cacheRead += cacheRead;
  byModel.cacheWrite += cacheWrite;

  const msgCost = cost.calculateMessageCost(u, model, timestamp ? Date.parse(timestamp) : null);
  metrics.totalCost += msgCost;
  byModel.cost += msgCost;
}

/**
 * Track one tool_use block — name, modified files, bash commands
 */
function trackToolCall(block, metrics, session) {
  metrics.toolCallCount++;
  session.toolsUsed.add(block.name);
  // Track files modified
  if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') && block.input) {
    const fp = block.input.file_path || block.input.filePath;
    if (fp) session.filesModified.add(fp.split('/').pop());
  }
  // Track bash commands (first 60 chars)
  if (block.name === 'Bash' && block.input?.command) {
    const cmd = block.input.command.substring(0, 60);
    if (session.commandsRun.length < 10) session.commandsRun.push(cmd);
  }
}

/**
 * Process an assistant entry: turn count, model, usage, tool calls
 */
function processAssistantEntry(entry, metrics, session) {
  metrics.messageCount++;
  const msg = entry.message;
  const model = msg.model || 'unknown';
  if (model === '<synthetic>') return;
  metrics.turnCount++;
  session.models.add(model);

  if (msg.usage) {
    accumulateUsage(msg.usage, model, entry.timestamp, metrics);
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') trackToolCall(block, metrics, session);
    }
  }
}

/**
 * Route one parsed JSONL entry into metrics and session state
 */
function processEntry(entry, metrics, session) {
  if (!session.sessionId && entry.sessionId) {
    session.sessionId = entry.sessionId;
  }

  updateTimestamps(entry, session);
  session.sessionName = extractSessionName(entry, session.sessionName);

  if (entry.type === 'user') {
    metrics.messageCount++;
    collectUserMessage(entry, session.userMessages);
  }

  if (entry.type === 'assistant' && entry.message) {
    processAssistantEntry(entry, metrics, session);
  }

  // Track turn durations from system messages
  if (entry.type === 'system' && entry.subtype === 'turn_duration' && entry.durationMs) {
    metrics.totalDurationMs += entry.durationMs;
  }
}

/**
 * Parse a session JSONL file and extract metrics
 * Returns: { sessionId, metrics, summary, timestamps, models }
 */
async function parseSessionFile(filePath) {
  const metrics = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: 0,
    totalDurationMs: 0,
    turnCount: 0,
    toolCallCount: 0,
    messageCount: 0,
    tokensByModel: {}
  };

  const session = {
    sessionId: null,
    sessionName: null,          // From custom-title or agent-name entries
    firstTimestamp: null,
    lastTimestamp: null,
    userMessages: [],           // Collect first few user messages for summary
    toolsUsed: new Set(),       // Track tool names
    filesModified: new Set(),   // Track files edited/written
    commandsRun: [],            // Track bash commands
    models: new Set()
  };

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    processEntry(entry, metrics, session);
  }

  // If no turn_duration events, estimate from timestamps
  if (metrics.totalDurationMs === 0 && session.firstTimestamp && session.lastTimestamp) {
    metrics.totalDurationMs = session.lastTimestamp - session.firstTimestamp;
  }

  // Build rich summary
  const summary = buildSummary(session.userMessages, session.toolsUsed, session.filesModified, session.commandsRun);

  return {
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    filePath,
    summary,
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    models: Array.from(session.models),
    primaryModel: pickPrimaryModel(metrics.tokensByModel, session.models),
    metrics,
    timeSaved: cost.calculateTimeSaved(metrics.totalDurationMs)
  };
}

/**
 * Build the "goal" line from the user's first messages
 */
function buildGoal(userMessages) {
  let goal = '';
  if (userMessages.length > 0) {
    goal = userMessages[0];
    // Clean up common prefixes from slash commands
    goal = goal.replace(/^\/\w+\s*/, '').trim();
    // If first message is too short, combine with second
    if (goal.length < 20 && userMessages.length > 1) {
      goal = goal + ' — ' + userMessages[1];
    }
  }

  // Truncate goal
  if (goal.length > 120) goal = goal.substring(0, 117) + '...';
  return goal;
}

/**
 * Build action phrases from tool data (files edited, commits made)
 */
function buildActions(toolsUsed, filesModified, commandsRun) {
  const actions = [];
  if (filesModified.size > 0) {
    const fileList = Array.from(filesModified).slice(0, 3).join(', ');
    const extra = filesModified.size > 3 ? ` +${filesModified.size - 3} more` : '';
    actions.push(`edited ${fileList}${extra}`);
  }
  if (toolsUsed.has('Bash') && commandsRun.length > 0) {
    // Look for git commits in commands
    if (commandsRun.some(c => c.includes('git commit'))) actions.push('committed changes');
  }
  return actions;
}

/**
 * Build a rich summary from session data
 * Priority: user's stated goal + key actions taken
 */
function buildSummary(userMessages, toolsUsed, filesModified, commandsRun) {
  const goal = buildGoal(userMessages);
  const actions = buildActions(toolsUsed, filesModified, commandsRun);

  // Combine goal + actions
  if (!goal && actions.length > 0) {
    return actions.join('; ');
  }
  if (goal && actions.length > 0) {
    const actionStr = actions.join('; ');
    // Only append if it fits
    if (goal.length + actionStr.length < 180) {
      return `${goal} [${actionStr}]`;
    }
  }

  return goal || '(no summary available)';
}

/**
 * Parse history.jsonl and build sessionId -> first display text index
 */
async function buildHistoryIndex(historyPath) {
  const index = {}; // sessionId -> { display, timestamp, project }

  if (!fs.existsSync(historyPath)) return index;

  const fileStream = fs.createReadStream(historyPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.sessionId && !index[entry.sessionId]) {
        index[entry.sessionId] = {
          display: entry.display || '',
          timestamp: entry.timestamp,
          project: entry.project || ''
        };
      }
    } catch {
      continue;
    }
  }

  return index;
}

module.exports = { parseSessionFile, buildHistoryIndex };
