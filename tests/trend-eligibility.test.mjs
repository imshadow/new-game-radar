import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_MODEL_VERSION } from '../lib/fast-signals.mjs';
import { SEO_MODEL_VERSION, TREND_MODEL_VERSION } from '../lib/model-versions.mjs';
import { hasCurrentSeo, isFastPassed, isTrendEligible, trendValidationSummary } from '../lib/trend-queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classifySource = await fs.readFile(path.join(root, 'scripts', 'classify-site-types.mjs'), 'utf8');

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    gameName: 'Test Game',
    seo: { modelVersion: SEO_MODEL_VERSION, classification: 'independent', score: 50, nameRisk: 5, entityConflict: false },
    fast: { modelVersion: FAST_MODEL_VERSION, classification: 'pass' },
    ...overrides,
  };
}

test('hasCurrentSeo only accepts the current SEO model version', () => {
  assert.equal(hasCurrentSeo(candidate()), true);
  assert.equal(hasCurrentSeo(candidate({ seo: { modelVersion: 'seo-v0', classification: 'independent', score: 50, nameRisk: 5 } })), false);
  assert.equal(hasCurrentSeo({}), false);
});

test('isFastPassed requires a current fast model version and a pass classification', () => {
  assert.equal(isFastPassed(candidate()), true);
  assert.equal(isFastPassed(candidate({ fast: { modelVersion: FAST_MODEL_VERSION, classification: 'watch' } })), false);
  assert.equal(isFastPassed(candidate({ fast: { modelVersion: 'fast-v0', classification: 'pass' } })), false);
});

test('isTrendEligible accepts a fully qualified candidate', () => {
  assert.equal(isTrendEligible(candidate()), true);
});

test('isTrendEligible rejects every candidate that may not spend Trends quota', () => {
  const rejected = {
    'no current seo': candidate({ seo: { modelVersion: 'seo-v0', classification: 'independent', score: 50, nameRisk: 5 } }),
    'seo classification is not independent or page': candidate({ seo: { modelVersion: SEO_MODEL_VERSION, classification: 'watch', score: 50, nameRisk: 5 } }),
    'seo score below 42': candidate({ seo: { modelVersion: SEO_MODEL_VERSION, classification: 'independent', score: 41, nameRisk: 5 } }),
    'name risk above 14': candidate({ seo: { modelVersion: SEO_MODEL_VERSION, classification: 'independent', score: 50, nameRisk: 15 } }),
    'entity conflict': candidate({ seo: { modelVersion: SEO_MODEL_VERSION, classification: 'independent', score: 50, nameRisk: 5, entityConflict: true } }),
    'fast did not pass': candidate({ fast: { modelVersion: FAST_MODEL_VERSION, classification: 'watch' } }),
    'missing seo block': candidate({ seo: undefined }),
  };
  for (const [reason, value] of Object.entries(rejected)) {
    assert.equal(isTrendEligible(value), false, reason);
  }
});

test('a missing nameRisk is treated as unknown and therefore rejected', () => {
  const value = candidate({ seo: { modelVersion: SEO_MODEL_VERSION, classification: 'independent', score: 50 } });
  assert.equal(isTrendEligible(value), false);
});

test('trendValidationSummary never reports more validated trends than eligible candidates', () => {
  const candidates = [
    candidate({ id: 'eligible-validated', trend: { modelVersion: TREND_MODEL_VERSION, classification: 'rising', provider: 'serpapi' } }),
    candidate({ id: 'eligible-pending', trend: { modelVersion: TREND_MODEL_VERSION, classification: 'pending', provider: 'serpapi' } }),
    candidate({ id: 'eligible-no-trend' }),
    candidate({
      id: 'ineligible-but-has-a-trend-verdict',
      seo: { modelVersion: SEO_MODEL_VERSION, classification: 'watch', score: 50, nameRisk: 5 },
      trend: { modelVersion: TREND_MODEL_VERSION, classification: 'rising', provider: 'serpapi' },
    }),
  ];
  const summary = trendValidationSummary(candidates);
  assert.equal(summary.eligibleCount, 3);
  assert.equal(summary.validatedCount, 1);
  assert.ok(summary.validatedCount <= summary.eligibleCount);
});

