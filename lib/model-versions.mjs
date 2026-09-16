/**
 * Single source of truth for every persisted model version.
 *
 * These numbers are stored inside `data/candidates.json` and are used as cache
 * keys: bumping one forces re-verification of the affected block. Because they
 * are cache keys, they must never be duplicated — a value that drifts between
 * two files silently disables re-verification instead of failing loudly.
 *
 * Historical duplication this module removes:
 *   - TREND_MODEL_VERSION was declared in both trend-queue.mjs and trend-verifier.mjs
 *   - SEO_MODEL_VERSION was exported from trend-queue.mjs but hardcoded as the
 *     literal `5` in market-freshness.mjs, opportunity-finalizer.mjs and
 *     verify-social-buzz.mjs, so bumping the constant would NOT have invalidated
 *     SEO results the way the rest of the code assumes.
 *
 * Each module re-exports its own constant so existing import sites keep working.
 */

export const SEO_MODEL_VERSION = 5;
export const TREND_MODEL_VERSION = 4;
export const TREND_PROFILE_VERSION = 2;
export const FAST_MODEL_VERSION = 3;
export const SITE_TYPE_MODEL_VERSION = 2;
export const SOCIAL_MODEL_VERSION = 3;
export const OPPORTUNITY_MODEL_VERSION = 3;
export const WIKI_PRELAUNCH_MODEL_VERSION = 2;
export const MARKET_FRESHNESS_MODEL_VERSION = 1;
