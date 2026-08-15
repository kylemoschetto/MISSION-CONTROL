const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scanner = require('./scanner');
const config = require('./config');

// --- Test Fixtures ---

// Fixtures live under a fake Claude dir so the scanner's path containment
// (sessionsDir must stay within {claudeDir}/projects) accepts them.
const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
const fixtureRoot = path.join(fakeClaudeDir, 'projects');
fs.mkdirSync(fixtureRoot);

function loadTestConfig() {
  config.load();
  config.get().claudeDir = fakeClaudeDir;
}

function makeAssistantEntry(model, inputTokens, outputTokens, opts = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp || '2026-03-25T10:00:00Z',
    sessionId: opts.sessionId || 'test-session-1',
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: opts.cacheRead || 0,
        cache_creation_input_tokens: opts.cacheWrite || 0
      },
      content: opts.content || [{ type: 'text', text: 'Hello' }]
    }
  });
}

function makeUserEntry(text, opts = {}) {
  return JSON.stringify({
    type: 'user',
    timestamp: opts.timestamp || '2026-03-25T09:59:00Z',
    sessionId: opts.sessionId || 'test-session-1',
    message: { content: text }
  });
}

/**
 * Create a temp directory mimicking Claude Code's on-disk session layout:
 *   sessionsDir/
 *     {uuid}.jsonl                     <- parent session
 *     {uuid}/subagents/agent-xxx.jsonl <- subagent sessions
 */
function createFixture(tmpDir, { parentLines, subagents = [] }) {
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Write parent JSONL
  const parentPath = path.join(sessionsDir, `${uuid}.jsonl`);
  fs.writeFileSync(parentPath, parentLines.join('\n') + '\n');

  // Write subagent JSONLs
  if (subagents.length > 0) {
    const subagentsDir = path.join(sessionsDir, uuid, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    for (const [i, lines] of subagents.entries()) {
      const agentFile = path.join(subagentsDir, `agent-a${String(i).padStart(16, '0')}.jsonl`);
      fs.writeFileSync(agentFile, lines.join('\n') + '\n');
    }
  }

  return sessionsDir;
}

// --- Tests ---

describe('listSessionFiles', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-test-'));
    // Ensure config is loaded so parser/cost don't blow up
    loadTestConfig();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers top-level .jsonl files', () => {
    const sessionsDir = createFixture(tmpDir, {
      parentLines: [
        makeUserEntry('hello'),
        makeAssistantEntry('claude-opus-4-6', 1000, 500)
      ]
    });

    const files = scanner.listSessionFiles(sessionsDir);
    assert.ok(files.length >= 1, 'should find at least the parent session file');
    assert.ok(files[0].filePath.endsWith('.jsonl'));
  });

  it('discovers subagent .jsonl files alongside parent', () => {
    const subTmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-test-sub-'));
    const sessionsDir = createFixture(subTmpDir, {
      parentLines: [
        makeUserEntry('hello'),
        makeAssistantEntry('claude-opus-4-6', 1000, 500)
      ],
      subagents: [
        [
          makeAssistantEntry('claude-sonnet-4-6', 800, 300)
        ],
        [
          makeAssistantEntry('claude-haiku-4-5-20251001', 200, 100)
        ]
      ]
    });

    const files = scanner.listSessionFiles(sessionsDir);
    const subagentFiles = files.filter(f => f.parentSessionId);
    assert.ok(subagentFiles.length === 2, `expected 2 subagent files, got ${subagentFiles.length}`);
    // All subagent files should reference the parent session ID
    const parentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    for (const sf of subagentFiles) {
      assert.equal(sf.parentSessionId, parentId);
    }

    fs.rmSync(subTmpDir, { recursive: true, force: true });
  });
});

