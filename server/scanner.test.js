const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scanner = require('./scanner');
const config = require('./config');

// --- Test Fixtures ---

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
    // Ensure config is loaded so parser/cost don't blow up
    config.load();
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
    const subTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-sub-'));
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

describe('subagent metric merging', () => {
  let tmpDir;
  let sessionsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-merge-'));
    config.load();

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
});

describe('primaryModel selection', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-primary-'));
    config.load();
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
    const subTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-primary2-'));
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
});
