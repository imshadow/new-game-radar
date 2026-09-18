import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_MODEL_VERSION } from '../lib/fast-signals.mjs';
import { SEO_MODEL_VERSION, TREND_MODEL_VERSION } from '../lib/model-versions.mjs';
import { activeTrendProviderLabel, enabledTrendProviders, hasCurrentSeo, isFastPassed, isFreeTrendPathEnabled, isNameOnlySourced, isTrendEligible, trendValidationSummary } from '../lib/trend-queue.mjs';
import { POLICY_SETS } from '../lib/source-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classifySource = await fs.readFile(path.join(root, 'scripts', 'classify-site-types.mjs'), 'utf8');
const scanSource = await fs.readFile(path.join(root, 'scripts', 'scan.mjs'), 'utf8');
const registrySource = await fs.readFile(path.join(root, 'lib', 'source-registry.mjs'), 'utf8');
const trendQueueSource = await fs.readFile(path.join(root, 'lib', 'trend-queue.mjs'), 'utf8');

// Every script that writes the trend block of the report. They all have to agree,
// because whichever one runs last is the one the report ends up showing.
const TREND_REPORT_WRITERS = [
  'scripts/classify-site-types.mjs',
  'scripts/fill-searchapi-trends.mjs',
  'scripts/fill-apify-trends.mjs',
  'scripts/fill-serpapi-pool.mjs',
  'scripts/fill-serpapi-quota.mjs',
];
const writerSources = new Map();
for (const file of TREND_REPORT_WRITERS) {
  writerSources.set(file, await fs.readFile(path.join(root, file), 'utf8'));
}

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

test('the reported trendProvider reflects what is enabled, not historical counts', () => {
  // The inherited corpus still carries `provider: 'serpapi'` from upstream, so
  // deriving the active provider from the counts advertised a live integration
  // while serpApiConfigured was false. Four separate scripts did this; the guard
  // covers all of them, because each one is a chance for the bug to come back.
  for (const [file, source] of writerSources) {
    assert.doesNotMatch(
      source,
      /Object\.keys\(trendProviderCounts\)/,
      `${file}: a historical count must not decide which provider is active`,
    );
    assert.doesNotMatch(
      source,
      /trendProvider:\s*activeProviders/,
      `${file}: a historical count must not decide which provider is active`,
    );
    if (/trendProvider\s*:/.test(source)) {
      assert.match(source, /activeTrendProviderLabel\(\)/, `${file}: must use the shared label helper`);
    }
  }
});

