import fs from 'node:fs/promises';

/**
 * Candidate persistence helpers.
 *
 * Why this exists: `data/candidates.json` is committed by the scan workflow
 * roughly every 30 minutes and is also fetched by the dashboard. It had grown
 * to ~18 MB, and most of that weight was pure recomputed-byproduct:
 *
 *   - `opportunity` / `social` / `marketFreshness` / `wikiPrelaunch` are derived
 *     values. They are pure functions of `sources`, `seo`, `trend`, `youtube`
 *     and `social`, and `npm run classify` recomputes all of them before any
 *     decision is made. Persisting them for candidates that are not actionable
 *     stored megabytes of placeholders (`siteType.type: 'pending'`,
 *     `social.classification: 'pending'`, ...) that were thrown away and
 *     recomputed on the next run.
 *   - The dashboard never reads `opportunity`, `social`, `marketFreshness` or
 *     `wikiPrelaunch` at all, yet downloaded and parsed them every 5 minutes.
 *
 * Two outputs are now written:
 *   - `data/candidates.json`  full internal state, minified
 *   - `data/dashboard.json`   slim, UI-only projection
 */

/** Recommendations whose derived blocks are meaningful and worth persisting. */
const ACTIONABLE_RECOMMENDATIONS = new Set(['independent', 'test-now', 'page', 'watch']);

/** Derived blocks that `applyFinalRecommendation` recomputes from scratch. */
const DERIVED_BLOCKS = ['opportunity', 'marketFreshness', 'wikiPrelaunch'];

/** Top-level fields the dashboard actually renders. */
const DASHBOARD_FIELDS = [
  'id', 'gameName', 'normalizedName', 'firstSeen', 'lastSeen', 'discoveryScore',
  'recommendation', 'level', 'finalScore', 'score', 'status',
  'sources', 'siteType', 'seo', 'fast', 'trend', 'youtube',
];

export function isActionable(candidate = {}) {
  return ACTIONABLE_RECOMMENDATIONS.has(candidate.recommendation || 'pending');
}

/**
 * Drop recomputed-byproduct blocks from candidates that will never be shown as
 * an opportunity. `siteType` is kept because it is cheap, is read by the
 * dashboard, and doubles as the channel router for the next run.
 */
export function stripDerivedBlocks(candidate) {
  if (isActionable(candidate)) return candidate;
  for (const block of DERIVED_BLOCKS) delete candidate[block];
  return candidate;
}

/** Project a candidate down to the fields the dashboard renders. */
export function toDashboardCandidate(candidate = {}) {
  const out = {};
  for (const field of DASHBOARD_FIELDS) {
    if (candidate[field] !== undefined) out[field] = candidate[field];
  }
  // Result URL lists are only used internally for market-freshness analysis.
  if (out.seo) {
    const { exactResultUrls, gameResultUrls, ...rest } = out.seo;
    out.seo = rest;
  }
  // Snapshot baselines are only used internally for new-vs-seen delta counting.
  if (out.fast) {
    const { serpSnapshot, suggestionSnapshot, ...rest } = out.fast;
    out.fast = rest;
  }
  return out;
}

/** Cap on how many candidates the dashboard payload carries. */
export const DASHBOARD_MAX_CANDIDATES = Math.max(1, Number(process.env.DASHBOARD_MAX_CANDIDATES || 800));

/**
 * Should this candidate appear on the dashboard at all?
 *
 * The dashboard is an opportunity board, not a dump of every name the scanner
 * has ever seen. Most discovered names are never verified (SEO quota is the
 * bottleneck), so shipping them meant the browser downloaded and parsed
 * thousands of rows that render as blank placeholders. A candidate earns a slot
 * once it has actually been through a verification pass.
 */
export function worthShowing(candidate = {}) {
  return isActionable(candidate)
    || Boolean(candidate.seo?.provider)
    || Boolean(candidate.trend?.checkedAt)
    || Boolean(candidate.fast?.checkedAt);
}

