# Changelog

Purpose: Running log of all notable changes, features, and workflow updates.

> Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
> adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

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
