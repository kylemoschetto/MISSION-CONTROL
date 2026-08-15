# MISSION-CONTROL

## Required Context Files

On session start, read these files in `.claude/` directory:

- **`claude.md`** — Master context, conflict resolution matrix, agent systems
- **`me.md`** — KMo's profile, communication style, decision preferences
- **`voice.md`** — Canonical voice & tone guide for writing as KMo
- **`prd.md`** — Product requirements, features, scope
- **`workflow.md`** — Beads workflow, session lifecycle
- **`infra.md`** — Tech stack, architecture, coding standards
- **`security.md`** — Compliance, secrets, data handling (highest precedence)
- **`team.md`** — Key contacts, roles, authority levels
- **`links.md`** — Critical URLs and external properties
- **`integrations.md`** — External tool connections
- **`changelog.md`** — Version history and completed work

## Conflict Resolution

When context files conflict, follow the precedence order defined in `.claude/claude.md`:

1. `security.md` — Safety & compliance override everything
2. `me.md` — KMo's preferences override process
3. `claude.md` — Global conventions and baseline
4. `prd.md` — Product requirements (can't violate 1-3)
5. `workflow.md` — Process and execution procedures

## Key Commands

| Command | Purpose |
|---------|---------|
| `/gogogo` | Start session: load context, check status, show ready work |
| `/wrapup` | End session: commit, sync beads, push |
| `/scribe` | Document creation & planning dispatcher |
| `/quartermaster` | Analysis & review dispatcher |
| `/story` | Add feature to PRD interactively |
| `/create-prompt` | Build prompts using R.G.C.O.A. framework |

## Directory Layout

```
MISSION-CONTROL/
  CLAUDE.md                  # This file — brain/index
  .claude/                   # Context files, commands, agents
    commands/                # Slash commands
    agents/                  # Sub-agent definitions
  context/                   # Working documents, references, decisions
```


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
