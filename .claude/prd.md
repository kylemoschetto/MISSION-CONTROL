# Product Requirements Document

Purpose: This file defines what we are building and for whom.

---

## 1. The Big Picture

- **Project Name:** MISSION-CONTROL
- **One-Sentence Summary:** [To be defined]
- **Who is this for?** [To be defined]
- **What this will NOT do:** [To be defined]

---

## 2. The Features

> User stories will be added here via `/story` command or direct editing.

---

### Story 1: Subagent Usage Breakdown per Project

**As a** developer reviewing a project's cost and activity,
**I want to** see how many subagents were spawned and which models they used,
**so that** I can understand the true scope of a session without digging into raw files.

**Notes:**
- Subagents are already discovered by the scanner and their metrics merged into parent sessions, but the count and per-model breakdown are not surfaced in the UI at all.
- The presentation must not clutter the existing analysis section. Subagent data should integrate into existing surfaces rather than add new top-level charts or panels.
- Subagent count is a per-session fact; model breakdown is useful at the project aggregate level.

**Acceptance Criteria:**

1. The session table shows a subagent count for each session that spawned at least one subagent (e.g., a small badge or plain numeric column). Sessions with no subagents show nothing (no zero, no dash — just blank).
2. The project-level Rollup section (Tokens by Model) attributes tokens that originated from subagents vs. the parent session. Each model row shows parent and subagent token contributions so the user can see how much work subagents drove.
3. No new top-level chart is added to the ChartsPanel. Subagent information must not widen or restructure the three-chart layout.
4. The backend exposes subagent count per session. `mergeSubagentMetrics()` must increment a `subagentCount` field on the parent session so the API can return it without a separate call.
5. At the project aggregate level, the API returns total subagent count so the Rollup can display it without client-side summation over all sessions.
6. All new backend fields are covered by tests in `scanner.test.js`.

---

### Story 2: Configurable Terminal Emulator for Session Launch

**As a** developer using MISSION-CONTROL on Linux,
**I want to** configure which terminal emulator opens when I click "Launch" to resume a session,
**so that** I can use my preferred terminal (Alacritty, COSMIC Terminal, etc.) instead of being locked to Ghostty.

**Notes:**
- The current `server/restore.js` hardcodes Ghostty via AppleScript (macOS-only). This story adds Linux support by introducing a configurable terminal setting.
- The existing macOS/Ghostty path continues to work as-is; this adds a parallel Linux launch path.
- Configuration lives in `config.json` as a `terminal` key (e.g., `"terminal": "alacritty"`).
- Default remains `ghostty`. The app maps known terminal names to their launch commands internally.
- Supported terminals at minimum: `ghostty`, `alacritty`, `cosmic-term`, `kitty`.

**Acceptance Criteria:**

1. `config.json` accepts a `terminal` field. When absent, defaults to `ghostty`.
2. The server maps known terminal names to platform-appropriate launch commands (e.g., `alacritty -e` on Linux).
3. Clicking "Launch" in the UI opens the configured terminal and resumes the session in the correct project directory.
4. The macOS AppleScript path for Ghostty remains functional and is used when the platform is macOS and terminal is `ghostty`.
5. If the configured terminal is not found on `$PATH`, the server returns a clear error to the UI.
6. New launch logic is covered by tests.

* **Story 2:** As a developer using MISSION-CONTROL on Linux, I want to configure which terminal emulator opens when I click "Launch" to resume a session, so that I can use my preferred terminal instead of being locked to Ghostty.
    * Feature name: `terminal_config`

---

## 3. The Look and Feel

> Visual style, key screens, and UX patterns will be defined here.
