import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isProvisionalSeo,
  needsSeo,
  reverifyDays,
  reverifyDemand,
  reverifyWindowMs,
  sustainablePoolSize,
} from '../lib/seo-freshness.mjs';
import { SEO_MODEL_VERSION } from '../lib/trend-queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const NOW = Date.parse('2026-09-17T00:00:00.000Z');

/** A candidate whose SEO verdict was written `daysAgo` days before NOW. */
function verified(classification, daysAgo, extra = {}) {
  return {
    gameName: 'Sample Game',
    seo: {
      modelVersion: SEO_MODEL_VERSION,
      provider: 'serper+autocomplete',
      classification,
      checkedAt: new Date(NOW - daysAgo * DAY).toISOString(),
      ...extra,
    },
  };
}

// ---------------------------------------------------------------- the ceiling

/**
 * The whole point of this module. The old rule was a single global `3 * DAY`,
 * so the sustainable verified pool was `dailyBudget * 3` = 240 words at
 * 80 requests/day — smaller than the backlog, which means the scanner could
 * never catch up no matter how long it ran.
 */
test('a stable page verdict is not re-bought every three days', () => {
  assert.equal(needsSeo(verified('page', 5), process.env, NOW), false);
  assert.equal(needsSeo(verified('page', 13), process.env, NOW), false);
  assert.equal(needsSeo(verified('page', 15), process.env, NOW), true);
});

test('a watch verdict is tracked more closely than a page verdict', () => {
  assert.equal(needsSeo(verified('watch', 5), process.env, NOW), false);
  assert.equal(needsSeo(verified('watch', 8), process.env, NOW), true);
  // Same age, different classification: the distinction is the entire feature.
  assert.equal(needsSeo(verified('page', 8), process.env, NOW), false);
});

test('a rejected verdict is not re-bought for a month', () => {
  assert.equal(needsSeo(verified('reject', 20), process.env, NOW), false);
  assert.equal(needsSeo(verified('reject', 31), process.env, NOW), true);
});

test('an unknown classification keeps the old conservative three-day window', () => {
  assert.equal(needsSeo(verified('mystery', 2), process.env, NOW), false);
  assert.equal(needsSeo(verified('mystery', 4), process.env, NOW), true);
  assert.equal(reverifyWindowMs('mystery', process.env), 3 * DAY);
});

test('the ceiling is budget times window, and the new windows clear the backlog', () => {
  assert.equal(sustainablePoolSize(80, 3), 240);
  assert.equal(sustainablePoolSize(80, 14), 1120);
  assert.equal(sustainablePoolSize(400, 14), 5600);
});

// ------------------------------------------------- provisional verdicts

/**
 * scripts/verify-evidence-fallback.mjs writes classification 'page' with
 * provider 'evidence-fallback' and provisional true, and says in its own
 * reasons: "Serper额度不足，当前为平台证据临时验证，仍需后续SERP复核".
 * The old needsSeo() read that as "done" — so the promise was never kept and
 * the words stayed on the dashboard looking verified.
 */
test('a provisional verdict is never treated as verified', () => {
  const fallback = {
    gameName: 'Sample Game',
    seo: {
      modelVersion: SEO_MODEL_VERSION,
      provider: 'evidence-fallback',
      classification: 'page',
      checkedAt: new Date(NOW).toISOString(),
      provisional: true,
    },
  };
  assert.equal(needsSeo(fallback, process.env, NOW), true, 'evidence-fallback must stay in the queue');
  assert.equal(isProvisionalSeo(fallback.seo), true);
});

test('a provisional flag alone is enough, even under the serper provider', () => {
  const flagged = verified('page', 0, { provisional: true });
  assert.equal(needsSeo(flagged, process.env, NOW), true);
});

test('a real verdict is not mistaken for a provisional one', () => {
  assert.equal(isProvisionalSeo(verified('page', 0).seo), false);
  assert.equal(isProvisionalSeo(undefined), false);
  assert.equal(isProvisionalSeo({}), false);
});

// ------------------------------------------------- other pending paths

test('a verdict from an older model version is always redone', () => {
  const stale = verified('page', 1);
  stale.seo.modelVersion = SEO_MODEL_VERSION - 1;
  assert.equal(needsSeo(stale, process.env, NOW), true);
});

test('legacy providers and pending verdicts stay in the queue', () => {
  const legacy = (provider) => ({
    gameName: 'Sample Game',
    seo: { modelVersion: SEO_MODEL_VERSION, provider, classification: 'page', checkedAt: new Date(NOW).toISOString() },
  });
  for (const provider of ['duckduckgo+autocomplete', 'brave+autocomplete', 'google-cse-abc']) {
    assert.equal(needsSeo(legacy(provider), process.env, NOW), true, provider);
  }
  const pending = verified('pending', 0);
  assert.equal(needsSeo(pending, process.env, NOW), true);
  const unreadable = verified('page', 1, { checkedAt: 'not a date' });
  assert.equal(needsSeo(unreadable, process.env, NOW), true);
});

