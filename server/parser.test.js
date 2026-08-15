const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseSessionFile, buildHistoryIndex } = require('./parser');
const cost = require('./cost');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));

function writeFixture(name, lines) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function userLine(text, extra = {}) {
  return JSON.stringify({ type: 'user', message: { content: text }, ...extra });
}

test('parseSessionFile: full session with assistant usage, tools, timestamps', async () => {
  const usage1 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
  const usage2 = { input_tokens: 10, output_tokens: 5 };
  const p = writeFixture('full.jsonl', [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'sess-1' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'First Title' }),
    userLine('Please fix the login bug in the auth module', { sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00Z',
      message: {
        model: 'claude-sonnet-5',
        usage: usage1,
        content: [
          { type: 'text', text: 'Working on it' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/auth.js' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix auth"' } }
        ]
      }
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:02:00Z',
      message: {
        model: 'claude-haiku-4-5',
        usage: usage2,
        content: [{ type: 'tool_use', name: 'Write', input: { filePath: '/a/b/notes.md' } }]
      }
    }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5000 }),
    JSON.stringify({ type: 'agent-name', agentName: 'Renamed Session' })
  ]);

  const r = await parseSessionFile(p);
  assert.strictEqual(r.sessionId, 'sess-1');
  assert.strictEqual(r.sessionName, 'Renamed Session'); // last name entry wins
  assert.strictEqual(r.filePath, p);
  assert.strictEqual(r.firstTimestamp, Date.parse('2026-01-01T00:00:00Z'));
  assert.strictEqual(r.lastTimestamp, Date.parse('2026-01-01T00:02:00Z'));
  assert.deepStrictEqual(r.models.sort(), ['claude-haiku-4-5', 'claude-sonnet-5']);
  assert.strictEqual(r.primaryModel, 'claude-sonnet-5'); // most tokens

  const m = r.metrics;
  assert.strictEqual(m.totalInputTokens, 110);
  assert.strictEqual(m.totalOutputTokens, 55);
  assert.strictEqual(m.totalCacheReadTokens, 1000);
  assert.strictEqual(m.totalCacheWriteTokens, 200);
  assert.strictEqual(m.turnCount, 2);
  assert.strictEqual(m.messageCount, 3); // 1 user + 2 assistant
  assert.strictEqual(m.toolCallCount, 3);
  assert.strictEqual(m.totalDurationMs, 5000);

  const ts1 = Date.parse('2026-01-01T00:01:00Z');
  const ts2 = Date.parse('2026-01-01T00:02:00Z');
  const expectedCost = cost.calculateMessageCost(usage1, 'claude-sonnet-5', ts1)
    + cost.calculateMessageCost(usage2, 'claude-haiku-4-5', ts2);
  assert.strictEqual(m.totalCost, expectedCost);
  assert.deepStrictEqual(Object.keys(m.tokensByModel).sort(), ['claude-haiku-4-5', 'claude-sonnet-5']);
  assert.deepStrictEqual(m.tokensByModel['claude-sonnet-5'], {
    input: 100, output: 50, cacheRead: 1000, cacheWrite: 200,
    cost: cost.calculateMessageCost(usage1, 'claude-sonnet-5', ts1)
  });

  // Summary: goal + edited files + committed changes
  assert.strictEqual(r.summary, 'Please fix the login bug in the auth module [edited auth.js, notes.md; committed changes]');

  // timeSaved comes from cost.calculateTimeSaved
  assert.deepStrictEqual(r.timeSaved, cost.calculateTimeSaved(5000));
});

test('parseSessionFile: empty file', async () => {
  const p = writeFixture('empty.jsonl', ['']);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.sessionId, null);
  assert.strictEqual(r.sessionName, null);
  assert.strictEqual(r.summary, '(no summary available)');
  assert.strictEqual(r.firstTimestamp, null);
  assert.strictEqual(r.lastTimestamp, null);
  assert.deepStrictEqual(r.models, []);
  assert.strictEqual(r.primaryModel, 'unknown');
  assert.strictEqual(r.metrics.totalCost, 0);
  assert.strictEqual(r.metrics.messageCount, 0);
});

test('parseSessionFile: malformed and blank lines are skipped', async () => {
  const p = writeFixture('malformed.jsonl', [
    'not json at all',
    '{"type": "user", "message": {truncated',
    '   ',
    userLine('a valid message about testing malformed input')
  ]);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.metrics.messageCount, 1);
  assert.strictEqual(r.summary, 'a valid message about testing malformed input');
});