export function buildDashboardPayload(candidates, options = {}) {
  const { maxCandidates = DASHBOARD_MAX_CANDIDATES, ...extra } = options;
  // Callers pass candidates pre-sorted by relevance, so a plain slice keeps the
  // highest-value rows when the cap bites.
  const shown = candidates.filter(worthShowing).slice(0, maxCandidates);
  return {
    ...extra,
    // Prefer the caller's scan timestamp: a wall-clock read here made classify
    // non-idempotent (see scripts/classify-site-types.mjs).
    generatedAt: extra.scannedAt || new Date().toISOString(),
    totalCandidates: candidates.length,
    shownCandidates: shown.length,
    omittedCandidates: candidates.length - shown.length,
    candidates: shown.map(toDashboardCandidate),
  };
}

/**
 * Write JSON without the 2-space pretty-printing the scan used to apply.
 * Indentation alone accounted for ~35% of the on-disk size, and this file is
 * machine-generated and machine-read, so the diff-friendliness is not worth it.
 */
export async function writeJsonCompact(file, data) {
  await fs.writeFile(file, JSON.stringify(data) + '\n');
}

/** Hard ceiling on how many candidates are persisted. */
export const MAX_CANDIDATES = Math.max(100, Number(process.env.MAX_CANDIDATES || 3000));

/**
 * How long a candidate is protected from eviction purely for having been seen.
 * Must comfortably exceed the time the verify queue needs to reach a name.
 */
export const RETENTION_GRACE_DAYS = Math.max(1, Number(process.env.RETENTION_GRACE_DAYS || 14));

/**
 * Bound the candidate pool — without silently throwing away what was just found.
 *
 * The scan used to sort by recommendation, then do `if (length > 3000) length =
 * 3000`. Because the display sort ranks actionable candidates first and
 * `pending` ones last, that cut always landed on the newest discoveries: a name
 * could be discovered and discarded in the same run, then re-discovered and
 * discarded again on the next one, forever. Two consequences, both silent:
 *
 *   - `firstSeen` kept resetting, so a name that had been sitting in the queue
 *     for weeks still looked brand new to the recency scoring in
 *     `opportunity-finalizer` and `verifyPriority`.
 *   - Every name below the cut line was permanently excluded from verification,
 *     because the cut line is determined by score and the score never changes.
 *
 * Retention is now an explicit policy, separate from presentation order:
 *   1. Actionable candidates are always kept.
 *   2. Anything seen inside the grace window is kept — it has not had a fair
 *      chance to be verified yet, so evicting it would just re-discover it.
 *   3. The rest is evicted least-recently-seen first. A candidate that has
 *      stopped appearing in any source is the safest thing to forget.
 *
 * Presentation order is the caller's business; this only decides membership.
 */
export function applyRetention(candidates, nowMs = Date.now(), max = MAX_CANDIDATES) {
  if (candidates.length <= max) return candidates;

  const graceMs = RETENTION_GRACE_DAYS * 86400000;
  const kept = [];
  const evictable = [];
  for (const candidate of candidates) {
    const lastSeen = Date.parse(candidate.lastSeen || '') || 0;
    const fresh = lastSeen > 0 && nowMs - lastSeen <= graceMs;
    if (isActionable(candidate) || fresh) kept.push(candidate);
    else evictable.push(candidate);
  }

  // Pathological case: even the protected set overflows. Keep the strongest of
  // them rather than the arbitrary subset the display sort happened to leave.
  if (kept.length >= max) {
    kept.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0)
      || (b.discoveryScore || 0) - (a.discoveryScore || 0)
      || (Date.parse(b.lastSeen || '') || 0) - (Date.parse(a.lastSeen || '') || 0));
    return kept.slice(0, max);
  }

  evictable.sort((a, b) => (Date.parse(b.lastSeen || '') || 0) - (Date.parse(a.lastSeen || '') || 0));
  return kept.concat(evictable.slice(0, max - kept.length));
}

export { ACTIONABLE_RECOMMENDATIONS, DERIVED_BLOCKS, DASHBOARD_FIELDS };
