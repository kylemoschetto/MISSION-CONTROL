# FRAGO: Story 2 — Configurable Terminal Emulator (`terminal_config`)

**Source story:** PRD Story 2 — Configurable Terminal Emulator for Session Launch
**Feature name:** `terminal_config`
**Date:** 2026-03-25
**Status:** Planning

---

## Situation

`server/restore.js` currently hardcodes Ghostty via macOS AppleScript as the only way to resume a session from the UI. This works only on macOS and only with Ghostty. The user runs Linux and uses Alacritty (and other terminals). The "Launch" button is effectively dead on Linux.

The fix is: read a `terminal` key from `config.json`, map known terminal names to platform-appropriate launch commands, and fall back to a clear error when the configured terminal isn't on `$PATH`. The macOS/AppleScript/Ghostty path is preserved as-is and stays active when `platform === 'darwin'` and `terminal === 'ghostty'`.

---

## Key Files

| File | Role |
|------|------|
| `server/restore.js` | All current launch logic lives here — the primary change target |
| `server/config.js` | Config loader/getter — no changes needed, `config.get()` already handles the `terminal` key via pass-through |
| `config.json` / `config.example.json` | Add `"terminal": "ghostty"` as documented default |
| `server/index.js` | POST `/api/restore/:sessionId` — passes `cwd` to `restoreSession()`; may need to pass config |
| `public/app.js` | Launch button — surfaces error message returned by the API |

---

## Scope Boundaries

**In scope:**
- Linux launch path for: `ghostty`, `alacritty`, `cosmic-term`, `kitty`
- Config-driven terminal selection with a safe default
- `$PATH` check with a clear error response
- Tests for new logic

**Out of scope:**
- macOS support for non-Ghostty terminals (future story)
- Windows support
- UI for changing the terminal setting (config.json edited by hand)
- Auto-detection of installed terminals

---

## Work Items (Convoy Order)

### Convoy 1 — Foundation (must land first, no UI dependency)

**Item 1:** Add `terminal` key to `config.example.json` with default `"ghostty"`

Simple documentation/default value change. Keeps new installs working without manual config edits.

**Item 2:** Refactor `server/restore.js` — add Linux terminal launch path

Replace the single-path AppleScript function with a platform-aware `restoreSession()`:
- If `process.platform === 'darwin'` and `terminal === 'ghostty'`: existing AppleScript path (no change)
- Otherwise: build a Linux exec command for the configured terminal
- Terminal-to-command map (internal, not config):
  - `ghostty`: `ghostty -e`
  - `alacritty`: `alacritty -e`
  - `cosmic-term`: `cosmic-term -e`
  - `kitty`: `kitty`
- Before exec, verify the terminal binary is on `$PATH` using `which` or equivalent; reject with a descriptive error if not found
- `restoreSession()` must accept `terminal` as a parameter (passed from the route handler)

**Item 3:** Wire `terminal` config into the restore route (`server/index.js`)

The POST `/api/restore/:sessionId` handler currently calls `restore.restoreSession(sessionId, cwd)`. It needs to read `config.get().terminal` (defaulting to `'ghostty'`) and pass it as a third argument. This is a one-liner change but must be a discrete commit.

### Convoy 2 — Tests (depends on Convoy 1)

**Item 4:** Write tests for `restore.js` Linux launch path

New test file `server/restore.test.js` (Node built-in test runner, matching `scanner.test.js` style). Cover:
- Each supported terminal name produces the correct exec command string
- Unknown/unsupported terminal name produces an error
- Binary not on `$PATH` produces a clear error with the terminal name in the message
- macOS path is still invoked when `platform === 'darwin'` and `terminal === 'ghostty'`

Note: the actual `exec` call must be stubbed/injected so tests don't spawn real processes. This is the only place mocking is justified — we're testing command construction, not OS process spawning.

### Convoy 3 — Error Surface (depends on Convoy 1; parallel with Convoy 2)

**Item 5:** Surface launch errors in the UI (`public/app.js`)

The Launch button currently does not display errors returned by the API. If the restore call fails (e.g., terminal not on `$PATH`), the user sees nothing. Add minimal error display: show the error message string near the Launch button for the affected session. No new modal, no new panel — inline text is sufficient.

---

## Acceptance Criteria Mapping

| AC | Covered by |
|----|------------|
| 1. `config.json` accepts `terminal`, defaults to `ghostty` | Item 1 |
| 2. Server maps terminal names to platform-appropriate launch commands | Item 2 |
| 3. Clicking Launch opens configured terminal and resumes session in correct cwd | Item 2 + Item 3 |
| 4. macOS AppleScript path for Ghostty remains functional | Item 2 |
| 5. Clear error when terminal not found on `$PATH` | Item 2 + Item 5 |
| 6. New launch logic covered by tests | Item 4 |

---

## Beads Issue Commands

Run in order. Create the epic first, then the children using `--parent` to link them.

```bash
# Epic
bd create "Story 2: Configurable Terminal Emulator for Session Launch" --type epic

# Convoy 1 — Foundation
bd create "Add terminal key to config.example.json (default: ghostty)" --type task --parent <epic-id> -p 2
bd create "Refactor restore.js: add Linux terminal launch path with PATH check" --type feature --parent <epic-id> -p 1
bd create "Wire terminal config into POST /api/restore route" --type task --parent <epic-id> -p 1

# Convoy 2 — Tests
bd create "Write restore.test.js: cover Linux launch path, unsupported terminal, PATH-not-found, macOS guard" --type task --parent <epic-id> -p 1

# Convoy 3 — Error Surface
bd create "Surface restore API error message near Launch button in UI" --type feature --parent <epic-id> -p 2
```

Replace `<epic-id>` with the ID printed after the first `bd create` command.

---

## Open Questions

- Should `cosmic-term` be invoked as `cosmic-term -e` or `cosmic-term --command`? Need to verify the actual CLI flag before implementation. Do not guess.
- Should `ghostty` on Linux use `-e` or `--` as the command separator? Need to verify against Ghostty Linux docs.
- The `which` approach for PATH checking works fine, but `child_process.execFileSync('which', [binary])` throws on not-found; an alternative is checking `process.env.PATH.split(':').some(...)`. Either is acceptable — implementer's choice, but must be tested.
