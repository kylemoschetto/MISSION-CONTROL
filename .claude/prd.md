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
- Supported terminals at minimum: `ghostty`, `alacritty`, `cosmic-term`, `kitty`, `zeditor`.

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

### Story 3: Readable, Adaptive Layout

**As a** developer viewing the dashboard on a laptop screen,
**I want** the UI to be legible without zooming, with rows that adapt instead of shrinking,
**so that** I can read session data at a glance without losing information per row.

**Notes:**
- Root cause: base font is 12px with most UI text at 10–11px, and chart SVG axis labels render at 5–5.5px inside a scaled viewBox.
- Direction chosen: bigger type with adaptive columns — the session table drops lower-priority columns at narrower widths rather than shrinking text or forcing horizontal scroll.

**Acceptance Criteria:**

1. Base font size raised to ~14px; no UI text renders below ~11px effective size, including chart axis/tick labels.
2. The session table defines column priorities; at laptop widths, lower-priority columns are hidden so remaining columns stay complete and legible.
3. Hidden-column information remains reachable (e.g., wider viewport shows it again; no data is lost, only deferred).
4. Charts remain proportionate after the type-scale change (no clipped labels, no overflowing legends).
5. No horizontal page scroll at common laptop widths (~1280–1440px).

---

### Story 4: Global Time-Window Selection (Drag-to-Zoom)

**As a** developer analyzing spend over time,
**I want to** drag-select a time window on any chart, Grafana-style,
**so that** the whole dashboard (stats, charts, session table) focuses on that period — e.g., comparing April vs May spend.

**Notes:**
- Decision: the selected window is a single global filter, not per-chart zoom. Stat tiles, all three charts, and the session table recompute for the window.
- Aggregation is already client-side, so this is frontend state + filtering; no API change.

**Acceptance Criteria:**

1. Dragging horizontally on any chart selects a time window with a visible selection region during the drag.
2. On release, the window becomes the dashboard-wide time range: stat tiles, charts, and the session table all reflect only that range.
3. A visible "reset" affordance (and Esc) clears the window and restores the full range.
4. Chart x-axes re-scale to the selected window (not just dimming excluded points).
5. The selection composes with existing project selection (window + project filter apply together).
6. New filtering/aggregation logic is covered by tests.

---

### Story 5: Beads Metrics per Project ($ per Bead)

**As a** developer tracking work with beads,
**I want to** see beads created/closed per project and dollars-per-bead for the selected time window,
**so that** I can relate spend to delivered work.

**Notes:**
- Detection is per scanned project: a project has beads iff a `.beads/` directory exists. Projects without beads show nothing — no empty tile, no error.
- Decision: $/bead = spend in window ÷ beads *closed* in window (cost per delivered unit). Created count is shown alongside for visibility.
- Read-only against beads (`bd list --json` or equivalent); never mutates beads state.
- With no project selected, metrics aggregate across all beads-enabled projects.

**Acceptance Criteria:**

1. The backend detects beads per project and exposes bead created/closed counts with timestamps via the API.
2. The UI shows, for the selected project and active time window: beads created, beads closed, and $/bead (spend ÷ closed; hidden or "—" when zero closed).
3. With no project selected, the metrics aggregate across all beads-enabled projects.
4. Projects without beads render no beads UI at all; the dashboard is unchanged for them.
5. Bead counts respect the global time window from Story 4.
6. Backend beads parsing and aggregation are covered by tests, including the no-beads and empty-window cases.

---

### Story 6: Dynamic Pricing with Dated History

**As a** developer relying on the dashboard's cost numbers,
**I want** pricing fetched dynamically at startup and applied by the date a session ran,
**so that** I don't maintain hardcoded prices and historical costs stop drifting when prices change.

**Notes:**
- See decision record: `context/decisions/pricing-source.md`.
- Source: LiteLLM's `model_prices_and_context_window.json`, fetched on server startup + 24h refresh while running; appended to a dated local `pricing-history.json` only on change.
- Ships seeded with Claude 5-era and prior-generation rates (Fable 5 $10/$50, Opus 5 $5/$25, Sonnet 5 $2/$10 intro, Haiku 4.5 $1/$5, plus existing 4.x rates) so old sessions price sensibly.
- `config.json` pricing becomes an optional override, no longer the source of truth.

**Acceptance Criteria:**

1. On startup, the server fetches LiteLLM pricing, normalizes Anthropic model IDs and per-token → per-MTok units, and appends a dated history entry when prices changed.
2. Cost calculation resolves each session's price by (model, session date) from the history.
3. Fetch failure (offline) falls back to the last recorded history without crashing; a log line notes the stale data.
4. The shipped seed history covers Claude 5 family and existing 4.x models so current data prices correctly before the first successful fetch.
5. `config.json` `pricing` entries, when present, override fetched values for matching models.
6. Pricing fetch parsing, history append/diff, date resolution, and override logic are covered by tests.

---

## 3. The Look and Feel

> Visual style, key screens, and UX patterns will be defined here.
