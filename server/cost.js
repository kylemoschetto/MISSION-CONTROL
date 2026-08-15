const config = require('./config');

/**
 * Calculate cost for a single assistant message's usage object
 */
function calculateMessageCost(usage, model, timestampMs) {
  if (!usage) return 0;
  const pricing = require('./pricing').getPricing(model, timestampMs);
  const perMillion = 1_000_000;

  const inputCost = ((usage.input_tokens || 0) / perMillion) * pricing.input;
  const outputCost = ((usage.output_tokens || 0) / perMillion) * pricing.output;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / perMillion) * pricing.cacheRead;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / perMillion) * pricing.cacheWrite;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Calculate time saved based on session duration and configured multiplier
 */
function calculateTimeSaved(durationMs) {
  const cfg = config.get();
  const multiplier = cfg.timeSaved.multiplier;
  const estimatedManualMs = durationMs * multiplier;
  return {
    sessionDurationMs: durationMs,
    estimatedManualMs,
    timeSavedMs: estimatedManualMs - durationMs,
    multiplier
  };
}

module.exports = { calculateMessageCost, calculateTimeSaved };
