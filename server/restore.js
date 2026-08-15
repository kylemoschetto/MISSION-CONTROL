const { execFile, execFileSync, spawn } = require('node:child_process');

const TERMINALS = {
  ghostty:       { bin: 'ghostty',     execFlag: '-e', full: true },
  alacritty:     { bin: 'alacritty',   execFlag: '-e', full: true },
  kitty:         { bin: 'kitty',       execFlag: null, full: true },
  'cosmic-term': { bin: 'cosmic-term', cwdFlag: '-w',  full: false },
  zeditor:       { bin: 'zeditor',     cwdFlag: null,  full: false },
};

function shellQuote(s) {
  return "'" + s.replaceAll("'", String.raw`'\''`) + "'";
}

function findBinary(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// "exec" replaces the intermediate bash process rather than spawning claude as its child.
function buildResumeCmd(cwd, sessionId, { useExec } = {}) {
  const claudeCmd = `${useExec ? 'exec ' : ''}claude --resume ${shellQuote(sessionId)}`;
  return `cd ${shellQuote(cwd)} && ${claudeCmd}`;
}

function buildLaunchArgs(terminalName, sessionId, cwd, platform) {
  const terminal = TERMINALS[terminalName];
  if (!terminal) {
    throw new Error(`Unsupported terminal: "${terminalName}". Supported: ${Object.keys(TERMINALS).join(', ')}`);
  }

  // macOS + ghostty: use AppleScript (legacy path)
  if (platform === 'darwin' && terminalName === 'ghostty') {
    // keystroke "types" this text directly into the destination shell, so it must
    // be shell-quoted (not just AppleScript-escaped) to neutralize shell metacharacters.
    const typedCmd = buildResumeCmd(cwd, sessionId);
    const safeTypedCmd = typedCmd.replace(/["\\]/g, String.raw`\$&`);
    const script = `
      tell application "Ghostty"
        activate
      end tell
      delay 0.5
      tell application "System Events"
        tell process "Ghostty"
          keystroke "n" using command down
          delay 0.3
          keystroke "${safeTypedCmd}"
          key code 36
        end tell
      end tell
    `;
    return { type: 'applescript', script, partial: false };
  }

  // Full-support terminals: launch with command execution
  if (terminal.full) {
    const execCmd = buildResumeCmd(cwd, sessionId, { useExec: true });
    const args = terminal.execFlag
      ? [terminal.execFlag, 'bash', '-c', execCmd]
      : ['bash', '-c', execCmd];
    return { type: 'spawn', bin: terminal.bin, args, partial: false };
  }

  // Partial-support terminals: open in project dir, user runs resume manually
  const resumeCommand = `claude --resume ${sessionId}`;
  const args = terminal.cwdFlag
    ? [terminal.cwdFlag, cwd]
    : [cwd];
  return { type: 'spawn', bin: terminal.bin, args, partial: true, resumeCommand };
}

function restoreSession(sessionId, cwd, terminal = 'ghostty') {
  let launch;
  try {
    launch = buildLaunchArgs(terminal, sessionId, cwd, process.platform);
  } catch (err) {
    return Promise.reject(err);
  }

  if (!findBinary(launch.type === 'applescript' ? 'osascript' : launch.bin)) {
    const bin = launch.type === 'applescript' ? 'osascript' : launch.bin;
    return Promise.reject(new Error(`"${bin}" not found on PATH. Is ${terminal} installed?`));
  }

  return new Promise((resolve, reject) => {
    if (launch.type === 'applescript') {
      execFile('osascript', ['-e', launch.script], (err) => {
        if (err) {
          reject(new Error(`Failed to restore session: ${err.message}`));
        } else {
          resolve({ success: true, sessionId, cwd, partial: false });
        }
      });
      return;
    }

    let settled = false;

    const child = spawn(launch.bin, launch.args, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to launch ${terminal}: ${err.message}`));
      }
    });

    child.unref();

    // Defer resolve so a synchronous spawn error can settle the promise first
    process.nextTick(() => {
      if (!settled) {
        settled = true;
        const result = { success: true, sessionId, cwd, partial: launch.partial };
        if (launch.resumeCommand) {
          result.resumeCommand = launch.resumeCommand;
        }
        resolve(result);
      }
    });
  });
}

module.exports = { restoreSession, buildLaunchArgs, findBinary, shellQuote, TERMINALS };
