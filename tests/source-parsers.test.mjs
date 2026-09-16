import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRemoteDocument,
  parseGogJson,
  GOG_MAX_AGE_DAYS,
  cleanSteamFeedTitle,
  cleanPressTitle,
  cleanShowHnTitle,
  hnLooksLikeGame,
} from '../lib/scanner.mjs';

// ---------------------------------------------------------------- Steam feeds

test('strips the Steam "Now Available" wrapper and discount suffix', () => {
  assert.equal(cleanSteamFeedTitle('Now Available on Steam - SCUM'), 'SCUM');
  assert.equal(cleanSteamFeedTitle('Now Available on Steam - Angels Fall First, 10% off!'), 'Angels Fall First');
  assert.equal(cleanSteamFeedTitle('Now Available on Steam - Foundation, 25% off!'), 'Foundation');
});

test('drops Steam feed entries that are not game announcements', () => {
  assert.equal(cleanSteamFeedTitle('Team Fortress 2 Update Released'), '');
  assert.equal(cleanSteamFeedTitle('Steam Client Update'), '');
  assert.equal(cleanSteamFeedTitle('Patch Notes for September'), '');
});

test('parses the newreleases feed, taking the name from the title because the link is a news page', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Now Available on Steam - SCUM</title><link>https://store.steampowered.com/news/246601/</link><pubDate>Tue, 17 Jun 2025 07:55:24 -0700</pubDate></item>
    <item><title>Team Fortress 2 Update Released</title><link>https://store.steampowered.com/news/276347/</link><pubDate>Thu, 16 Jul 2026 13:22:00 -0700</pubDate></item>
  </channel></rss>`;
  const parsed = parseRemoteDocument(xml, 'https://store.steampowered.com/feeds/newreleases.xml', 'steam-feed');
  assert.equal(parsed.type, 'steam-feed');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].gameName, 'SCUM');
});

test('parses the top-sellers feed, keeping rank and a name that ends in "Game"', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>#1 - WARDOGS</title><link>https://store.steampowered.com/app/1867240/WARDOGS?t=1</link><pubDate>Mon, 14 Sep 2026 17:00:00 -0700</pubDate></item>
    <item><title>#6 - Halloween: The Game</title><link>https://store.steampowered.com/app/3219630/Halloween_The_Game?t=1</link><pubDate>Mon, 14 Sep 2026 17:00:00 -0700</pubDate></item>
  </channel></rss>`;
  const parsed = parseRemoteDocument(xml, 'https://store.steampowered.com/feeds/weeklytopsellers.xml', 'steam-feed');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].gameName, 'WARDOGS');
  assert.equal(parsed.entries[0].rank, 1);
  // Regression: `deriveGameName` strips a trailing " Game", which used to turn
  // this real Steam title into "Halloween: The".
  assert.equal(parsed.entries[1].gameName, 'Halloween: The Game');
  assert.equal(parsed.entries[1].rank, 6);
});

// --------------------------------------------------------------- Press feeds

test('strips the beta/demo suffix indie press feeds append to game names', () => {
  assert.equal(cleanPressTitle('Kingmakers – Beta Sign Up'), 'Kingmakers');
  assert.equal(cleanPressTitle('Road to Jukai – Open Beta'), 'Road to Jukai');
  assert.equal(cleanPressTitle('Failrooms – Beta Demo'), 'Failrooms');
  assert.equal(cleanPressTitle('Arctic Drive - Open Beta'), 'Arctic Drive');
  // No suffix at all: the name must survive untouched.
  assert.equal(cleanPressTitle('Remothered: Red Nun’s Legacy'), 'Remothered: Red Nun’s Legacy');
});

