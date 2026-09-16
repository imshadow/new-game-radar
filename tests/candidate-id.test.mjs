import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateId, normalizeGameName } from '../lib/scanner.mjs';

/**
 * `candidate.id` is not a display field. It is used as a Map key by
 * `scripts/scan.mjs` (the previous fast-score baseline), `lib/trend-queue.mjs`
 * (which candidates were already selected) and the `fill-*-trends` scripts
 * (result attribution). A collision therefore makes distinct games inherit each
 * other's baselines, and can silently drop a candidate from the Trends queue.
 *
 * The old scheme was `base64url(normalizedName).slice(0, 24)`. base64url packs 3
 * bytes into 4 characters, so 24 characters is exactly 18 bytes — the slice fell
 * on a clean boundary and reduced the id to the first 18 characters of the name.
 */

/** The pre-fix scheme, kept so the regression is provable rather than asserted. */
function legacyId(normalizedName) {
  return `auto-${Buffer.from(normalizedName).toString('base64url').slice(0, 24)}`;
}

test('the legacy id scheme collides on names sharing an 18-character prefix', () => {
  // Guards the guard: if this stops colliding, the tests below prove nothing.
  assert.equal(legacyId('indie game of the year 2025'), legacyId('indie game of the year 2016'));
  assert.equal(legacyId('horror on the orient express'), legacyId('horror on the orient the board'));
});

test('candidateId separates names that share a long prefix', () => {
  const names = [
    'indie game of the year 2025',
    'indie game of the year 2016',
    'indie game of the year 2015',
    'horror on the orient express',
    'horror on the orient express board',
    'horror on the orient the board',
  ];
  const ids = names.map(candidateId);
  assert.equal(new Set(ids).size, names.length, `ids collided: ${ids.join(', ')}`);
});

test('candidateId is a pure function of the normalised name', () => {
  assert.equal(candidateId('neon drift'), candidateId('neon drift'));
  assert.notEqual(candidateId('neon drift'), candidateId('neon drift two'));
  assert.match(candidateId('neon drift'), /^auto-[0-9a-f]{16}$/);
});

test('equivalent titles normalise onto one candidate', () => {
  // "Play Neon Drift Online" and "Neon Drift" are the same game and must not
  // split into two records, so the id has to follow the normalised form.
  assert.equal(
    candidateId(normalizeGameName('Play Neon Drift Online')),
    candidateId(normalizeGameName('Neon Drift')),
  );
});

test('candidateId stays collision-free over a large synthetic corpus', () => {
  // Names that deliberately share long prefixes are exactly what broke the old
  // scheme: 400 prefixes x 25 suffixes = 10,000 names.
  const ids = new Set();
  let count = 0;
  for (let i = 0; i < 400; i += 1) {
    const prefix = `game number ${String(i).padStart(3, '0')} deluxe edition `;
    for (let j = 0; j < 25; j += 1) {
      ids.add(candidateId(`${prefix}${j}`));
      count += 1;
    }
  }
  assert.equal(ids.size, count, `expected ${count} unique ids, got ${ids.size}`);
});
