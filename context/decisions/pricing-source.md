# Pricing Source: LiteLLM Fetch with Dated Local History

**Date:** 2026-08-13
**Status:** Accepted

## Decision

Replace the hardcoded per-model `pricing` block in `config.json` as the primary
cost source. A pricing service (`server/pricing.js`) fetches LiteLLM's
community-maintained `model_prices_and_context_window.json` on server startup
(plus an opportunistic 24h refresh while running), and appends a dated entry to
a local `pricing-history.json` whenever prices change. Cost calculation resolves
the price in force on the *session's date*, not today's price. The history file
ships seeded with known current and prior-generation Anthropic rates so
pre-existing sessions price sensibly. `config.json` pricing remains as an
optional override only.

## Rationale

- Joe wants off hardcoded pricing config; Anthropic offers no pricing API
  (the Models API returns capabilities, not prices), so a community source is
  the only live option.
- Dated history fixes an existing correctness bug: costs were computed as
  `tokens × current price`, silently repricing history whenever config changed
  (concretely wrong for Sonnet 5's intro pricing ending 2026-08-31).
- Rejected: scraping Anthropic's docs pricing page (fragile); a dedicated
  daily-cron poller project (over-engineering — startup fetch suffices; a price
  change during downtime is recorded effective at next startup, an accepted
  small misattribution window).
- Known trade-offs: LiteLLM is third-party data that can lag a launch by a day
  or two; its model keys need a mapping layer; per-token units need converting
  to per-MTok; history accuracy accrues only from first fetch (seed approximates
  earlier).
