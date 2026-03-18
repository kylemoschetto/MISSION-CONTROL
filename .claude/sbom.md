# Software Bill of Materials (SBOM)

Purpose: Lists all approved technologies, libraries, and dependencies with their specific versions.

---

## 0. Technology Stack Overview

| Category | Component | Version | Rationale |
|----------|-----------|---------|-----------|
| Runtime | Node.js | 24.x LTS | EOL policy — always track current LTS |
| Server | Express | ^4.21.0 | Lightweight HTTP framework |
| File watching | Chokidar | ^3.6.0 | Cross-platform fs.watch wrapper |

---

## 1. Version Management & Updates

- **Update Strategy:** Track current Node.js LTS. Update dependencies via `npm update` with manual review.
- **Security Scanning:** `npm audit` before releases.

---

## 2. Documentation & Resources

- [Node.js LTS schedule](https://nodejs.org/en/about/releases/)
- [Express docs](https://expressjs.com/)
- [Chokidar docs](https://github.com/paulmillr/chokidar)