describe('path traversal containment', () => {
  let outsideDir;

  before(() => {
    loadTestConfig();
    // A real session file OUTSIDE the allowed base — rejection must be
    // observable, not just an empty directory.
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outside-'));
    fs.writeFileSync(
      path.join(outsideDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
      makeUserEntry('secret') + '\n' + makeAssistantEntry('claude-opus-4-6', 1000, 500) + '\n'
    );
  });

  after(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a sessionsDir that escapes the projects dir via ../ segments', () => {
    // Mimics an encodedPath like '../../tmp/mc-outside-x' joined onto the base
    const traversal = path.join(fixtureRoot, path.relative(fixtureRoot, outsideDir));
    const files = scanner.listSessionFiles(traversal);
    assert.deepEqual(files, [], 'traversal path escaping the base must yield no files');
  });

  it('rejects an absolute sessionsDir outside the projects dir', () => {
    const files = scanner.listSessionFiles(outsideDir);
    assert.deepEqual(files, [], 'absolute path outside the base must yield no files');
  });

  it('still accepts a sessionsDir inside the projects dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-contained-'));
    const sessionsDir = createFixture(tmpDir, {
      parentLines: [
        makeUserEntry('hello'),
        makeAssistantEntry('claude-opus-4-6', 1000, 500)
      ]
    });

    const files = scanner.listSessionFiles(sessionsDir);
    assert.equal(files.length, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('subagent metric merging', () => {
  let tmpDir;
  let sessionsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-test-merge-'));
    loadTestConfig();

    sessionsDir = createFixture(tmpDir, {
      parentLines: [
        makeUserEntry('build the feature', { sessionId: 'sess-merge-1' }),
        makeAssistantEntry('claude-opus-4-6', 5000, 2000, { sessionId: 'sess-merge-1' }),
        makeAssistantEntry('claude-opus-4-6', 3000, 1000, { sessionId: 'sess-merge-1' })
      ],
      subagents: [
        [
          makeAssistantEntry('claude-sonnet-4-6', 2000, 800, { sessionId: 'sess-merge-1' }),
          makeAssistantEntry('claude-sonnet-4-6', 1500, 600, { sessionId: 'sess-merge-1' })
        ],
        [
          makeAssistantEntry('claude-haiku-4-5-20251001', 500, 200, { sessionId: 'sess-merge-1' })
        ]
      ]
    });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges subagent tokensByModel into parent session', async () => {
    const project = { sessionsDir, encodedPath: 'test', name: 'test', path: tmpDir };
    // Clear cache to get fresh parse
    scanner.sessionCache.clear();
    const sessions = await scanner.getProjectSessions(project, {});

    // Should be 1 session (subagents merged in, not separate)
    assert.equal(sessions.length, 1, `expected 1 session, got ${sessions.length}`);

    const s = sessions[0];
    const byModel = s.metrics.tokensByModel;

    // Parent had opus: 5000+3000 input, 2000+1000 output
    assert.ok(byModel['claude-opus-4-6'], 'should have opus in tokensByModel');
    assert.equal(byModel['claude-opus-4-6'].input, 8000);
    assert.equal(byModel['claude-opus-4-6'].output, 3000);

    // Subagent 1 had sonnet: 2000+1500 input, 800+600 output
    assert.ok(byModel['claude-sonnet-4-6'], 'should have sonnet in tokensByModel');
    assert.equal(byModel['claude-sonnet-4-6'].input, 3500);
    assert.equal(byModel['claude-sonnet-4-6'].output, 1400);

    // Subagent 2 had haiku: 500 input, 200 output
    assert.ok(byModel['claude-haiku-4-5-20251001'], 'should have haiku in tokensByModel');
    assert.equal(byModel['claude-haiku-4-5-20251001'].input, 500);
    assert.equal(byModel['claude-haiku-4-5-20251001'].output, 200);
  });

  it('includes subagent tokens in session totals', async () => {
    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test2', name: 'test', path: tmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];

    // Total input: 8000 (opus) + 3500 (sonnet) + 500 (haiku) = 12000
    assert.equal(s.metrics.totalInputTokens, 12000);
    // Total output: 3000 (opus) + 1400 (sonnet) + 200 (haiku) = 4600
    assert.equal(s.metrics.totalOutputTokens, 4600);
  });

  it('lists all models including subagent models', async () => {
    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test3', name: 'test', path: tmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];

    assert.ok(s.models.includes('claude-opus-4-6'));
    assert.ok(s.models.includes('claude-sonnet-4-6'));
    assert.ok(s.models.includes('claude-haiku-4-5-20251001'));
  });

  it('sets subagentCount to the number of merged subagents', async () => {
    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test-subcount', name: 'test', path: tmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];

    assert.equal(s.subagentCount, 2, 'fixture has 2 subagents');
  });

  it('does not set subagentCount on sessions with no subagents', async () => {
    const noSubTmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-test-nosub-'));
    const noSubSessionsDir = createFixture(noSubTmpDir, {
      parentLines: [
        makeUserEntry('solo session', { sessionId: 'sess-nosub' }),
        makeAssistantEntry('claude-opus-4-6', 1000, 500, { sessionId: 'sess-nosub' })
      ]
    });

    scanner.sessionCache.clear();
    const project = { sessionsDir: noSubSessionsDir, encodedPath: 'test-nosub', name: 'test', path: noSubTmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];

    assert.equal(s.subagentCount, undefined, 'no subagents means subagentCount is not set');

    fs.rmSync(noSubTmpDir, { recursive: true, force: true });
  });

  it('tracks subagent count per model in subagentCountByModel', async () => {
    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test-subcountmodel', name: 'test', path: tmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];
    const counts = s.metrics.subagentCountByModel;

    // Subagent 1 used sonnet, subagent 2 used haiku
    assert.equal(counts['claude-sonnet-4-6'], 1);
    assert.equal(counts['claude-haiku-4-5-20251001'], 1);
    // Opus was parent-only
    assert.equal(counts['claude-opus-4-6'], undefined);
  });

  it('tracks subagent token contributions in subagentTokensByModel', async () => {
    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test-subtokens', name: 'test', path: tmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];
    const sub = s.metrics.subagentTokensByModel;

    // Opus was only used by the parent — should not appear in subagentTokensByModel
    assert.equal(sub['claude-opus-4-6'], undefined, 'opus is parent-only');

    // Sonnet subagent: 2000+1500 input, 800+600 output
    assert.ok(sub['claude-sonnet-4-6'], 'sonnet should be in subagentTokensByModel');
    assert.equal(sub['claude-sonnet-4-6'].input, 3500);
    assert.equal(sub['claude-sonnet-4-6'].output, 1400);

    // Haiku subagent: 500 input, 200 output
    assert.ok(sub['claude-haiku-4-5-20251001'], 'haiku should be in subagentTokensByModel');
    assert.equal(sub['claude-haiku-4-5-20251001'].input, 500);
    assert.equal(sub['claude-haiku-4-5-20251001'].output, 200);
  });
});

