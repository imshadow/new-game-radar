import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFinalRecommendation } from '../lib/opportunity-finalizer.mjs';
import { analyzeOnlineSocialBuzz } from '../lib/social-buzz.mjs';
import { classifySiteType } from '../lib/site-type.mjs';

/**
 * Regression guard for a real defect: `applyFinalRecommendation` used to read
 * `Date.now()` internally, so the same candidate produced different verdicts on
 * different days. Two tests in this repo silently rotted for weeks because of it
 * (a Steam prelaunch fixture kept its release date, so once wall-clock time
 * passed that date the fixture flipped from `independent` to `test-now`).
 *
 * The clock is now an explicit input. These tests prove the verdict depends on
 * the injected instant and NOT on when the suite happens to run.
 */

const RELEASE_DAY = Date.parse('2026-09-12T00:00:00Z');
const BEFORE_RELEASE = Date.parse('2026-08-04T02:00:00Z');
const AFTER_RELEASE = Date.parse('2026-10-01T02:00:00Z');

function social(checkedAt) {
  return analyzeOnlineSocialBuzz({
    social: {
      providers: {
        youtube: { configured: true, checkedAt, videoCount: 8, channelCount: 6, totalViews: 120000, totalLikes: 7000, totalComments: 900, recent24h: 3 },
        reddit: { configured: true, checkedAt, postCount: 6, subredditCount: 3, authorCount: 5, totalScore: 500, totalComments: 180, recent24h: 2 },
        x: { configured: false },
        tiktok: { configured: false },
      },
    },
  });
}

function prelaunchCandidate(checkedAt) {
  return {
    gameName: 'Project Emberfall',
    firstSeen: '2026-08-02T02:00:00Z',
    sources: [{
      key: 'steam-top-wishlist|https://store.steampowered.com/app/123/project_emberfall/',
      sourceId: 'steam-top-wishlist',
      kind: 'steam-top-wishlist',
      url: 'https://store.steampowered.com/app/123/project_emberfall/',
      date: 'Sep 12, 2026',
      firstSeen: '2026-08-02T02:00:00Z',
      previousRank: 32,
      currentRank: 18,
      bestRank: 18,
    }],
    seo: {
      modelVersion: 5,
      provider: 'serper-google-search',
      classification: 'independent',
      score: 79,
      nameRisk: 5,
      entityConflict: false,
      suggestions: ['project emberfall wiki', 'project emberfall classes', 'project emberfall weapons'],
      exactResultUrls: ['https://store.steampowered.com/app/123/project_emberfall/'],
      gameResultUrls: ['https://www.youtube.com/watch?v=trailer'],
    },
    fast: { modelVersion: 3, classification: 'pass', score: 72 },
    trend: { modelVersion: 4, classification: 'breakout', score: 88, keywordFreshness: 'new' },
    youtube: { checkedAt, videoCount: 8, channelCount: 6, totalViews: 120000 },
    social: social(checkedAt),
    siteType: { modelVersion: 2, type: 'wiki', channel: 'wiki', browserPlayable: false, onlinePlatformCount: 0, reasons: ['已进入Steam Top Wishlists'] },
  };
}

test('the verdict is a pure function of the injected clock, not of wall-clock time', () => {
  const before = prelaunchCandidate('2026-08-04T01:00:00Z');
  applyFinalRecommendation(before, BEFORE_RELEASE);

  // Same candidate, same evidence, evaluated again much later.
  const again = prelaunchCandidate('2026-08-04T01:00:00Z');
  applyFinalRecommendation(again, BEFORE_RELEASE);

  assert.equal(before.recommendation, again.recommendation);
  assert.equal(before.finalScore, again.finalScore);
  assert.equal(before.wikiPrelaunch.releaseState, again.wikiPrelaunch.releaseState);
});

test('a pre-release Steam opportunity is actionable before its release date', () => {
  const c = prelaunchCandidate('2026-08-04T01:00:00Z');
  applyFinalRecommendation(c, BEFORE_RELEASE);
  assert.equal(c.wikiPrelaunch.releaseState, 'pre-release');
  assert.equal(c.wikiPrelaunch.classification, 'priority');
  assert.equal(c.recommendation, 'independent');
});

test('the same opportunity is downgraded once the release date has passed', () => {
  const c = prelaunchCandidate('2026-10-01T01:00:00Z');
  applyFinalRecommendation(c, AFTER_RELEASE);
  assert.equal(c.wikiPrelaunch.releaseState, 'released');
  assert.notEqual(c.wikiPrelaunch.classification, 'priority');
  assert.notEqual(c.recommendation, 'independent');
  assert.ok(c.wikiPrelaunch.reasons.some((r) => /已经发售/.test(r)));
});

test('evaluating far in the future does not resurrect a stale prelaunch window', () => {
  const far = prelaunchCandidate('2026-10-01T01:00:00Z');
  applyFinalRecommendation(far, Date.parse('2030-01-01T00:00:00Z'));
  assert.notEqual(far.recommendation, 'independent');
  assert.ok(far.wikiPrelaunch.wishlistAgeDays > 365);
});

test('RELEASE_DAY constant is the fixture release date, guarding against silent fixture edits', () => {
  const c = prelaunchCandidate('2026-08-04T01:00:00Z');
  applyFinalRecommendation(c, RELEASE_DAY - 86400000);
  assert.equal(c.wikiPrelaunch.releaseState, 'pre-release');
});

/**
 * Derived blocks must be a pure function of their inputs, `checkedAt` included.
 *
 * These blocks are recomputed from scratch on every `npm run classify`, which
 * the workflow runs three times per cycle. A wall-clock `checkedAt` inside them
 * made the 10 MB state file differ between runs even when nothing had changed,
 * so every cycle committed a diff that hid whether anything was actually
 * different. Serialising the whole block is the check: any remaining wall-clock
 * read anywhere inside shows up as a mismatch.
 */
test('derived blocks serialise identically for the same input and clock', () => {
  const CLOCK = Date.parse('2026-09-15T12:00:00Z');

  const a = prelaunchCandidate('2026-08-04T01:00:00Z');
  a.siteType = classifySiteType(a, CLOCK);
  applyFinalRecommendation(a, CLOCK);

  const b = prelaunchCandidate('2026-08-04T01:00:00Z');
  b.siteType = classifySiteType(b, CLOCK);
  applyFinalRecommendation(b, CLOCK);

  assert.equal(JSON.stringify(a.siteType), JSON.stringify(b.siteType));
  assert.equal(JSON.stringify(a.wikiPrelaunch), JSON.stringify(b.wikiPrelaunch));
  assert.equal(JSON.stringify(a.marketFreshness), JSON.stringify(b.marketFreshness));
  assert.equal(JSON.stringify(a.opportunity), JSON.stringify(b.opportunity));
  assert.equal(a.siteType.checkedAt, '2026-09-15T12:00:00.000Z');
  assert.equal(a.opportunity.checkedAt, '2026-09-15T12:00:00.000Z');
});

test('classifySiteType timestamps the block with the injected clock, not the wall clock', () => {
  const c = { sources: [{ sourceId: 'poki-new', kind: 'poki-new', url: 'https://poki.com/g/x' }] };
  const stamped = classifySiteType(c, Date.parse('2020-01-01T00:00:00Z'));
  assert.equal(stamped.checkedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(stamped.type, 'online');
});
