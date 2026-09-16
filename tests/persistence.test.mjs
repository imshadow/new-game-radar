import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isActionable,
  stripDerivedBlocks,
  toDashboardCandidate,
  buildDashboardPayload,
  applyRetention,
  DASHBOARD_FIELDS,
} from '../lib/persistence.mjs';

function candidate(overrides = {}) {
  return {
    id: 'auto-1',
    gameName: 'Witchspire',
    normalizedName: 'witchspire',
    firstSeen: '2026-08-01T00:00:00Z',
    lastSeen: '2026-08-02T00:00:00Z',
    discoveryScore: 9,
    recommendation: 'pending',
    finalScore: 0,
    score: 0,
    sources: [{ name: 'itch.io New Feed', url: 'https://itch.io/games/x', kind: 'itch-new' }],
    seo: { modelVersion: 5, score: 70, reasons: ['ok'], exactResultUrls: ['https://a.example/x'], gameResultUrls: ['https://b.example/y'] },
    fast: { modelVersion: 3, score: 40, classification: 'watch', serpSnapshot: ['https://a.example/x'], suggestionSnapshot: ['witchspire wiki'] },
    trend: { modelVersion: 4, classification: 'rising', score: 60 },
    siteType: { modelVersion: 2, type: 'online', browserPlayable: true },
    marketFreshness: { modelVersion: 1, status: 'greenfield' },
    opportunity: { modelVersion: 3, score: 55, components: { socialSpread: 10 } },
    wikiPrelaunch: { modelVersion: 2, classification: 'watch' },
    social: { modelVersion: 3, classification: 'pending', providers: { youtube: { videoCount: 3 } } },
    ...overrides,
  };
}

test('keeps derived blocks for candidates that can still become an opportunity', () => {
  for (const recommendation of ['independent', 'test-now', 'page', 'watch']) {
    const c = candidate({ recommendation });
    stripDerivedBlocks(c);
    assert.ok(c.opportunity, `${recommendation} should keep opportunity`);
    assert.ok(c.marketFreshness, `${recommendation} should keep marketFreshness`);
    assert.equal(isActionable(c), true);
  }
});

test('drops recomputed derived blocks from non-actionable candidates', () => {
  for (const recommendation of ['pending', 'reject', 'error']) {
    const c = candidate({ recommendation });
    stripDerivedBlocks(c);
    assert.equal(c.opportunity, undefined, `${recommendation} should drop opportunity`);
    assert.equal(c.marketFreshness, undefined, `${recommendation} should drop marketFreshness`);
    assert.equal(c.wikiPrelaunch, undefined, `${recommendation} should drop wikiPrelaunch`);
    // siteType stays: it is cheap, is read by the dashboard, and routes channels.
    assert.ok(c.siteType, `${recommendation} should keep siteType`);
    // State that cannot be recomputed must survive.
    assert.ok(c.sources && c.seo && c.fast && c.trend && c.social);
  }
});

test('dashboard projection keeps exactly the fields the UI renders', () => {
  const slim = toDashboardCandidate(candidate());
  for (const field of Object.keys(slim)) {
    assert.ok(DASHBOARD_FIELDS.includes(field), `unexpected field on dashboard payload: ${field}`);
  }
  // Internal-only detail must not ship to the browser.
  assert.equal(slim.seo.exactResultUrls, undefined);
  assert.equal(slim.seo.gameResultUrls, undefined);
  assert.equal(slim.fast.serpSnapshot, undefined);
  assert.equal(slim.fast.suggestionSnapshot, undefined);
  assert.equal(slim.opportunity, undefined);
  assert.equal(slim.social, undefined);
  // Fields the UI does read must survive.
  assert.equal(slim.seo.score, 70);
  assert.equal(slim.fast.classification, 'watch');
  assert.equal(slim.trend.classification, 'rising');
  assert.equal(slim.siteType.type, 'online');
  assert.equal(slim.sources.length, 1);
});