describe('primaryModel selection', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-test-primary-'));
    loadTestConfig();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('picks the model with the most total tokens, not first-seen', async () => {
    // Opus appears first but sonnet has more tokens
    const sessionsDir = createFixture(tmpDir, {
      parentLines: [
        makeUserEntry('test', { sessionId: 'sess-primary-1' }),
        makeAssistantEntry('claude-opus-4-6', 100, 50, { sessionId: 'sess-primary-1' })
      ],
      subagents: [
        [
          makeAssistantEntry('claude-sonnet-4-6', 5000, 3000, { sessionId: 'sess-primary-1' }),
          makeAssistantEntry('claude-sonnet-4-6', 5000, 3000, { sessionId: 'sess-primary-1' })
        ]
      ]
    });

    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test-primary', name: 'test', path: tmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    const s = sessions[0];

    // Sonnet has 10000+6000 = 16000 total tokens vs opus 100+50 = 150
    assert.equal(s.primaryModel, 'claude-sonnet-4-6',
      `expected sonnet as primary (most tokens), got ${s.primaryModel}`);
  });

  it('falls back to first model when no token data', async () => {
    const subTmpDir = fs.mkdtempSync(path.join(fixtureRoot, 'mc-test-primary2-'));
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionsDir = path.join(subTmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Minimal entry with model but no usage
    const entry = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-25T10:00:00Z',
      sessionId: 'sess-primary-2',
      message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'hi' }] }
    });
    fs.writeFileSync(path.join(sessionsDir, `${uuid}.jsonl`), entry + '\n');

    scanner.sessionCache.clear();
    const project = { sessionsDir, encodedPath: 'test-primary2', name: 'test', path: subTmpDir };
    const sessions = await scanner.getProjectSessions(project, {});
    assert.equal(sessions[0].primaryModel, 'claude-opus-4-6');

    fs.rmSync(subTmpDir, { recursive: true, force: true });
  });
});

