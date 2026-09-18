import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEAM_MAX_AGE_DAYS,
  parseSteamReleaseDate,
  isFreshSteamRelease,
  filterFreshSteamEntries,
  parseSteamSearch,
} from '../lib/steam-discovery.mjs';
import { cleanSteamFeedTitle, parseRemoteDocument } from '../lib/scanner.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');

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

// --- 2026-09-18 补：RSS 那条路径从来没有被过滤过 ---
//
// lib/scanner.mjs 的 parseSteamFeedXml 写的是 `date: pubDate`，没有 releaseDate 字段，
// 而过滤器读的是 releaseDate —— 于是 steam-feed-newreleases / steam-feed-topsellers
// 两个源完全绕过了年龄过滤。直抓线上 feed 实测：steam-feed-newreleases 的 30 条里
// 29 条超过 180 天（最老 2325 天，2020-05），它是 Steam 的通用促销 feed 而不是
// 「新发行 RSS」；CI 池子里正好躺着这 29 个词（Noita / Squad / Risk of Rain 2 /
// Deep Rock Galactic / Raft / SCUM …），全部 recommendation=pending。

test('parses the day-first form Steam uses outside the US locale', () => {
  // 直抓 store.steampowered.com 得到的是 "17 Sep, 2026"，不是 "Sep 17, 2026"。
  assert.equal(parseSteamReleaseDate('30 Jul, 2026'), Date.UTC(2026, 6, 30));
  assert.equal(parseSteamReleaseDate('17 Sep, 2026'), Date.UTC(2026, 8, 17));
  assert.equal(parseSteamReleaseDate('1 Jan, 2027'), Date.UTC(2027, 0, 1));
});

test('parses RSS <pubDate> in RFC-2822 form', () => {
  // 忽略时区偏移、只取日历日 —— 180 天的窗口差不到一天，确定性更重要。
  assert.equal(parseSteamReleaseDate('Mon, 14 Sep 2026 17:00:00 -0700'), Date.UTC(2026, 8, 14));
  assert.equal(parseSteamReleaseDate('Sat, 11 Jul 2026 14:59:51 -0700'), Date.UTC(2026, 6, 11));
  assert.equal(parseSteamReleaseDate('Wed, 23 Sep 2020 11:01:39 -0700'), Date.UTC(2020, 8, 23));
  assert.equal(parseSteamReleaseDate('Wed, 13 May 2020 06:01:50 -0800'), Date.UTC(2020, 4, 13));
});

test('month-and-year-only is still unparseable, so upcoming titles survive', () => {
  // "September 2026" 是 upcoming 列表里常见的写法：没有日，就不该被当成过期。
  for (const value of ['September 2026', 'December 2026', 'Q1 2027', '2026', 'Coming soon', 'To be announced']) {
    assert.ok(Number.isNaN(parseSteamReleaseDate(value)), `expected NaN for ${JSON.stringify(value)}`);
    assert.equal(isFreshSteamRelease(value, NOW), true, `${JSON.stringify(value)} 必须被保留`);
  }
});

test('the real steam-feed-newreleases payload loses 29 of 30 items', () => {
  // 下面这些 pubDate 是 2026-09-18 直抓 feeds/newreleases.xml 得到的真实值，不是构造样本。
  const pubDates = [
    'Sat, 11 Jul 2026 14:59:51 -0700', // 68 天，唯一该留下的
    'Tue, 17 Jun 2025 07:55:24 -0700',
    'Mon, 22 Jan 2024 10:01:40 -0800',
    'Sun, 24 Dec 2023 15:03:27 -0800',
    'Thu, 18 Aug 2022 09:09:32 -0700',
    'Wed, 17 Nov 2021 10:01:38 -0800',
    'Thu, 02 Sep 2021 11:04:00 -0700',
    'Tue, 11 Aug 2020 07:54:28 -0700',
    'Thu, 14 May 2020 10:10:00 -0700',
    'Thu, 07 May 2020 09:01:08 -0700', // 2325 天
  ];
  const entries = pubDates.map((releaseDate, index) => ({ releaseDate, title: `t${index}` }));
  const kept = filterFreshSteamEntries(entries, NOW);
  assert.deepEqual(kept.map((entry) => entry.title), ['t0'],
    '只有 68 天的那条该留下；其余全是 2020~2025 年的促销公告');
});

