import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEAM_MAX_AGE_DAYS,
  parseSteamReleaseDate,
  isFreshSteamRelease,
  filterFreshSteamEntries,
  parseSteamSearch,
} from '../lib/steam-discovery.mjs';

// A fixed clock: the age verdict must not depend on when the suite runs, and
// parseSteamReleaseDate must not depend on the machine's timezone.
const NOW = Date.parse('2026-09-18T10:00:00Z');

test('parses Steam\'s "Sep 15, 2026" as UTC midnight, not local midnight', () => {
  assert.equal(parseSteamReleaseDate('Sep 15, 2026'), Date.UTC(2026, 8, 15));
  assert.equal(parseSteamReleaseDate('Sep. 15, 2026'), Date.UTC(2026, 8, 15));
  assert.equal(parseSteamReleaseDate('Jan 1, 2027'), Date.UTC(2027, 0, 1));
});

test('treats every date Steam uses for unreleased titles as unparseable', () => {
  for (const value of ['Coming soon', 'Q1 2027', 'To be announced', '', '2026', null, undefined]) {
    assert.ok(Number.isNaN(parseSteamReleaseDate(value)), `expected NaN for ${JSON.stringify(value)}`);
  }
});

test('drops a demonstrably old release but keeps a fresh one', () => {
  assert.equal(isFreshSteamRelease('Nov 2, 2023', NOW), false);   // Palworld-era title
  assert.equal(isFreshSteamRelease('Sep 15, 2026', NOW), true);   // three days old
});

test('keeps unparseable dates, so upcoming/wishlist sources survive the filter', () => {
  for (const value of ['Coming soon', 'Q1 2027', 'To be announced', '']) {
    assert.equal(isFreshSteamRelease(value, NOW), true, `expected ${JSON.stringify(value)} to be kept`);
  }
});

test('the age cutoff is a closed interval on UTC midnight boundaries', () => {
  // NOW - 180d floors to 2026-03-22T00:00:00Z, so a title released that day is
  // still inside the window and one released a day earlier is not.
  assert.equal(isFreshSteamRelease('Mar 22, 2026', NOW), true);
  assert.equal(isFreshSteamRelease('Mar 21, 2026', NOW), false);
  assert.equal(STEAM_MAX_AGE_DAYS, 180);
});

test('keeps a two-month-old title that the radar can still act on', () => {
  // Endacopia was released 53 days before the run that made it one of two
  // `page` verdicts, so a GOG-style 45-day window would have dropped a hit.
  assert.equal(isFreshSteamRelease('Jul 27, 2026', NOW), true);
  // But a title that has been out for a year is not a new game.
  assert.equal(isFreshSteamRelease('Sep 18, 2025', NOW), false);
});

test('filterFreshSteamEntries keeps order and does not mutate its input', () => {
  const entries = [
    { gameName: 'Old', releaseDate: 'Nov 2, 2023' },
    { gameName: 'New', releaseDate: 'Sep 15, 2026' },
    { gameName: 'Soon', releaseDate: 'Coming soon' },
  ];
  const snapshot = JSON.stringify(entries);
  const kept = filterFreshSteamEntries(entries, NOW);
  assert.deepEqual(kept.map((entry) => entry.gameName), ['New', 'Soon']);
  assert.equal(JSON.stringify(entries), snapshot);
});

test('a parsed Steam listing keeps only the fresh rows', () => {
  const html = `
    <a class="search_result_row" href="https://store.steampowered.com/app/892970/Valheim/">
      <span class="title">Valheim</span><div class="search_released">Feb 2, 2021</div>
    </a>
    <a class="search_result_row" href="https://store.steampowered.com/app/4000000/Fresh/">
      <span class="title">Fresh One</span><div class="search_released">Sep 15, 2026</div>
    </a>
    <a class="search_result_row" href="https://store.steampowered.com/app/4000001/Soon/">
      <span class="title">Soon One</span><div class="search_released">Coming soon</div>
    </a>`;
  const parsed = parseSteamSearch(html);
  assert.equal(parsed.length, 3, 'the parser itself must stay unfiltered');
  const kept = filterFreshSteamEntries(parsed, NOW);
  assert.deepEqual(kept.map((entry) => entry.title), ['Fresh One', 'Soon One']);
});