test('dashboard payload excludes never-verified candidates and reports the omission', () => {
  const verified = candidate({ id: 'a', recommendation: 'watch', seo: { modelVersion: 5, provider: 'serper+autocomplete', score: 70 } });
  const rawNeverVerified = candidate({ id: 'b', recommendation: 'pending', seo: undefined, fast: undefined, trend: undefined, siteType: undefined });
  const payload = buildDashboardPayload([verified, rawNeverVerified]);

  assert.equal(payload.totalCandidates, 2);
  assert.equal(payload.shownCandidates, 1);
  assert.equal(payload.omittedCandidates, 1);
  assert.deepEqual(payload.candidates.map((c) => c.id), ['a']);
});

test('dashboard payload honours the maxCandidates cap while preserving order', () => {
  const list = Array.from({ length: 20 }, (_, i) => candidate({ id: `c${i}`, recommendation: 'watch' }));
  const payload = buildDashboardPayload(list, { maxCandidates: 5 });
  assert.equal(payload.candidates.length, 5);
  assert.equal(payload.shownCandidates, 5);
  assert.equal(payload.omittedCandidates, 15);
  assert.deepEqual(payload.candidates.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
});

// ------------------------------------------------------------- retention cap

const NOW = Date.parse('2026-09-15T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

test('retention never evicts a candidate discovered in the current run', () => {
  // Regression: the scan used to truncate the display-sorted array, and because
  // `pending` sorts last, a name discovered this run was discarded this run.
  const fresh = Array.from({ length: 40 }, (_, i) => candidate({
    id: `fresh${i}`,
    recommendation: 'pending',
    discoveryScore: 5,
    firstSeen: daysAgo(0),
    lastSeen: daysAgo(0),
  }));
  const stale = Array.from({ length: 40 }, (_, i) => candidate({
    id: `stale${i}`,
    recommendation: 'pending',
    discoveryScore: 12,
    firstSeen: daysAgo(90),
    lastSeen: daysAgo(60),
  }));

  const kept = applyRetention([...stale, ...fresh], NOW, 50);
  assert.equal(kept.length, 50);
  const keptIds = new Set(kept.map((c) => c.id));
  for (const c of fresh) assert.ok(keptIds.has(c.id), `${c.id} was discovered this run and must survive`);
  // The stale ones are evicted even though they score higher.
  assert.equal(kept.filter((c) => c.id.startsWith('stale')).length, 10);
});

test('retention evicts least-recently-seen first', () => {
  const list = Array.from({ length: 10 }, (_, i) => candidate({
    id: `old${i}`,
    recommendation: 'pending',
    firstSeen: daysAgo(100 + i),
    lastSeen: daysAgo(30 + i),
  }));
  const kept = applyRetention(list, NOW, 3);
  // Days 30/31/32 are the most recent, so they survive; 33+ are dropped.
  assert.deepEqual(kept.map((c) => c.id).sort(), ['old0', 'old1', 'old2']);
});

test('retention always keeps actionable candidates regardless of age', () => {
  const actionable = ['independent', 'test-now', 'page', 'watch'].map((recommendation, i) => candidate({
    id: `act${i}`,
    recommendation,
    firstSeen: daysAgo(200),
    lastSeen: daysAgo(180),
  }));
  const stale = Array.from({ length: 20 }, (_, i) => candidate({ id: `s${i}`, recommendation: 'pending', lastSeen: daysAgo(90 + i) }));
  const kept = applyRetention([...stale, ...actionable], NOW, 4);
  assert.equal(kept.length, 4);
  for (const c of actionable) assert.ok(kept.some((k) => k.id === c.id), `${c.id} is actionable and must survive`);
});

test('retention is a no-op below the cap', () => {
  const list = [candidate({ id: 'a' }), candidate({ id: 'b' })];
  assert.equal(applyRetention(list, NOW, 100).length, 2);
});
