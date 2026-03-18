# Infrastructure

Purpose: This file describes the project's technical foundation — hosting, languages, coding standards, and how to run the code.

---

## What We're Building

- **Programming Language:** JavaScript (Node.js 24.x LTS)
- **Main Framework/Tool:** Express 4.x
- **A Quick Summary:** Local dashboard for monitoring Claude Code sessions — see `prd.md` for full details

---

## How to Run It

- **Installation Command:** `npm install`
- **Startup Command:** `npm start` (production) or `npm run dev` (auto-restart via `node --watch`)
- **Local Address:** `http://localhost:9000`

---

## Project Architecture & Conventions

- **Framework:** Express 4 with vanilla JS (no build step, no transpilation)
- **Directory Structure:**
  - `server/` — Express server and API routes
  - `public/` — Static frontend assets (HTML, CSS, React 18 loaded via CDN)
  - `config.example.json` — Default configuration template

---

## Code Generation Style Guide

- **Variable Naming:** camelCase
- **File Naming:** kebab-case
- **Linting:** None configured — keep code simple and consistent

---

## Where It Lives

- **Hosting Provider:** Local-only (runs on developer machine)
- **External Services:** None — reads Claude Code's local `.jsonl` files

---

## Data Storage

- **Data Storage Method:** File-based — reads Claude Code JSONL session files directly
- **Schema Details:** No database; config stored in `config.json` (gitignored)