test('the eligibility filter is what keeps trendValidatedCount honest', () => {
  // This is the regression that produced `trendValidatedCount: 286` next to
  // `trendEligibleCount: 170`: a counter that dropped the eligibility filter
  // counted every candidate that merely carried a trend verdict.
  const ineligibleWithVerdict = candidate({
    seo: { modelVersion: SEO_MODEL_VERSION, classification: 'watch', score: 50, nameRisk: 5 },
    trend: { modelVersion: TREND_MODEL_VERSION, classification: 'rising', provider: 'serpapi' },
  });
  const withoutFilter = [ineligibleWithVerdict].filter((c) => c.trend?.modelVersion === TREND_MODEL_VERSION && !['pending', 'error'].includes(c.trend?.classification)).length;
  assert.equal(withoutFilter, 1);
  assert.equal(trendValidationSummary([ineligibleWithVerdict]).validatedCount, 0);
});

test('provider counts never exceed the validated count', () => {
  const candidates = [
    candidate({ id: 'a', trend: { modelVersion: TREND_MODEL_VERSION, classification: 'rising', provider: 'serpapi' } }),
    candidate({ id: 'b', trend: { modelVersion: TREND_MODEL_VERSION, classification: 'strong', provider: 'searchapi' } }),
    candidate({ id: 'c', trend: { modelVersion: TREND_MODEL_VERSION, classification: 'rising' } }),
    candidate({ id: 'd', trend: { modelVersion: TREND_MODEL_VERSION, classification: 'error', provider: 'serpapi' } }),
  ];
  const summary = trendValidationSummary(candidates);
  const providerTotal = Object.values(summary.providerCounts).reduce((sum, value) => sum + value, 0);
  assert.equal(summary.validatedCount, 3);
  assert.equal(providerTotal, 2);
  assert.ok(providerTotal <= summary.validatedCount);
});

test('trendValidationSummary tolerates an empty or missing candidate list', () => {
  assert.deepEqual(trendValidationSummary(), { eligibleCount: 0, validatedCount: 0, providerCounts: {} });
  assert.deepEqual(trendValidationSummary([]), { eligibleCount: 0, validatedCount: 0, providerCounts: {} });
});

/**
 * `classify-site-types.mjs` runs *after* the trend fillers, so whatever it
 * writes is what the report ends up with. It used to keep its own provider
 * counter — no eligibility filter, no modelVersion check — which is how
 * `serpapi: 286` ended up beside `trendValidatedCount: 120`. Consolidating only
 * the fillers left this second writer in place.
 */
test('classify-site-types takes the trend counters from the shared summary, not its own filter', () => {
  assert.match(
    classifySource,
    /trendValidationSummary\s*\}\s*from\s*'\.\.\/lib\/trend-queue\.mjs'/,
    'classify must import the shared trend summary',
  );
  assert.match(classifySource, /trendValidationSummary\(candidates\)/);
  assert.doesNotMatch(
    classifySource,
    /trendProviderCounts\[trendProvider\]/,
    'classify must not count providers with a local, looser filter',
  );
  assert.doesNotMatch(
    classifySource,
    /const trendProviderCounts = \{\}/,
    'classify must not build its own provider map',
  );
});

test('the reported trendProvider reflects configuration, not historical counts', () => {
  // The inherited corpus still carries `provider: 'serpapi'` from upstream, so
  // deriving the active provider from the counts advertised a live integration
  // while serpApiConfigured was false.
  assert.doesNotMatch(
    classifySource,
    /Object\.keys\(trendProviderCounts\)/,
    'a historical count must not decide which provider is active',
  );
  assert.match(classifySource, /const configuredTrendProviders = \[/);
  assert.match(classifySource, /process\.env\.SEARCHAPI_API_KEY \? 'searchapi' : null/);
});
