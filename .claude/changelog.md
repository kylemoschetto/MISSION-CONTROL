# Changelog

Purpose: Running log of all notable changes, features, and workflow updates.

> Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
> adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- SonarQube quality gate cleanup — all 107 open findings + 1 security hotspot resolved (PR #4)
  - Path-injection BLOCKERs in `server/scanner.js` fixed via `resolveWithin()` containment (sessionsDir within the Claude projects dir, scanPath within `$HOME`), with traversal tests; note: a scanPath outside `$HOME` now yields no projects
  - Transcript parser decomposed (cognitive complexity 110 → under limit), pinned by 12 new characterization tests in `server/parser.test.js`; tag-strip regex rewritten backtracking-safe
  - Express `x-powered-by` header disabled (version disclosure hotspot)
  - Frontend accessibility: keyboard + `role="button"` on clickable divs/spans, explicit button `type` attributes
  - User-influenced URL parts percent-encoded in `public/app.js` fetches
  - Mechanical cleanups across server + frontend: `node:` import prefixes, optional chaining, `toSorted`/`localeCompare`, `Number.parseInt/parseFloat`, Sets for membership checks, flattened nested ternaries, stable React keys
  - Test suite grew 81 → 96 tests
  - Accepted-with-rationale in SonarCloud: `beads.js` S4036 (intentional PATH lookup of `bd`), 2× S6549 (existence checks on contained paths), 2× S8476 (same-origin, percent-encoded client URLs)

### Added

- Story 6: Dynamic Pricing Service — fetches Claude API pricing from LiteLLM at startup and daily refresh
  - `server/pricing.js` fetches community pricing JSON at startup and every 24h while running
  - Prices stored as dated entries in `pricing-history.json` (gitignored, seeded from `server/pricing-seed.json`)
  - Historical sessions resolved to pricing in effect on their date (not repriced at current rates)
  - Offline-safe: falls back to last known history if LiteLLM unreachable
  - `pricing` block in `config.json` now acts as manual override only (optional, no longer required)
  - `config.example.json` no longer includes pricing block; unknown models fall back to latest known prices (or zero when unmatched)
  - Upgrade note: an existing `pricing` block in `config.json` overrides fetched pricing entirely — delete it unless you intend a manual override

- Story 2: Configurable Terminal Emulator for Session Launch — all 6 acceptance criteria implemented
  - `config.example.json` accepts `terminal` key (default: `ghostty`)
  - `restore.js` refactored with `TERMINALS` map, `buildLaunchArgs()` (pure), `findBinary()` (PATH check)
  - Full-support terminals: ghostty, alacritty, kitty (spawn with `-e` or positional args)
  - Partial-support terminals: cosmic-term (opens in project dir), zeditor (opens/focuses project)
  - Partial terminals return `resumeCommand`; Launch button transitions to "Copy Cmd" (blue) for clipboard copy
  - macOS + ghostty preserves existing AppleScript path; all others use cross-platform spawn
  - POST `/api/restore` reads terminal from config, passes to `restoreSession()`
  - 19 tests covering all terminals, platform routing, error paths, PATH validation, and injection prevention
- Story 3: Readable Adaptive Layout — responsive column visibility and typography baseline increase
  - Base type scale raised to 14px; no text rendered below ~11px (including chart labels)
  - Session table uses priority-based column config; both 1440px and 1280px breakpoints govern the session table's column priorities, hiding lower-priority columns progressively
  - Columns remain sortable and searchable when hidden; responsive breakpoints ensure legibility on laptops and desktops
- Story 4: Global Time-Window Selection — Grafana-style date range filtering
  - Drag horizontally on any chart to select a date window; all dashboard stats (stat tiles, charts, session table) instantly filter to range
  - Reset chip appears when window selected; Esc key clears selection
  - Server endpoints accept `from` and `to` query parameters for time-range filtering
- Story 5: Beads Metrics Integration — cost-per-bead and beads-closed/created tracking
  - Projects with `.beads/` directory display BEADS and $/BEAD stat tiles (closed count, created count, spend ÷ closed)
  - Metrics aggregated across projects when none selected; stat tiles absent entirely for projects without beads
  - Read-only integration via `bd export`; no write or state mutation

### Fixed

- Historical sessions were repriced at current rates; costs now resolve by session date (Story 6)
- Shell injection in `restore.js`: `cwd` and `sessionId` from HTTP request were interpolated bare into `bash -c` strings; now shell-quoted via `shellQuote()`
- Spawn promise race: `resolve()` fired synchronously before spawn `'error'` event could settle, causing silent false-success; now deferred via `process.nextTick` with a `settled` flag
- Fetch `.catch()` in Launch button silently swallowed network errors; now shows error feedback
- `clipboard.writeText()` in Copy Cmd handler was not awaited; "Copied!" could display before write succeeded
- CSS `--blue-dim` variable was not defined; button used hardcoded fallback that didn't match the theme

- Story 1: Subagent Usage Breakdown per Project — all 6 acceptance criteria implemented
  - `mergeSubagentMetrics()` increments `subagentCount` on parent session
  - `aggregateSessions()` returns `totalSubagentCount` across sessions
  - Session table has dedicated "Subs" column (sortable, blank when zero)
  - Tokens-by-Model rollup shows parent vs. subagent token attribution per model row
  - `subagentTokensByModel` tracked through merge and aggregation for attribution
  - 14 tests covering all new backend fields and edge cases
- Beads epic `lg8` with 5 child issues (lg8.1–lg8.5) and dependency chain for Story 1

### Fixed

- Subagent JSONL files (`{uuid}/subagents/*.jsonl`) were never scanned, hiding sonnet/haiku usage and undercounting tokens, costs, and tool calls
- `primaryModel` used first-seen model instead of highest-token-usage model, always showing "opus"

### Added

- Test suite using `node:test` with 8 tests for subagent discovery, metric merging, and primaryModel selection
- `npm test` script in package.json

### Changed

- Upgraded React from 18 to 19 (React 19 removed UMD builds; now loaded via esm.sh CDN + import maps)
- Switched app.js from global destructuring to ESM imports for React
- Upgraded minimum Node.js version from v18 to v24 LTS (v18 reached EOL April 2025)
- Added `.nvmrc` pinning Node 24 for nvm/fnm users
- Added `engines` field to `package.json` enforcing Node >=24.0.0
- Filled in `infra.md` with actual project runtime, framework, and architecture details
- Filled in `sbom.md` technology stack table (Node 24.x, Express ^4.21.0, Chokidar ^3.6.0)

### Added

- Initial project scaffold from vibe-md-templates + VEAP best practices
- Context files: claude.md, prd.md, workflow.md, security.md, infra.md, sbom.md, tests.md
- VEAP additions: me.md (symlink), voice.md (symlink), team.md, links.md, integrations.md
- Scribe and Quartermaster agent systems
- Session commands: /gogogo, /wrapup, /story
- Beads issue tracking initialized

---

## [0.1.0] - 2026-03-15

### Added

- Project scaffolded with full context file structure
- Agent systems (Scribe + Quartermaster) with all specialist sub-agents
- Working directories: context/drafts, references, decisions, daily-notes, projects, templates
