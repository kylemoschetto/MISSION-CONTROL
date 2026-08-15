const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildLaunchArgs, findBinary, TERMINALS, restoreSession, shellQuote } = require('./restore');

describe('TERMINALS map', () => {
  it('includes all required terminals', () => {
    const required = ['ghostty', 'alacritty', 'kitty', 'cosmic-term', 'zeditor'];
    for (const name of required) {
      assert.ok(TERMINALS[name], `Missing terminal: ${name}`);
    }
  });

  it('marks full-support terminals', () => {
    assert.equal(TERMINALS.ghostty.full, true);
    assert.equal(TERMINALS.alacritty.full, true);
    assert.equal(TERMINALS.kitty.full, true);
  });

  it('marks partial-support terminals', () => {
    assert.equal(TERMINALS['cosmic-term'].full, false);
    assert.equal(TERMINALS.zeditor.full, false);
  });

  it('every terminal has a bin field', () => {
    for (const [name, entry] of Object.entries(TERMINALS)) {
      assert.ok(entry.bin, `Terminal ${name} missing bin field`);
    }
  });
});

describe('buildLaunchArgs — Linux full-support terminals', () => {
  const sessionId = 'abc-123';
  const cwd = '/home/user/project';

  it('alacritty: uses -e flag with bash -c and shell-quoted args', () => {
    const result = buildLaunchArgs('alacritty', sessionId, cwd, 'linux');
    assert.equal(result.type, 'spawn');
    assert.equal(result.bin, 'alacritty');
    assert.equal(result.partial, false);
    assert.deepEqual(result.args.slice(0, 3), ['-e', 'bash', '-c']);
    const cmd = result.args[3];
    assert.ok(cmd.includes(shellQuote(cwd)));
    assert.ok(cmd.includes(shellQuote(sessionId)));
  });

  it('ghostty: uses -e flag on Linux (not AppleScript)', () => {
    const result = buildLaunchArgs('ghostty', sessionId, cwd, 'linux');
    assert.equal(result.type, 'spawn');
    assert.equal(result.bin, 'ghostty');
    assert.equal(result.partial, false);
    assert.deepEqual(result.args.slice(0, 3), ['-e', 'bash', '-c']);
  });

  it('kitty: uses positional args (no -e flag)', () => {
    const result = buildLaunchArgs('kitty', sessionId, cwd, 'linux');
    assert.equal(result.type, 'spawn');
    assert.equal(result.bin, 'kitty');
    assert.equal(result.partial, false);
    assert.deepEqual(result.args.slice(0, 2), ['bash', '-c']);
    assert.ok(result.args[2].includes(shellQuote(sessionId)));
  });
});

describe('buildLaunchArgs — Linux partial-support terminals', () => {
  const sessionId = 'abc-123';
  const cwd = '/home/user/project';

  it('cosmic-term: uses -w flag, returns resumeCommand', () => {
    const result = buildLaunchArgs('cosmic-term', sessionId, cwd, 'linux');
    assert.equal(result.type, 'spawn');
    assert.equal(result.bin, 'cosmic-term');
    assert.equal(result.partial, true);
    assert.deepEqual(result.args, ['-w', cwd]);
    assert.equal(result.resumeCommand, `claude --resume ${sessionId}`);
  });

  it('zeditor: uses positional dir arg, returns resumeCommand', () => {
    const result = buildLaunchArgs('zeditor', sessionId, cwd, 'linux');
    assert.equal(result.type, 'spawn');
    assert.equal(result.bin, 'zeditor');
    assert.equal(result.partial, true);
    assert.deepEqual(result.args, [cwd]);
    assert.equal(result.resumeCommand, `claude --resume ${sessionId}`);
  });
});

describe('buildLaunchArgs — macOS guard', () => {
  const sessionId = 'abc-123';
  const cwd = '/Users/dev/project';

  it('ghostty on macOS uses AppleScript path', () => {
    const result = buildLaunchArgs('ghostty', sessionId, cwd, 'darwin');
    assert.equal(result.type, 'applescript');
    assert.equal(result.partial, false);
    assert.ok(result.script.includes('Ghostty'));
    assert.ok(result.script.includes(sessionId));
    assert.ok(result.script.includes(cwd));
  });

  it('non-ghostty on macOS uses spawn (not AppleScript)', () => {
    const result = buildLaunchArgs('alacritty', sessionId, cwd, 'darwin');
    assert.equal(result.type, 'spawn');
    assert.equal(result.bin, 'alacritty');
  });

  it('shell-quotes cwd in the typed AppleScript command (not just escaped)', () => {
    const malicious = '/tmp$(rm -rf /)';
    const result = buildLaunchArgs('ghostty', sessionId, malicious, 'darwin');
    // keystroke types this text directly into a live shell, so metacharacters
    // must be neutralized by shell quoting, not just AppleScript string escaping.
    assert.ok(result.script.includes("'/tmp$(rm -rf /)'"));
    assert.ok(!result.script.includes('cd /tmp$('));
  });

  it('shell-quotes sessionId in the typed AppleScript command (not just escaped)', () => {
    const malicious = 'abc; curl attacker.com';
    const result = buildLaunchArgs('ghostty', malicious, cwd, 'darwin');
    assert.ok(result.script.includes("'abc; curl attacker.com'"));
    assert.ok(!result.script.includes('resume abc;'));
  });
});

describe('buildLaunchArgs — error handling', () => {
  it('throws for unsupported terminal name', () => {
    assert.throws(
      () => buildLaunchArgs('nonexistent-term', 'id', '/tmp', 'linux'),
      /unsupported terminal/i
    );
  });

  it('handles cwd with spaces via shell quoting', () => {
    const cwd = '/home/user/my project/code';
    const result = buildLaunchArgs('alacritty', 'id', cwd, 'linux');
    assert.ok(result.args[3].includes(shellQuote(cwd)));
  });

  it('neutralizes shell metacharacters in cwd', () => {
    const malicious = '/tmp$(rm -rf /)';
    const result = buildLaunchArgs('alacritty', 'id', malicious, 'linux');
    const cmd = result.args[3];
    // Should be single-quoted, not bare-interpolated
    assert.ok(cmd.includes("'/tmp$(rm -rf /)'"));
    assert.ok(!cmd.includes('cd /tmp$('));
  });

  it('neutralizes shell metacharacters in sessionId', () => {
    const malicious = 'abc; curl attacker.com';
    const result = buildLaunchArgs('alacritty', malicious, '/tmp', 'linux');
    const cmd = result.args[3];
    assert.ok(cmd.includes("'abc; curl attacker.com'"));
  });

  it('handles sessionId with embedded single quotes', () => {
    const tricky = "it's-a-test";
    const result = buildLaunchArgs('alacritty', tricky, '/tmp', 'linux');
    const cmd = result.args[3];
    // shellQuote escapes single quotes: 'it'\''s-a-test'
    assert.ok(cmd.includes(shellQuote(tricky)));
  });
});

describe('findBinary', () => {
  it('returns true for a binary on PATH (bash)', () => {
    assert.equal(findBinary('bash'), true);
  });

  it('returns false for a binary not on PATH', () => {
    assert.equal(findBinary('nonexistent-binary-xyz-999'), false);
  });
});

describe('restoreSession — validation', () => {
  it('rejects for unsupported terminal', async () => {
    await assert.rejects(
      () => restoreSession('abc', '/tmp', 'fake-terminal'),
      /unsupported terminal/i
    );
  });
});