test('a Steam feed drops stale items and keeps fresh ones', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Now Available on Steam - Resident Evil 3 Special Soundtrack</title>
      <link>https://store.steampowered.com/app/1/old/</link>
      <pubDate>Thu, 07 May 2020 09:01:08 -0700</pubDate></item>
    <item><title>Now Available on Steam - Fresh Indie</title>
      <link>https://store.steampowered.com/app/2/fresh/</link>
      <pubDate>Mon, 14 Sep 2026 17:00:00 -0700</pubDate></item>
  </channel></rss>`;
  const parsed = parseRemoteDocument(xml, 'https://store.steampowered.com/feeds/newreleases.xml', 'steam-feed');
  assert.ok(parsed, 'feed 应该解析成功');
  assert.deepEqual(parsed.entries.map((entry) => entry.gameName), ['Fresh Indie'],
    '2020 年那条必须被丢掉 —— 这正是它以前做不到的事');
  // 过滤读的字段必须真的挂在 entry 上，否则规则形同虚设。
  assert.ok('releaseDate' in parsed.entries[0], 'feed entry 必须带 releaseDate，否则过滤器看不到它');
});

test('promo announcements are dropped rather than having their prefix stripped', () => {
  // 剥前缀会造出一个不是游戏的名字。
  assert.equal(cleanSteamFeedTitle('Weekend Deal - The Elder Scrolls Franchise'), '');
  assert.equal(cleanSteamFeedTitle('Free Weekend - Fallout 76'), '');
  assert.equal(cleanSteamFeedTitle('New DLC Available - ROMANCE OF THE THREE KINGDOMS'), '');
  // 但正常的新发行公告仍然要剥前缀、留下游戏名。
  assert.equal(cleanSteamFeedTitle('Now Available on Steam - Squad'), 'Squad');
  assert.equal(cleanSteamFeedTitle('Coming Soon - Some Indie'), 'Some Indie');
});

/**
 * 守卫：这一族缺陷（同一规则两套定义，活着的那套更粗糙）在本仓已经出现过 6 次。
 * 「Steam 发行日期怎么解析、多少天算老」是第 7 次的候选，所以这里钉住定义只能有一处。
 */
test('Steam 的日期规则只有一处定义，两条抓取路径共用它', async () => {
  const files = [];
  for (const dir of ['lib', 'scripts', 'tools']) {
    for (const name of await fs.readdir(path.join(root, dir))) {
      if (name.endsWith('.mjs')) files.push(path.join(dir, name));
    }
  }
  const offenders = [];
  for (const file of files) {
    const source = await read(file);
    if (/const\s+STEAM_MAX_AGE_DAYS\s*=/.test(source) && file !== path.join('lib', 'steam-release-date.mjs')) {
      offenders.push(file);
    }
    if (/export function parseSteamReleaseDate/.test(source) && file !== path.join('lib', 'steam-release-date.mjs')) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'STEAM_MAX_AGE_DAYS / parseSteamReleaseDate 只能定义在 lib/steam-release-date.mjs');

  // 列表路径（search 页）：靠 re-export 保持对外的名字不变。
  const discovery = await read('lib/steam-discovery.mjs');
  assert.match(discovery, /export \* from '\.\/steam-release-date\.mjs'/,
    'steam-discovery.mjs 要 re-export，别把规则复制一份回来');

  // feed 路径：必须真的 import 共用的过滤器，否则两个 RSS 源又绕过年龄过滤。
  const scanner = await read('lib/scanner.mjs');
  assert.match(scanner, /import \{ filterFreshSteamEntries \} from '\.\/steam-release-date\.mjs'/,
    'scanner.mjs 要用共用的过滤器');
  const feedFn = scanner.split('function parseSteamFeedXml(')[1]?.split('\n}\n')[0] || '';
  assert.match(feedFn, /filterFreshSteamEntries\(entries\)/, 'feed 解析必须过滤');
  assert.match(feedFn, /releaseDate: pubDate/, 'feed entry 必须带 releaseDate —— 过滤器读的是这个字段名');
});