test('parses a press feed into clean game names', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Kingmakers &#8211; Beta Sign Up</title><link>https://www.alphabetagamer.com/kingmakers-beta-sign-up/</link></item>
    <item><title>Press Kit</title><link>https://www.alphabetagamer.com/press-kit/</link></item>
  </channel></rss>`;
  const parsed = parseRemoteDocument(xml, 'https://www.alphabetagamer.com/feed/', 'press-feed');
  assert.equal(parsed.type, 'press-feed');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].gameName, 'Kingmakers');
});

// --------------------------------------------------------------- Hacker News

test('accepts Show HN posts that describe a playable game', () => {
  assert.equal(hnLooksLikeGame('Show HN: Picobble – my daily word puzzle game'), true);
  assert.equal(hnLooksLikeGame('Show HN: Raiders at the Gate – tower defense web game'), true);
  assert.equal(hnLooksLikeGame('Show HN: Ember – a strategy game where everyone moves at once'), true);
});

test('rejects Show HN posts about engines, tooling, wikis and datasets', () => {
  assert.equal(hnLooksLikeGame('Show HN: Aeon Engine – 3D game engine in Safe Rust'), false);
  assert.equal(hnLooksLikeGame('Show HN: Srvquery, a TypeScript toolkit for querying game servers'), false);
  assert.equal(hnLooksLikeGame('Show HN: How to Fish Game Wiki'), false);
  assert.equal(hnLooksLikeGame('Show HN: A design-space map of 80k Steam games'), false);
  assert.equal(hnLooksLikeGame('Show HN: Highball – Run Windows games on Apple Silicon, with an open game db'), false);
});

test('extracts the game name from a Show HN title and rejects sentences', () => {
  assert.equal(cleanShowHnTitle('Show HN: Requirement5 – a digital card collection game'), 'Requirement5');
  assert.equal(cleanShowHnTitle('Show HN: Below the Root (1984 game) ported to JavaScript'), 'Below the Root');
  // Starts with a pronoun: the whole string is a sentence, not a name.
  assert.equal(cleanShowHnTitle('Show HN: I built an infinite canvas for game masters'), '');
  // Pure description rather than a name.
  assert.equal(cleanShowHnTitle('Show HN: AI-Powered Word Guessing Game'), '');
});

test('parses the HN JSON listing and skips non-game hits', () => {
  const json = JSON.stringify({
    hits: [
      { objectID: 1, title: 'Show HN: Picobble – my daily word puzzle game', url: 'https://picobble.com/', created_at: '2026-09-12T19:45:27Z' },
      { objectID: 2, title: 'Show HN: Llmbridge, a C++ LLM gateway', url: 'https://github.com/x/y', created_at: '2026-09-12T19:40:00Z' },
      { objectID: 3, title: 'Show HN: Ember – a strategy game where everyone moves at once', url: '', created_at: '2026-09-12T18:09:41Z' },
    ],
  });
  const parsed = parseRemoteDocument(json, 'https://hn.algolia.com/api/v1/search_by_date', 'hn-listing');
  assert.equal(parsed.type, 'hn-listing');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].gameName, 'Picobble');
  // No external URL: fall back to the discussion permalink.
  assert.equal(parsed.entries[1].url, 'https://news.ycombinator.com/item?id=3');
});

// ------------------------------------------------------------------- GitHub

test('parses GitHub search results, re-casing repo slugs and expanding acronyms', () => {
  const json = JSON.stringify({
    items: [
      { full_name: 'detain/shmup-cup', html_url: 'https://github.com/detain/shmup-cup', created_at: '2026-09-10T22:59:03Z' },
      { full_name: 'honestfoxXXX/zhanwen-rts', html_url: 'https://github.com/honestfoxXXX/zhanwen-rts', created_at: '2026-08-30T10:35:34Z' },
      { full_name: 'mike007jd/eightfront-3d', html_url: 'https://github.com/mike007jd/eightfront-3d', created_at: '2026-09-15T14:10:50Z' },
    ],
  });
  const parsed = parseRemoteDocument(json, 'https://api.github.com/search/repositories', 'github-listing');
  assert.equal(parsed.type, 'github-listing');
  assert.equal(parsed.entries[0].gameName, 'Shmup Cup');
  assert.equal(parsed.entries[1].gameName, 'Zhanwen RTS');
  assert.equal(parsed.entries[2].gameName, 'Eightfront 3D');
});

test('skips GitHub Pages sites and placeholder repo names', () => {
  const json = JSON.stringify({
    items: [
      { full_name: 'a/b.github.io', html_url: 'https://github.com/a/b.github.io' },
      { full_name: 'c/game', html_url: 'https://github.com/c/game' },
      { full_name: 'd/hordes', html_url: 'https://github.com/d/hordes' },
    ],
  });
  const parsed = parseRemoteDocument(json, 'https://api.github.com/search/repositories', 'github-listing');
  assert.deepEqual(parsed.entries.map((entry) => entry.gameName), ['Hordes']);
});

// -------------------------------------------------------------- Armor Games

test('parses Armor Games anchors that embed markup in an attribute value', () => {
  // The first anchor's `data-content` contains raw HTML, which used to break
  // the `[^>]*` attribute scan; the second carries a clean title.
  const html = `<div>
    <a href="/play/13488/ragdoll-achievement?fp=gotd" class="game" data-timestamp="1340990459" title='<i class="symbol type-joystick4"</i> Ragdoll Achievement' data-content='&lt;table&gt;&lt;/table&gt;'>Ragdoll Achievement</a>
    <a href="/play/17923/earth-taken-3?fp=b-action" class="game" title='Earth Taken 3' data-content='<table><tr><th>Player Rating:</th><td>93/100</td></tr></table>'>Earth Taken 3</a>
  </div>`;
  const parsed = parseRemoteDocument(html, 'https://armorgames.com/', 'armorgames-listing');
  assert.equal(parsed.type, 'armorgames-listing');
  const names = parsed.entries.map((entry) => entry.gameName);
  // The malformed title falls back to the slug, and the sequel number in a
  // clean title is preserved (the portal cleaner would strip it).
  assert.deepEqual(names, ['Ragdoll Achievement', 'Earth Taken 3']);
  assert.equal(parsed.entries[0].url, 'https://armorgames.com/play/13488/ragdoll-achievement');
  assert.equal(parsed.entries[0].date, '2012-06-29T17:20:59.000Z');
});

// ---------------------------------------------------------------------- GOG

const GOG_NOW = Date.parse('2026-09-16T12:00:00Z');

test('GOG keeps only releases inside the recency window', () => {
  // The live feed really does contain three-year-old entries: `new-arrival`
  // means "newly added to the GOG catalogue", not "newly released".
  const json = JSON.stringify({
    products: [
      { title: 'HOPE 01', slug: 'hope_01', releaseDate: '2026.09.15' },
      { title: 'Maiden Cops', slug: 'maiden_cops', releaseDate: '2024.09.23' },
      { title: 'Gennady Demo', slug: 'gennady_demo', releaseDate: '2023.10.05' },
    ],
  });
  const parsed = parseGogJson(json, GOG_NOW);
  assert.equal(parsed.type, 'gog-listing');
  assert.deepEqual(parsed.entries.map((entry) => entry.gameName), ['HOPE 01']);
  assert.equal(parsed.entries[0].url, 'https://www.gog.com/en/game/hope_01');
  assert.equal(parsed.entries[0].date, '2026-09-15T00:00:00.000Z');
});

test('GOG drops demos, soundtracks and placeholder titles', () => {
  const recent = '2026.09.10';
  const json = JSON.stringify({
    products: [
      { title: 'Gently Packed Demo', slug: 'gently_packed_demo', releaseDate: recent },
      { title: 'Alien Breed 35th Anniversary Demo', slug: 'alien_breed_demo', releaseDate: recent },
      { title: 'Morimens OST', slug: 'morimens_ost', releaseDate: recent },
      { title: 'Calculator - Desktop Mate Widgets DLC', slug: 'calc_dlc', releaseDate: recent },
      { title: 'TEST TEST TEST', slug: 'test_test_test', releaseDate: recent },
      { title: 'Magical Blush', slug: 'magical_blush', releaseDate: recent },
    ],
  });
  const names = parseGogJson(json, GOG_NOW).entries.map((entry) => entry.gameName);
  assert.deepEqual(names, ['Magical Blush']);
});

test('GOG skips entries with no usable slug or date, and dedupes by URL', () => {
  const json = JSON.stringify({
    products: [
      { title: 'No Slug', releaseDate: '2026.09.10' },
      { title: 'No Date', slug: 'no_date' },
      { title: 'Dup', slug: 'dup', releaseDate: '2026.09.10' },
      { title: 'Dup Again', slug: 'dup', releaseDate: '2026.09.11' },
    ],
  });
  assert.deepEqual(parseGogJson(json, GOG_NOW).entries.map((entry) => entry.gameName), ['Dup']);
});

test('GOG returns null on a body that is not a catalog response', () => {
  assert.equal(parseGogJson('<html>nope</html>', GOG_NOW), null);
  assert.equal(parseGogJson('{"products":"nope"}', GOG_NOW), null);
});

test('the GOG window boundary is inclusive and driven by the injected clock', () => {
  const boundary = new Date(GOG_NOW - GOG_MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10).replace(/-/g, '.');
  const json = JSON.stringify({ products: [{ title: 'Edge', slug: 'edge', releaseDate: boundary }] });
  assert.equal(parseGogJson(json, GOG_NOW).entries.length, 1);
  // A day later the same entry falls outside the window.
  assert.equal(parseGogJson(json, GOG_NOW + 86400000).entries.length, 0);
});