describe('dedupeBySessionId', () => {
  it('keeps only the latest entry per sessionId', () => {
    const sessions = [
      { sessionId: 'sess-a', lastTimestamp: 1000, data: 'old' },
      { sessionId: 'sess-a', lastTimestamp: 2000, data: 'new' }
    ];

    const deduped = scanner.dedupeBySessionId(sessions);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].lastTimestamp, 2000);
    assert.equal(deduped[0].data, 'new');
  });

  it('leaves distinct sessionIds untouched', () => {
    const sessions = [
      { sessionId: 'sess-a', lastTimestamp: 1000 },
      { sessionId: 'sess-b', lastTimestamp: 1500 },
      { sessionId: 'sess-c', lastTimestamp: 2000 }
    ];

    const deduped = scanner.dedupeBySessionId(sessions);
    assert.equal(deduped.length, 3);
    assert.ok(deduped.find(s => s.sessionId === 'sess-a'));
    assert.ok(deduped.find(s => s.sessionId === 'sess-b'));
    assert.ok(deduped.find(s => s.sessionId === 'sess-c'));
  });

  it('preserves sessions without a sessionId (pass through)', () => {
    const sessions = [
      { data: 'no-id-1' },
      { sessionId: 'sess-a', lastTimestamp: 1000 },
      { data: 'no-id-2' }
    ];

    const deduped = scanner.dedupeBySessionId(sessions);
    assert.equal(deduped.length, 3);
    assert.ok(deduped.find(s => !s.sessionId && s.data === 'no-id-1'));
    assert.ok(deduped.find(s => !s.sessionId && s.data === 'no-id-2'));
    assert.ok(deduped.find(s => s.sessionId === 'sess-a'));
  });

  it('uses latest lastTimestamp when comparing duplicates', () => {
    const sessions = [
      { sessionId: 'sess-x', lastTimestamp: 3000, label: 'third' },
      { sessionId: 'sess-x', lastTimestamp: 1000, label: 'first' },
      { sessionId: 'sess-x', lastTimestamp: 2000, label: 'second' }
    ];

    const deduped = scanner.dedupeBySessionId(sessions);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].lastTimestamp, 3000);
    assert.equal(deduped[0].label, 'third');
  });

  it('treats undefined lastTimestamp as 0 when comparing', () => {
    const sessions = [
      { sessionId: 'sess-y', lastTimestamp: undefined, label: 'undefined' },
      { sessionId: 'sess-y', lastTimestamp: 100, label: 'has-timestamp' }
    ];

    const deduped = scanner.dedupeBySessionId(sessions);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].lastTimestamp, 100);
    assert.equal(deduped[0].label, 'has-timestamp');
  });
});