test('a candidate with no SEO block at all needs SEO', () => {
  assert.equal(needsSeo({ gameName: 'Sample Game' }, process.env, NOW), true);
  assert.equal(needsSeo({}, process.env, NOW), true);
});

// ------------------------------------------------- tuning without a deploy

/**
 * Every push to main costs two Vercel deployments, so retuning the freshness
 * policy must not require a code change.
 */
test('the windows are tunable from the environment', () => {
  const env = { ...process.env, SERPER_REVERIFY_DAYS_PAGE: '30', SERPER_REVERIFY_DAYS_WATCH: '1' };
  assert.equal(reverifyDays(env).page, 30);
  assert.equal(reverifyDays(env).watch, 1);
  assert.equal(needsSeo(verified('page', 20), env, NOW), false);
  assert.equal(needsSeo(verified('watch', 2), env, NOW), true);
});

test('a nonsense window falls back instead of poisoning the queue', () => {
  const env = { ...process.env, SERPER_REVERIFY_DAYS_PAGE: 'soon', SERPER_REVERIFY_DAYS_WATCH: '-5' };
  assert.equal(reverifyDays(env).page, 14);
  assert.equal(reverifyDays(env).watch, 7);
});

test('zero means always due, which is how pending and error behave', () => {
  assert.equal(reverifyWindowMs('pending', process.env), 0);
  assert.equal(reverifyWindowMs('error', process.env), 0);
  assert.equal(needsSeo(verified('error', 0), process.env, NOW + 1), true);
});

test('a verdict with no conclusion is redone even if it was just written', () => {
  // Regression: `now - checked > 0` is false at zero elapsed time, so a
  // freshly-stamped verdict with no conclusion used to read as complete.
  assert.equal(needsSeo(verified('pending', 0), process.env, NOW), true);
  assert.equal(needsSeo(verified('error', 0), process.env, NOW), true);
});

// ------------------------------------------------- the arithmetic

test('reverify demand is the number that answers "is 80/day enough"', () => {
  // The measured population on 2026-09-17, under the old global 3-day rule.
  const population = { page: 175, watch: 93, reject: 44, independent: 36 };
  assert.equal(reverifyDemand(population, process.env).toFixed(1), '29.8');
  // The old rule charged every one of those 348 words every three days.
  const legacyDemand = Object.values(population).reduce((sum, n) => sum + n, 0) / 3;
  assert.equal(legacyDemand.toFixed(1), '116.0');
  assert.ok(legacyDemand > 80, 'the old rule spent more than the entire daily budget on re-verification alone');
  assert.ok(reverifyDemand(population, process.env) < 80, 'the new rule leaves budget for new candidates');
});

test('reverify demand counts an unknown classification at the fallback window', () => {
  assert.equal(reverifyDemand({ mystery: 30 }, process.env), 10);
  assert.equal(reverifyDemand({ mystery: 0 }, process.env), 0);
  assert.equal(reverifyDemand({}, process.env), 0);
});

// ------------------------------------------------- single-declaration guards

/**
 * Same discipline as the source-registry guard: this rule had two copies with
 * different defaults (scan.mjs assumed 3, report-health.mjs assumed 0), and the
 * mismatch made a working configuration report as broken. One rule, one place.
 */
test('verify-serper.mjs delegates the freshness rule instead of restating it', async () => {
  const source = await fs.readFile(path.join(root, 'scripts', 'verify-serper.mjs'), 'utf8');
  assert.ok(
    /import\s*\{[^}]*needsSeo[^}]*\}\s*from\s*'\.\.\/lib\/seo-freshness\.mjs'/.test(source),
    'scripts/verify-serper.mjs must import needsSeo from lib/seo-freshness.mjs',
  );
  assert.ok(
    !/>\s*3\s*\*\s*DAY/.test(source),
    'the global three-day window must not come back; it capped the verified pool at 240 words',
  );
});

test('the queue lane budget is derived from what this run can actually spend', async () => {
  const source = await fs.readFile(path.join(root, 'scripts', 'verify-serper.mjs'), 'utf8');
  assert.ok(
    /function balancedQueue\(candidates,\s*limit\s*=\s*VERIFY_LIMIT\)/.test(source),
    'balancedQueue must accept the effective per-run budget',
  );
  assert.ok(
    /laneCaps\s*=\s*\{[\s\S]*?budget\s*\*\s*0\.60[\s\S]*?budget\s*\*\s*0\.20/.test(source),
    'lane caps must be computed from the run budget, not from the static VERIFY_LIMIT',
  );
  assert.ok(
    /runLimit\s*=\s*Math\.min\(VERIFY_LIMIT,\s*dailyRemaining\)/.test(source),
    'the run budget must be clamped by the remaining daily quota',
  );
});