test('no script keeps its own trend counter filter', () => {
  // Three scripts each carried a private copy of this filter, with three
  // different predicates. Anything that counts this population must call the
  // shared summary instead.
  for (const [file, source] of writerSources) {
    assert.doesNotMatch(
      source,
      /function providerCounts\s*\(/,
      `${file}: must not define its own provider counter`,
    );
    assert.doesNotMatch(
      source,
      /candidates\.filter\(\(candidate\)\s*=>\s*candidate\.trend\?\.modelVersion/,
      `${file}: must not count validated trends with a local filter`,
    );
  }
});

test('enabledTrendProviders reports only the sources that are switched on', () => {
  assert.deepEqual(enabledTrendProviders({ TRENDS_VERIFY_LIMIT: '0' }), []);
  assert.deepEqual(enabledTrendProviders({ SERPAPI_API_KEY: 'k', TRENDS_VERIFY_LIMIT: '0' }), ['serpapi']);
  assert.deepEqual(enabledTrendProviders({ SEARCHAPI_API_KEY: 'k', TRENDS_VERIFY_LIMIT: '0' }), ['searchapi']);
  assert.deepEqual(enabledTrendProviders({ APIFY_API_TOKEN: 'k', TRENDS_VERIFY_LIMIT: '0' }), ['apify-data-xplorer']);
  assert.deepEqual(
    enabledTrendProviders({ SERPAPI_API_KEY: 'k', SEARCHAPI_API_KEY: 'k', TRENDS_VERIFY_LIMIT: '0' }),
    ['serpapi', 'searchapi'],
  );
});

test('the free Trends path is gated on the limit, and defaults the same way scan.mjs does', () => {
  assert.equal(isFreeTrendPathEnabled({ TRENDS_VERIFY_LIMIT: '0' }), false);
  assert.equal(isFreeTrendPathEnabled({ TRENDS_VERIFY_LIMIT: '3' }), true);
  // scan.mjs reads an unset TRENDS_VERIFY_LIMIT as 3, so the free path is on.
  // report-health.mjs used to read the same variable as 0 — that disagreement is
  // what this test locks down.
  assert.equal(isFreeTrendPathEnabled({}), true);
  assert.equal(isFreeTrendPathEnabled({ TRENDS_VERIFY_LIMIT: 'not-a-number' }), false);
});

test('activeTrendProviderLabel is null when nothing is enabled', () => {
  assert.equal(activeTrendProviderLabel({ TRENDS_VERIFY_LIMIT: '0' }), null);
  assert.equal(activeTrendProviderLabel({ SERPAPI_API_KEY: 'k', TRENDS_VERIFY_LIMIT: '0' }), 'serpapi');
  assert.equal(activeTrendProviderLabel({}), 'google-trends-api');
});

/**
 * 「只由一个只提供名字的源带来的候选，不许花额度」。
 *
 * 这条规则本来就存在，只是写在别处：`lib/source-registry.mjs` 早就把
 * `trends-rising-7d` / `trends-rising-30d` 标成 `evidence: false`（单独出现不足以
 * 断言 channel）。而真正在跑的判定是 `scripts/scan.mjs` 的 `shouldAutoVerify`，
 * 它把这两个 kind 列成**花额度的理由**，还在 `verifyPriority` 里给它们 +35 / +25
 * —— 全函数最大的两笔加分。一个规则两套定义，执行的那套更粗糙。
 *
 * 实测 2026-09-18（池子 1893）：只由这两个 kind 带来的候选 137 个，其中 133 个排在
 * SEO 队列里（107 个一次都没验过），抢的是真游戏名字同一份 240 次/天的 Serper 额度。
 */
test('isNameOnlySourced only fires when every source is a name-only source', () => {
  const withSources = (...kinds) => candidate({
    sources: kinds.map((kind) => ({ kind, sourceId: kind, url: `https://example.com/${kind}` })),
  });
  assert.equal(isNameOnlySourced(withSources('trends-rising-7d')), true);
  assert.equal(isNameOnlySourced(withSources('trends-rising-7d', 'trends-rising-30d')), true);

  // 只要还有任何一个真游戏目录带了它，就照常验证。这是这个 gate 能安全上线的原因：
  // 两个当前产出 `page` 的词都不是 name-only（`dear passengers` 有
  // steam-top-wishlist + steam-upcoming，`Endacopia` 有 steam-popular-new + itch-new）。
  assert.equal(isNameOnlySourced(withSources('trends-rising-7d', 'steam-top-wishlist')), false);
  assert.equal(isNameOnlySourced(withSources('trends-rising-30d', 'steam-popular-new')), false);

  // 没有来源 ≠ name-only。那是「还没采到」，不是「采到了但没意义」。
  assert.equal(isNameOnlySourced(candidate()), false);
  assert.equal(isNameOnlySourced({ sources: [] }), false);

  // `hn-showhn` 故意不在集合里：Show HN 可以真的是一个游戏发布，而它多带来 29 条
  // 队列项、对产出零代价 —— 那是另一个判断题，不属于这个缺陷。
  assert.equal(isNameOnlySourced(withSources('hn-showhn')), false);
  // `evidence: false` 也不是正确的边界：它包含 itch-featured（真信号，值 +16）。
  assert.equal(isNameOnlySourced(withSources('itch-featured')), false);
});

test('isTrendEligible refuses a name-only candidate that otherwise qualifies', () => {
  assert.equal(isTrendEligible(candidate()), true);
  const nameOnly = candidate({ sources: [{ kind: 'trends-rising-7d', sourceId: 'trends-rising-7d' }] });
  assert.equal(isTrendEligible(nameOnly), false);
  // 同样的候选，只要多一个真目录来源就恢复合格。
  const rescued = candidate({
    sources: [
      { kind: 'trends-rising-7d', sourceId: 'trends-rising-7d' },
      { kind: 'steam-upcoming', sourceId: 'steam-upcoming' },
    ],
  });
  assert.equal(isTrendEligible(rescued), true);
});

test('the name-only set is declared once, in the registry', () => {
  assert.deepEqual([...POLICY_SETS.NAME_ONLY_KINDS].sort(), ['trends-rising-30d', 'trends-rising-7d']);
  assert.match(registrySource, /NAME_ONLY_KINDS:\s*\[/, 'registry must declare the set');
  assert.match(
    trendQueueSource,
    /const NAME_ONLY_KINDS = POLICY_SETS\.NAME_ONLY_KINDS;/,
    'the consumer must read the registry set, not re-list the two kinds',
  );
  assert.doesNotMatch(
    trendQueueSource,
    /const NAME_ONLY_KINDS = \[/,
    'a second array literal here would be a second definition',
  );
});

test('both quota queues consume the one name-only definition', () => {
  // 取函数体而不是全文匹配，避免注释里的示例把断言喂饱。
  const bodyOf = (source, header) => {
    const start = source.indexOf(header);
    assert.notEqual(start, -1, `找不到 ${header}`);
    return source.slice(start, source.indexOf('\n}', start));
  };

  // 趋势额度：由 isTrendEligible 消费，五个 trendEligibleCount 写者全部从它派生。
  // 行为断言在上面两个用例里；这里锁住它没有被挪回 scan.mjs。
  assert.match(
    bodyOf(trendQueueSource, 'export function isTrendEligible(candidate)'),
    /if \(isNameOnlySourced\(candidate\)\) return false;/,
    'the trend quota gate must live in isTrendEligible',
  );

  // SEO 额度：scan.mjs 的 shouldAutoVerify。它必须调用共享判定，而不是自己再写一遍
  // 「kinds 里有没有 trends-rising」—— 那正是这个 bug 的来源。
  assert.match(scanSource, /isNameOnlySourced/, 'scan.mjs must import the shared predicate');
  assert.match(
    bodyOf(scanSource, 'function shouldAutoVerify(candidate)'),
    /if\(isNameOnlySourced\(candidate\)\)return false;/,
    'the SEO queue must apply the gate before its own kind bonuses',
  );
});