describe('aggregateSessions with subagent data', () => {
  it('aggregates tokensByModel across sessions including subagent models', () => {
    const sessions = [
      {
        metrics: {
          totalInputTokens: 5000,
          totalOutputTokens: 2000,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalCost: 0.10,
          totalDurationMs: 60000,
          turnCount: 5,
          toolCallCount: 3,
          messageCount: 10,
          tokensByModel: {
            'claude-opus-4-6': { input: 3000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.06 },
            'claude-sonnet-4-6': { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.04 }
          }
        },
        subagentCount: 3,
        timeSaved: { timeSavedMs: 120000 }
      },
      {
        metrics: {
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalCost: 0.02,
          totalDurationMs: 30000,
          turnCount: 2,
          toolCallCount: 1,
          messageCount: 4,
          tokensByModel: {
            'claude-haiku-4-5-20251001': { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.02 }
          }
        },
        timeSaved: { timeSavedMs: 60000 }
      }
    ];

    const agg = scanner.aggregateSessions(sessions);
    assert.ok(agg.tokensByModel['claude-opus-4-6']);
    assert.ok(agg.tokensByModel['claude-sonnet-4-6']);
    assert.ok(agg.tokensByModel['claude-haiku-4-5-20251001']);
    assert.equal(agg.tokensByModel['claude-sonnet-4-6'].input, 2000);
    assert.equal(agg.tokensByModel['claude-haiku-4-5-20251001'].output, 500);
  });

  it('sums subagentCount into totalSubagentCount', () => {
    const sessions = [
      {
        metrics: {
          totalInputTokens: 100, totalOutputTokens: 50,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.01, totalDurationMs: 1000,
          turnCount: 1, toolCallCount: 0, messageCount: 1,
          tokensByModel: {}
        },
        subagentCount: 3,
        timeSaved: { timeSavedMs: 5000 }
      },
      {
        metrics: {
          totalInputTokens: 200, totalOutputTokens: 100,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.02, totalDurationMs: 2000,
          turnCount: 2, toolCallCount: 1, messageCount: 2,
          tokensByModel: {}
        },
        subagentCount: 1,
        timeSaved: { timeSavedMs: 10000 }
      },
      {
        metrics: {
          totalInputTokens: 50, totalOutputTokens: 25,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.005, totalDurationMs: 500,
          turnCount: 1, toolCallCount: 0, messageCount: 1,
          tokensByModel: {}
        },
        timeSaved: { timeSavedMs: 2000 }
      }
    ];

    const agg = scanner.aggregateSessions(sessions);
    assert.equal(agg.totalSubagentCount, 4, '3 + 1 + 0 = 4 total subagents');
  });

  it('aggregates subagentCountByModel across sessions', () => {
    const sessions = [
      {
        metrics: {
          totalInputTokens: 100, totalOutputTokens: 50,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.01, totalDurationMs: 1000,
          turnCount: 1, toolCallCount: 0, messageCount: 1,
          tokensByModel: {},
          subagentTokensByModel: {},
          subagentCountByModel: { 'claude-sonnet-4-6': 2, 'claude-haiku-4-5-20251001': 1 }
        },
        subagentCount: 3,
        timeSaved: { timeSavedMs: 5000 }
      },
      {
        metrics: {
          totalInputTokens: 200, totalOutputTokens: 100,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.02, totalDurationMs: 2000,
          turnCount: 2, toolCallCount: 1, messageCount: 2,
          tokensByModel: {},
          subagentTokensByModel: {},
          subagentCountByModel: { 'claude-sonnet-4-6': 1 }
        },
        subagentCount: 1,
        timeSaved: { timeSavedMs: 10000 }
      }
    ];

    const agg = scanner.aggregateSessions(sessions);
    assert.equal(agg.subagentCountByModel['claude-sonnet-4-6'], 3);
    assert.equal(agg.subagentCountByModel['claude-haiku-4-5-20251001'], 1);
  });

  it('aggregates subagentTokensByModel across sessions', () => {
    const sessions = [
      {
        metrics: {
          totalInputTokens: 5000, totalOutputTokens: 2000,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.10, totalDurationMs: 60000,
          turnCount: 5, toolCallCount: 3, messageCount: 10,
          tokensByModel: {
            'claude-opus-4-6': { input: 3000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.06 },
            'claude-sonnet-4-6': { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.04 }
          },
          subagentTokensByModel: {
            'claude-sonnet-4-6': { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.04 }
          }
        },
        subagentCount: 1,
        timeSaved: { timeSavedMs: 120000 }
      },
      {
        metrics: {
          totalInputTokens: 1000, totalOutputTokens: 500,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.02, totalDurationMs: 30000,
          turnCount: 2, toolCallCount: 1, messageCount: 4,
          tokensByModel: {
            'claude-sonnet-4-6': { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            'claude-haiku-4-5-20251001': { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01 }
          },
          subagentTokensByModel: {
            'claude-haiku-4-5-20251001': { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01 }
          }
        },
        subagentCount: 1,
        timeSaved: { timeSavedMs: 60000 }
      }
    ];

    const agg = scanner.aggregateSessions(sessions);
    assert.ok(agg.subagentTokensByModel['claude-sonnet-4-6']);
    assert.equal(agg.subagentTokensByModel['claude-sonnet-4-6'].input, 2000);
    assert.ok(agg.subagentTokensByModel['claude-haiku-4-5-20251001']);
    assert.equal(agg.subagentTokensByModel['claude-haiku-4-5-20251001'].input, 500);
    // Opus had no subagent contribution
    assert.equal(agg.subagentTokensByModel['claude-opus-4-6'], undefined);
  });

  it('returns totalSubagentCount of 0 when no sessions have subagents', () => {
    const sessions = [
      {
        metrics: {
          totalInputTokens: 100, totalOutputTokens: 50,
          totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCost: 0.01, totalDurationMs: 1000,
          turnCount: 1, toolCallCount: 0, messageCount: 1,
          tokensByModel: {}
        },
        timeSaved: { timeSavedMs: 5000 }
      }
    ];

    const agg = scanner.aggregateSessions(sessions);
    assert.equal(agg.totalSubagentCount, 0);
  });
});