test('parseSessionFile: synthetic model skipped entirely', async () => {
  const p = writeFixture('synthetic.jsonl', [
    JSON.stringify({
      type: 'assistant',
      message: { model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } }
    })
  ]);
  const r = await parseSessionFile(p);
  // messageCount increments before the synthetic check; turn/tokens do not
  assert.strictEqual(r.metrics.messageCount, 1);
  assert.strictEqual(r.metrics.turnCount, 0);
  assert.strictEqual(r.metrics.totalInputTokens, 0);
  assert.deepStrictEqual(r.models, []);
});

test('parseSessionFile: user message filtering (noise, meta, tags, array content)', async () => {
  const p = writeFixture('usermsgs.jsonl', [
    userLine('toolu_01AbCdEfGh1234567890'),               // tool id noise
    userLine('deadbeefdeadbeef'),                          // hex noise
    userLine('shortid99'),                                 // short alnum noise
    userLine('/private/tmp/foo/bar'),                      // path noise
    userLine('[Request interrupted by user]'),             // interrupted
    userLine('meta text that is long enough', { isMeta: true }),
    userLine('hi'),                                        // too short
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: '<system>tagged</system> real goal here' }] } }),
    userLine('second real message for the summary check')
  ]);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.metrics.messageCount, 9);
  // First surviving message: tags stripped. "tagged real goal here" is >= 20 chars so no combining.
  assert.strictEqual(r.summary, 'tagged real goal here');
});

test('parseSessionFile: short goal combines with second message', async () => {
  const p = writeFixture('shortgoal.jsonl', [
    userLine('/gogogo fix stuff'),   // slash prefix stripped -> "fix stuff" (<20 chars)
    userLine('the real explanation of the task at hand')
  ]);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.summary, 'fix stuff — the real explanation of the task at hand');
});

test('parseSessionFile: long goal truncated to 120 chars', async () => {
  const long = 'x'.repeat(200);
  const p = writeFixture('longgoal.jsonl', [userLine(long)]);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.summary, 'x'.repeat(117) + '...');
  assert.strictEqual(r.summary.length, 120);
});

test('parseSessionFile: duration estimated from timestamps when no turn_duration', async () => {
  const p = writeFixture('duration.jsonl', [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'estimate duration from timestamps' } }),
    JSON.stringify({ type: 'system', timestamp: '2026-01-01T00:10:00Z' })
  ]);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.metrics.totalDurationMs, 600000);
});

test('parseSessionFile: more than 3 edited files summarized with +N more', async () => {
  const mkEdit = f => JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `/x/${f}` } }] }
  });
  const p = writeFixture('manyfiles.jsonl', [
    mkEdit('a.js'), mkEdit('b.js'), mkEdit('c.js'), mkEdit('d.js'), mkEdit('e.js')
  ]);
  const r = await parseSessionFile(p);
  assert.strictEqual(r.summary, 'edited a.js, b.js, c.js +2 more');
});

test('parseSessionFile: tag stripping equivalence on tricky inputs', async () => {
  // Pins /<[^>]+>/g replacement behavior, including unclosed and nested-looking tags
  const p = writeFixture('tags.jsonl', [
    userLine('before <a href="x">link</a> after'),
    userLine('unclosed <tag without close stays put mostly intact here'),
    userLine('weird <a<b> nested angle bracket case for the regex')
  ]);
  const r = await parseSessionFile(p);
  const t = await parseSessionFile(p); // deterministic
  assert.deepStrictEqual(r.summary, t.summary);
  // "before link after" is < 20 chars so it combines with the second message (unclosed tag untouched)
  assert.strictEqual(r.summary, 'before link after — unclosed <tag without close stays put mostly intact here');
});

test('buildHistoryIndex: first entry wins, malformed skipped, fields defaulted', async () => {
  const p = writeFixture('history.jsonl', [
    JSON.stringify({ sessionId: 's1', display: 'first display', timestamp: 111, project: 'projA' }),
    'garbage line',
    JSON.stringify({ sessionId: 's1', display: 'second display', timestamp: 222 }),
    JSON.stringify({ sessionId: 's2' }),
    JSON.stringify({ noSessionId: true })
  ]);
  const idx = await buildHistoryIndex(p);
  assert.deepStrictEqual(idx, {
    s1: { display: 'first display', timestamp: 111, project: 'projA' },
    s2: { display: '', timestamp: undefined, project: '' }
  });
});

test('buildHistoryIndex: missing file returns empty index', async () => {
  const idx = await buildHistoryIndex(path.join(tmpDir, 'nope.jsonl'));
  assert.deepStrictEqual(idx, {});
});
