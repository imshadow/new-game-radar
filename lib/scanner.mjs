import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { filterFreshSteamEntries } from './steam-release-date.mjs';

// 带上可解析的项目地址，而不是空的 https://github.com/ ——部分站点会按 UA
// 里的联系人信息决定是限流还是直接封禁。
const USER_AGENT = 'NewGameRadar/1.0 (+https://github.com/imshadow/new-game-radar)';
const MAX_BYTES = 2_500_000;
const FETCH_TIMEOUT_MS = 12_000;
const DNS_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

/** Race a promise against a timer so DNS cannot hang a request forever. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * `::ffff:127.0.0.1` reaches exactly the same host as `127.0.0.1`, so the
 * mapped form has to be judged by the IPv4 rules. WHATWG URL serialises it in
 * HEX — `http://[::ffff:127.0.0.1]/` becomes `[::ffff:7f00:1]` — so the dotted
 * prefixes this guard used to compare against never matched anything, and the
 * mapped form walked straight past it. That is an SSRF bypass, not a false
 * negative: `http://[::ffff:a9fe:a9fe]/` is the cloud metadata endpoint.
 * Decode the low 32 bits and reuse `isPrivateIpv4`.
 */
function mappedIpv4(ip) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateIpv6(ip) {
  const value = ip.toLowerCase();
  const mapped = mappedIpv4(value);
  if (mapped) return isPrivateIpv4(mapped);
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb')
  );
}

export async function assertPublicUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('URL 格式不正确');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 HTTP 或 HTTPS URL');
  if (url.username || url.password) throw new Error('URL 不允许包含账号密码');
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new Error('不允许访问本地地址');

  // `url.hostname` KEEPS the brackets on an IPv6 literal (`http://[::1]/` ->
  // `[::1]`), and `net.isIP('[::1]')` is 0, so `dns.lookup` skipped its
  // literal fast path and handed the bracketed string to the system resolver.
  // Windows tolerates that; glibc answers EAI_NONAME, so on Linux EVERY IPv6
  // URL died as ENOTFOUND *before* the private-address loop below could run.
  // Two consequences, both silent: the loopback/private guard was unreachable
  // for IPv6 (the request was never made, so it failed closed, but the guard
  // never fired), and a perfectly public IPv6 host could never be fetched.
  // Stripping the brackets puts the literal back on the local fast path.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  const addresses = await withTimeout(
    dns.lookup(host, { all: true, verbatim: true }),
    DNS_TIMEOUT_MS,
    '域名解析超时',
  );
  if (!addresses.length) throw new Error('域名无法解析');
  for (const { address } of addresses) {
    const family = net.isIP(address);
    if ((family === 4 && isPrivateIpv4(address)) || (family === 6 && isPrivateIpv6(address))) {
      throw new Error('不允许访问内网或保留地址');
    }
  }
  return url;
}

async function readLimitedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('响应内容过大');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error('响应内容超过 2.5MB 限制');
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Fetch a URL as text, guarding against SSRF, oversized bodies and slow hosts.
 *
 * `deadline` is a single wall-clock budget for the WHOLE redirect chain, not per
 * hop. Previously each redirect started a fresh 12s timer, so a chain of 3
 * redirects could consume 48s for one source — well past the 60s ceiling of the
 * Vercel scan function. Callers can pass their own deadline to share one budget
 * across several sources.
 */
export async function safeFetchText(input, redirectCount = 0, deadline = Date.now() + FETCH_TIMEOUT_MS) {
  // Check the budget before anything else: a DNS lookup or a request issued with
  // no time left just wastes work and hides the real reason for the failure.
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('请求超时');
  const url = await assertPublicUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,text/html;q=0.9,*/*;q=0.5',
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少 Location');
      return safeFetchText(new URL(location, url).toString(), redirectCount + 1, deadline);
    }

    if (!response.ok) throw new Error(`远程站点返回 ${response.status}`);
    return {
      text: await readLimitedText(response),
      finalUrl: url.toString(),
      contentType: response.headers.get('content-type') || '',
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function stripHtml(value = '') {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function normalizeUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(decodeEntities(value), baseUrl).toString();
  } catch {
    return '';
  }
}

function parseSitemapXml(text, baseUrl) {
  const sitemapBlocks = [...text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)];
  if (sitemapBlocks.length) {
    return {
      type: 'sitemap-index',
      children: sitemapBlocks.map((match) => normalizeUrl(extractTag(match[1], 'loc'), baseUrl)).filter(Boolean),
      entries: [],
    };
  }

  const urlBlocks = [...text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)];
  if (!urlBlocks.length) return null;
  return {
    type: 'sitemap',
    children: [],
    entries: urlBlocks.map((match) => ({
      url: normalizeUrl(extractTag(match[1], 'loc'), baseUrl),
      title: '',
      date: extractTag(match[1], 'lastmod'),
    })).filter((entry) => entry.url),
  };
}

function parseFeedXml(text, baseUrl) {
  const itemBlocks = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if (itemBlocks.length) {
    return {
      type: 'feed',
      entries: itemBlocks.map((match) => {
        const block = match[1];
        return {
          title: stripHtml(extractTag(block, 'title')),
          url: normalizeUrl(extractTag(block, 'link') || extractTag(block, 'guid'), baseUrl),
          date: extractTag(block, 'pubDate') || extractTag(block, 'dc:date'),
        };
      }).filter((entry) => entry.url),
      children: [],
    };
  }

  const entryBlocks = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  if (!entryBlocks.length) return null;
  return {
    type: 'feed',
    entries: entryBlocks.map((match) => {
      const block = match[1];
      const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
      return {
        title: stripHtml(extractTag(block, 'title')),
        url: normalizeUrl(hrefMatch?.[1] || extractTag(block, 'link'), baseUrl),
        date: extractTag(block, 'updated') || extractTag(block, 'published'),
      };
    }).filter((entry) => entry.url),
    children: [],
  };
}

function cleanListingTitle(value = '') {
  return stripHtml(value)
    .replace(/^(?:new|hot|top|updated|originals?)\s+/i, '')
    .replace(/\s+(?:new|hot|top|updated|originals?)$/i, '')
    .replace(/\s+\d(?:\.\d)?$/i, '')
    .replace(/\s+(?:game\s+)?new$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchorAttribute(attrs, name) {
  return attrs.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1] || '';
}

function parseAnchors(text, baseUrl) {
  const results = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(regex)) {
    const attrs = match[1];
    const url = normalizeUrl(anchorAttribute(attrs, 'href'), baseUrl);
    if (!url) continue;
    const imageAlt = match[2].match(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/i)?.[1] || '';
    const rawTitle = anchorAttribute(attrs, 'aria-label') || anchorAttribute(attrs, 'title') || stripHtml(match[2]) || imageAlt;
    results.push({ url, title: cleanListingTitle(rawTitle), date: '' });
  }
  return results;
}

const LISTING_PROFILES = {
  'poki-listing': { path: /^\/(?:[a-z]{2}\/)?g\/[a-z0-9-]+\/?$/i },
  'crazygames-listing': { path: /^\/(?:[a-z]{2}\/)?game\/[a-z0-9-]+\/?$/i },
  'y8-listing': { path: /^\/games\/[a-z0-9_%-]+\/?$/i },
  'gamepix-listing': { path: /^\/play\/[a-z0-9-]+\/?$/i },
  'lagged-listing': { path: /^\/(?:[a-z]{2}\/)?g\/[a-z0-9-]+\/?$/i },
};

function parsePortalHtml(text, baseUrl, kind) {
  const profile = LISTING_PROFILES[kind];
  const base = new URL(baseUrl);
  const seen = new Set();
  const entries = [];
  for (const entry of parseAnchors(text, baseUrl)) {
    let url;
    try { url = new URL(entry.url); } catch { continue; }
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (!profile?.path.test(url.pathname)) continue;
    if (!entry.title || entry.title.length < 2 || seen.has(url.toString())) continue;
    seen.add(url.toString());
    entries.push({ ...entry, url: url.toString() });
  }
  return { type: kind, entries, children: [] };
}

function parseItchHtml(text, baseUrl) {
  const entries = [];
  const seen = new Set();
  const anchorRegex = /<a\b([^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(anchorRegex)) {
    const href = match[1].match(/href=["']([^"']+)["']/i)?.[1];
    const url = normalizeUrl(href, baseUrl);
    const title = cleanListingTitle(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, title, date: '' });
  }
  return { type: 'itch-listing', entries, children: [] };
}

/**
 * Steam's own RSS feeds are the most stable Steam signal available (no HTML
 * scraping), but two of them need different handling:
 *
 *   newreleases.xml        title "Now Available on Steam - SCUM, 10% off!"
 *                          link  /news/<id>/  (a news page, not an app page)
 *   weeklytopsellers.xml   title "#1 - WARDOGS"
 *                          link  /app/<id>/<slug>
 *
 * So the game name has to come from the title, and the noise (`Update
 * Released`, patch notes, Steam client updates) has to be dropped — otherwise
 * the radar fills up with "Team Fortress 2 Update Released" as a "game".
 */
export function cleanSteamFeedTitle(value = '') {
  const raw = stripHtml(value);
  // 促销公告不是新游戏，整条丢掉而不是剥前缀 —— 剥完会得到一个不是游戏的名字
  // （"Weekend Deal - The Elder Scrolls Franchise" → "The Elder Scrolls Franchise"）。
  // 实测 2026-09-18：steam-feed-newreleases 的 30 条里就有 3 条属于这一类，
  // 而那个 feed 其实是 Steam 的通用促销 feed，不是「新发行 RSS」。
  if (/^(weekend\s+deal|free\s+weekend|new\s+dlc\s+available)\b/i.test(raw)) return '';
  let title = raw
    .replace(/^Now\s+Available\s+on\s+Steam\s*[–—-]\s*/i, '')
    .replace(/^Coming\s+Soon\s*[–—-]\s*/i, '')
    .replace(/\s*[-–—]\s*Now\s+Available.*$/i, '')
    .replace(/,\s*\d+%\s*off!?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/update\s+released|patch\s+notes|hotfix|server\s+maintenance|release\s+notes/i.test(title)) return '';
  if (/^Steam\s+/i.test(title)) return '';
  if (title.length < 2 || title.length > 60) return '';
  return title;
}

function parseSteamFeedXml(text, baseUrl) {
  const itemBlocks = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if (!itemBlocks.length) return null;
  const entries = [];
  const seen = new Set();
  for (const match of itemBlocks) {
    const block = match[1];
    const url = normalizeUrl(extractTag(block, 'link') || extractTag(block, 'guid'), baseUrl);
    if (!url || seen.has(url)) continue;
    const rawTitle = stripHtml(extractTag(block, 'title'));
    const ranked = rawTitle.match(/^#(\d+)\s*[-–—]\s*(.+)$/);
    const title = ranked ? ranked[2].trim() : cleanSteamFeedTitle(rawTitle);
    if (!title) continue;
    seen.add(url);
    const pubDate = extractTag(block, 'pubDate');
    entries.push({
      url,
      title,
      // The name is already exact here; `deriveGameName` would strip a trailing
      // " Game" and turn Steam's "Halloween: The Game" into "Halloween: The".
      gameName: title,
      date: pubDate,
      // 年龄过滤读的是 `releaseDate`（Steam 列表路径的字段名）。这里以前只写 `date`，
      // 于是 steam-feed-* 这两个源从来没进过过滤 —— 而它们正是老游戏的主要来源。
      releaseDate: pubDate,
      rank: ranked ? Number(ranked[1]) : undefined,
    });
  }
  // 和 search 页那条路径共用同一条 180 天规则（lib/steam-release-date.mjs）。
  // 实测 2026-09-18：steam-feed-newreleases 的 30 条里 29 条超过 180 天（最老 2325 天），
  // 过滤后只剩 1 条；steam-feed-topsellers 的 10 条全是 3 天龄，一条都不掉。
  return { type: 'steam-feed', entries: filterFreshSteamEntries(entries), children: [] };
}

/**
 * Indie-press RSS feeds announce games in a `<Game> – <what it is>` shape
 * ("Kingmakers – Beta Demo", "Failrooms – Prototype"). The suffix is not part
 * of the name, and editorial posts (press kits, round-ups, interviews) are not
 * games at all.
 */
const PRESS_NOISE = /^(?:press\s+kit|about\s+us|contact|donate|support\s+us|top\s+\d+|best\s+of|round[- ]?up|podcast|newsletter|site\s+update|weekly\s+recap)/i;

export function cleanPressTitle(value = '') {
  const title = stripHtml(value)
    .replace(/\s*[|–—]\s*(?:beta\s+sign[\s-]?up|beta\s+demo|open\s+beta|closed\s+beta|beta|demo|playtest|alpha|prototype|early\s+access|release|out\s+now|press\s+kit|free\s+download|download)\s*$/i, '')
    .replace(/\s*[-]\s*(?:beta\s+sign[\s-]?up|beta\s+demo|open\s+beta|closed\s+beta|playtest|prototype|press\s+kit)\s*$/i, '')
    .replace(/\s+(?:beta\s+sign[\s-]?up|beta\s+demo|open\s+beta|closed\s+beta|playtest|prototype)\s*$/i, '')
    .replace(/^(?:review|preview|interview|hands[- ]on|impressions)\s*[:\-–—]\s*/i, '')
    .replace(/\s*[:\-–—]\s*(?:review|preview|impressions|interview)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || PRESS_NOISE.test(title)) return '';
  if (title.length < 2 || title.length > 60) return '';
  return title;
}

function parsePressFeedXml(text, baseUrl) {
  const parsed = parseFeedXml(text, baseUrl);
  if (!parsed) return null;
  const entries = [];
  for (const entry of parsed.entries) {
    const title = cleanPressTitle(entry.title);
    if (!title) continue;
    entries.push({ ...entry, title, gameName: title });
  }
  return { type: 'press-feed', entries, children: [] };
}

/**
 * Hacker News "Show HN" posts are the earliest public signal a game can emit —
 * often weeks before it reaches any store. The Algolia API returns JSON, which
 * the HTML/XML parsers cannot read, so it needs its own parser.
 *
 * Names arrive as `Show HN: <Name> – <pitch>`; the pitch is not part of the
 * name. More importantly most of the feed is *not* a game — engines, SDKs,
 * wikis, datasets and platform launches all mention "game" somewhere — so
 * relevance is decided by whether the post describes a *playable* thing.
 */
const HN_GAME_NOISE = /\b(?:game\s+)?(?:engines?|toolkits?|sdk|sdks|frameworks?|platforms?|databases?|director(?:y|ies)|marketplaces?|servers?|wiki|apis?|libraries|library|ide|editors?|builders?|hosting|streaming|playtester|db|datasets?|boilerplate|templates?|starters?)\b|\bgame\s+(?:dev(?:elopment)?|design|jams?|industry|studios?)\b/i;
const HN_GAME_GENRE = /\b(?:roguelike|roguelite|puzzlers?|arcade|shooters?|rpg|platformers?|metroidvania|idle|incremental|tower\s+defense|bullet\s+hell|speedrun|trivia|anagram|tetris|pong|breakout|maze|dungeon|tycoon|simulation|visual\s+novel|fighting|racing|geo\s*guessr|wordle|balatro|tamagotchi|chess|solitaire|mahjong|match[- ]?3|text\s+adventure|interactive\s+fiction|city\s+builder|deck[- ]?build\w*|crafting|multiplayer|rhythmi\w*)\b|\b(?:web|browser|online|video|mobile|indie|retro|strategy|word|card|board|dice|puzzle|guessing|matching|flying|golf|pen|tank|physics|programming|optimization|art|music|math|logic)\s+games?\b/i;
const HN_GAME_STOPWORDS = new Set([
  'for', 'the', 'a', 'an', 'of', 'this', 'that', 'and', 'or', 'in', 'on', 'to', 'with', 'by', 'how',
  'are', 'is', 'as', 'at', 'from', 'into', 'around', 'per', 'no', 'more', 'than', 'like', 'my',
  'your', 'our', 'their', 'its', 'it', 'any', 'all', 'new', 'free', 'open', 'first', 'last', 'next',
  'other', 'another', 'some', 'such', 'both', 'each', 'every', 'most', 'many', 'much', 'few', 'less',
  'own', 'same', 'only', 'just', 'also', 'even', 'still', 'yet', 'so', 'but', 'if', 'when', 'where',
  'which', 'who', 'what', 'why', 'because', 'while', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'over', 'through', 'against', 'about', 'across', 'along', 'among', 'behind',
  'beyond', 'within', 'without', 'steam', 'pc', 'console', 'ios', 'android', 'desktop', 'gamers',
]);
const HN_SENTENCE_START = /^(?:i|we|my|our|the|a|an|this|that|it|how|why|what|when|building|making|built|made|introducing|announcing|show)\b/i;
// Names that are pure description rather than a name.
const HN_NAME_STOPWORDS = new Set([
  'ai-powered', 'ai', 'new', 'my', 'the', 'a', 'an', 'this', 'free', 'daily', 'web', 'browser',
  'online', 'multiplayer', 'open', 'source', 'open-source', 'video', 'mobile', 'indie', 'retro',
]);
// Same idea, but only the *first* word has to be generic for the whole phrase to
// be a description ("AI-Powered Word Guessing Game" is not a name).
const HN_NAME_PREFIX_STOPWORDS = new Set([
  'ai', 'ai-powered', 'new', 'my', 'the', 'a', 'an', 'daily', 'online', 'web', 'browser', 'free',
  'simple', 'tiny', 'super', 'best', 'ultimate', 'open', 'open-source', 'source', 'another', 'this',
]);
// Most Show HN titles without an en-dash are sentences ("<Name> ported to …").
// Cutting at the first continuation verb keeps the leading name intact.
const HN_NAME_CUT = /\s+(?:ported|built|made|written|created|released|launched|inspired|using|running|rewritten|remade|designed|developed|available)\s+/i;

export function hnLooksLikeGame(title = '') {
  if (HN_GAME_NOISE.test(title)) return false;
  if (HN_GAME_GENRE.test(title)) return true;
  // "a <word> game" is the usual shape of a genuine announcement; "game
  // engine"/"game servers" put the noun first and are already filtered above.
  for (const match of String(title).matchAll(/\b([A-Za-z][A-Za-z0-9'-]*)\s+games?\b/gi)) {
    if (!HN_GAME_STOPWORDS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

export function cleanShowHnTitle(value = '') {
  let title = String(value || '').replace(/^\s*Show\s+HN\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!title) return '';
  // Drop a parenthetical aside ("Below the Root (1984 game) ported to …").
  title = title.replace(/\s*\([^)]{0,40}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const separated = title.match(/^([^–—|]{2,48}?)\s*[–—|]\s+/);
  if (separated) {
    title = separated[1];
  } else {
    title = title.split(HN_NAME_CUT)[0];
    // A single bare token is only usable if it stands alone ("Requirement5,").
    if (!title.includes(' ')) title = title.match(/^([A-Z][A-Za-z0-9][A-Za-z0-9'’._-]{1,30})(?:\s|,|$)/)?.[1] || title;
    // Without an en-dash to delimit the name, anything longer than a short
    // phrase is a description, not a name.
    if (title.split(/\s+/).length > 4) return '';
  }
  title = title.replace(/[,:;.]+$/, '').trim();
  if (HN_SENTENCE_START.test(title)) return '';
  if (HN_NAME_STOPWORDS.has(title.toLowerCase())) return '';
  if (HN_NAME_PREFIX_STOPWORDS.has((title.split(/\s+/)[0] || '').toLowerCase())) return '';
  if (title.length < 2 || title.length > 48) return '';
  if (title.split(/\s+/).length > 6) return '';
  return title;
}

function parseHnJson(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  const hits = Array.isArray(payload?.hits) ? payload.hits : null;
  if (!hits) return null;
  const entries = [];
  const seen = new Set();
  for (const hit of hits) {
    const rawTitle = String(hit?.title || '');
    if (!hnLooksLikeGame(rawTitle)) continue;
    const title = cleanShowHnTitle(rawTitle);
    if (!title) continue;
    const external = String(hit?.url || hit?.story_url || '').trim();
    const url = /^https?:\/\//i.test(external)
      ? external
      : `https://news.ycombinator.com/item?id=${hit.objectID}`;
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, title, gameName: title, date: hit.created_at || '', points: Number(hit.points || 0) });
  }
  return { type: 'hn-listing', entries, children: [] };
}

/**
 * GitHub search returns JSON too. A brand-new repo under `topic:html5-game` is
 * a browser game that exists before any portal has listed it, so the repo name
 * is the game name (slug words re-cased) and the repo URL is the stable
 * identity — homepages come and go.
 */
const ACRONYMS = new Set(['rts', 'rpg', 'fps', 'mmo', 'mmorpg', 'td', 'io', 'vr', 'ar', 'ai', '2d', '3d', 'dx', 'hd', 'xd', 'ui', 'ux', 'pvp', 'pve', 'npc', 'gpu', 'cpu', 'ecs', 'css', 'html', 'js', 'ts', 'wasm', 'gl', 'api', 'os', 'moba', 'jrpg', 'crpg', 'tps']);
const GITHUB_NAME_NOISE = /^(?:test|tests|demo|sample|template|starter|boilerplate|example|examples|my|untitled|game|games|website|site|portfolio|blog|docs?|hello|practice|sandbox|playground|experiments?)$/i;

function titleCaseFromSlug(value = '') {
  return String(value)
    .replace(/[-_.]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (word.length <= 3 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ')
    .trim();
}

function parseGithubJson(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  const items = Array.isArray(payload?.items) ? payload.items : null;
  if (!items) return null;
  const entries = [];
  const seen = new Set();
  for (const item of items) {
    const fullName = String(item?.full_name || '');
    const repo = fullName.split('/').at(-1) || '';
    // A GitHub Pages site is a site, not a game name.
    if (/\.github\.io$/i.test(repo)) continue;
    const title = titleCaseFromSlug(repo);
    const url = String(item?.html_url || '').trim();
    if (!title || title.length < 2 || GITHUB_NAME_NOISE.test(title)) continue;
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, title, gameName: title, date: item.created_at || '', stars: Number(item.stargazers_count || 0) });
  }
  return { type: 'github-listing', entries, children: [] };
}

/**
 * GOG's catalog endpoint returns JSON. The obvious-looking parameter
 * `releaseStatuses=in:new-arrival` does NOT mean "recently released" — it means
 * "recently added to the GOG catalog", which includes back-catalogue titles
 * being ported. Measured on the live feed: the 48 returned products spanned
 * `2023.10.05` to `2026.09.15` (three years), 8 of them were demos, and one was
 * literally titled `TEST TEST TEST`.
 *
 * So the filter lives here rather than in the URL: keep only products released
 * within the last 45 days and drop demos / soundtrack / DLC. That turns the
 * endpoint into a genuine "new PC releases" feed — the same request with the
 * filter applied yields ~23 real new releases and no back-catalogue ports.
 *
 * `nowMs` is a parameter, not a call to `Date.now()`, so the cutoff is testable
 * and matches the clock-injection convention used by the derived-value models.
 */
export const GOG_MAX_AGE_DAYS = 45;
const GOG_TITLE_NOISE = /(?:^|[\s:–—-])(?:demo|test|soundtrack|ost|artbook|art book|season pass|dlc|expansion)(?:$|[\s:–—-])/i;

export function parseGogJson(text, nowMs = Date.now()) {
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  const products = Array.isArray(payload?.products) ? payload.products : null;
  if (!products) return null;
  // GOG reports a release *date*, not an instant. Comparing it against a
  // precise cutoff would make a release exactly N days old pass or fail
  // depending on the hour the scan happened to run, so floor the cutoff to
  // midnight UTC and compare like with like.
  const cutoff = Math.floor((nowMs - GOG_MAX_AGE_DAYS * 86400000) / 86400000) * 86400000;
  const entries = [];
  const seen = new Set();
  for (const product of products) {
    const title = stripHtml(String(product?.title || '')).replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2 || GOG_TITLE_NOISE.test(title)) continue;
    const slug = String(product?.slug || '').trim();
    if (!slug) continue;
    // `releaseDate` is dotted, e.g. "2026.09.15"; Date.parse needs dashes.
    const released = Date.parse(String(product?.releaseDate || '').replace(/\./g, '-'));
    if (!Number.isFinite(released) || released < cutoff) continue;
    const url = `https://www.gog.com/en/game/${slug}`;
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, title, gameName: title, date: new Date(released).toISOString() });
  }
  return { type: 'gog-listing', entries, children: [] };
}

/**
 * Armor Games serves every game as `/play/<id>/<slug>`. The anchors carry the
 * name in a `title=` attribute, but their `data-content` attribute embeds raw
 * HTML — so the tag cannot be scanned with `[^>]*`, which stops at the first
 * `>` inside an attribute value and silently drops most of the page.
 *
 * The portal title cleaner is deliberately NOT used here: it strips a trailing
 * digit to remove list positions, which would turn "Earth Taken 3" into "Earth
 * Taken". Armor Games' own `title=` attribute is already canonical.
 */
const ARMOR_GAMES_LINK = /\/play\/(\d+)\/([a-z0-9][a-z0-9-]*)/i;

function parseArmorGamesHtml(text, baseUrl) {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./, '');
  const seen = new Set();
  const entries = [];
  for (const match of text.matchAll(/<a\b[\s\S]{0,3000}?<\/a>/gi)) {
    const block = match[0];
    const href = block.match(/href=["']([^"']+)["']/i)?.[1] || '';
    const link = href.match(ARMOR_GAMES_LINK);
    if (!link) continue;
    const resolved = normalizeUrl(href, baseUrl);
    if (!resolved) continue;
    let parsed;
    try { parsed = new URL(resolved); } catch { continue; }
    if (parsed.hostname.replace(/^www\./, '') !== baseHost) continue;
    const canonical = `${parsed.origin}/play/${link[1]}/${link[2]}`;
    if (seen.has(canonical)) continue;
    // A clean `title=` wins; the malformed ones (which embed markup) fall back
    // to the slug, which Armor Games keeps human-readable.
    const attributeTitle = block.match(/title=["']([^"'<>]{2,70})["']/i)?.[1] || '';
    const title = stripHtml(attributeTitle).replace(/\s+/g, ' ').trim() || titleCaseFromSlug(link[2]);
    if (!title || title.length < 2) continue;
    const stamp = Number(block.match(/data-timestamp=["'](\d{9,13})["']/i)?.[1] || 0);
    seen.add(canonical);
    entries.push({
      url: canonical,
      title,
      gameName: title,
      date: stamp ? new Date(stamp * 1000).toISOString() : '',
    });
  }
  return { type: 'armorgames-listing', entries, children: [] };
}

export function parseRemoteDocument(text, baseUrl, requestedKind = 'auto') {
  const trimmed = text.trim();
  if (requestedKind === 'itch-listing') return parseItchHtml(text, baseUrl);
  if (LISTING_PROFILES[requestedKind]) return parsePortalHtml(text, baseUrl, requestedKind);
  if (requestedKind === 'steam-feed') return parseSteamFeedXml(text, baseUrl) || { type: 'steam-feed', entries: [], children: [] };
  if (requestedKind === 'press-feed') return parsePressFeedXml(text, baseUrl) || { type: 'press-feed', entries: [], children: [] };
  if (requestedKind === 'hn-listing') return parseHnJson(text) || { type: 'hn-listing', entries: [], children: [] };
  if (requestedKind === 'github-listing') return parseGithubJson(text) || { type: 'github-listing', entries: [], children: [] };
  if (requestedKind === 'gog-listing') return parseGogJson(text) || { type: 'gog-listing', entries: [], children: [] };
  if (requestedKind === 'armorgames-listing') return parseArmorGamesHtml(text, baseUrl);
  if (requestedKind === 'sitemap') return parseSitemapXml(text, baseUrl) || { type: 'sitemap', entries: [], children: [] };
  if (requestedKind === 'feed') return parseFeedXml(text, baseUrl) || { type: 'feed', entries: [], children: [] };
  if (/^<\?xml|<urlset\b|<sitemapindex\b|<rss\b|<feed\b/i.test(trimmed)) {
    return parseSitemapXml(text, baseUrl) || parseFeedXml(text, baseUrl) || { type: 'xml', entries: [], children: [] };
  }
  if (/itch\.io/i.test(baseUrl) || /game_cell|class=["'][^"']*title/i.test(text)) return parseItchHtml(text, baseUrl);
  return { type: 'unknown', entries: [], children: [] };
}

function wordsFromSlug(slug) {
  const stopWords = new Set(['play', 'online', 'game', 'games', 'free', 'unblocked', 'html5', 'browser', 'download', 'new', 'official', 'web', 'guide', 'walkthrough', 'wiki', 'codes']);
  return slug
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_+]+/g, '-')
    .split('-')
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !stopWords.has(word.toLowerCase()));
}

export function deriveGameName(entry) {
  if (entry.title) {
    const cleaned = stripHtml(entry.title)
      .replace(/\s*[|–—-]\s*(play online|itch\.io|free online game|game)$/i, '')
      .replace(/^play\s+/i, '')
      .replace(/\s+(online|unblocked|game)$/i, '')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }

  try {
    const url = new URL(entry.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const slug = segments.at(-1) || url.hostname.split('.')[0];
    return wordsFromSlug(decodeURIComponent(slug))
      .map((word) => word.length <= 3 && word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .trim();
  } catch {
    return '';
  }
}

export function normalizeGameName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(play|online|game|games|free|unblocked|html5|browser)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable, collision-free identifier for a normalised game name.
 *
 * This used to be `base64url(normalizedName).slice(0, 24)`. base64url encodes 3
 * bytes into 4 characters, so 24 characters is exactly 18 bytes — the slice
 * landed on a clean boundary and silently reduced the id to *the first 18
 * characters of the name*. Every pair of games sharing an 18-character prefix
 * got the same id:
 *
 *   "indie game of the year 2025"  -> auto-aW5kaWUgb2YgdGhlIHllYXIg
 *   "indie game of the year 2016"  -> auto-aW5kaWUgb2YgdGhlIHllYXIg
 *
 * The id is not just a display field; it is used as a Map key by
 * `scripts/scan.mjs` (the previous fast-score baseline), `lib/trend-queue.mjs`
 * (which candidates were already selected) and the `fill-*-trends` scripts
 * (result attribution). A collision therefore made distinct games inherit each
 * other's baselines, and could silently drop a candidate from the Trends queue.
 *
 * A hash of the full normalised name cannot collide in practice: 16 hex
 * characters is 64 bits, and the birthday bound for 3000 candidates is ~2.4e-13.
 * The `auto-` prefix keeps these distinguishable from ids that come from
 * somewhere else.
 */
export function candidateId(normalizedName = '') {
  const digest = createHash('sha256').update(String(normalizedName)).digest('hex');
  return `auto-${digest.slice(0, 16)}`;
}

function uniqueEntries(entries, limit) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.url || map.has(entry.url)) continue;
    map.set(entry.url, {
      url: entry.url,
      title: entry.title || '',
      date: entry.date || '',
      // Rank is meaningful for ordered listings (Steam top sellers); keep it so
      // the caller does not have to re-derive position from array order.
      ...(entry.rank ? { rank: entry.rank } : {}),
      // Parsers that already know the exact name (feeds, JSON APIs, portals
      // whose markup carries the title verbatim) say so; only the HTML
      // scrapers that have to guess need `deriveGameName`'s heuristics.
      gameName: entry.gameName || deriveGameName(entry),
    });
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

export async function scanSource(source, options = {}) {
  const maxEntries = Math.min(Math.max(options.maxEntries || 800, 1), 2000);
  const maxChildren = Math.min(Math.max(options.maxChildren || 16, 0), 40);
  const depth = options.depth || 0;
  // One wall-clock budget for the whole source, including every child sitemap,
  // so a wide sitemap index cannot silently overrun a serverless timeout.
  const deadline = options.deadline || Date.now() + Math.max(5_000, Number(options.budgetMs || 60_000));
  const fetched = await safeFetchText(source.url, 0, deadline);
  const parsed = parseRemoteDocument(fetched.text, fetched.finalUrl, source.kind || 'auto');

  if (parsed.type === 'sitemap-index' && depth < 2 && maxChildren > 0) {
    const childUrls = parsed.children.slice(0, maxChildren);
    const childResults = [];
    for (let index = 0; index < childUrls.length; index += 4) {
      if (Date.now() >= deadline) break;
      const chunk = childUrls.slice(index, index + 4);
      const settled = await Promise.allSettled(chunk.map((url) => scanSource(
        { ...source, url, kind: 'sitemap' },
        { maxEntries, maxChildren: 0, depth: depth + 1, deadline },
      )));
      for (const item of settled) if (item.status === 'fulfilled') childResults.push(...item.value.entries);
      if (childResults.length >= maxEntries) break;
    }
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      detectedType: parsed.type,
      entries: uniqueEntries(childResults, maxEntries),
      childSitemaps: childUrls.length,
      scannedAt: new Date().toISOString(),
    };
  }

  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    detectedType: parsed.type,
    entries: uniqueEntries(parsed.entries, maxEntries),
    childSitemaps: 0,
    scannedAt: new Date().toISOString(),
  };
}

export function calculateCandidateScore(candidate) {
  const sources = candidate.sources || [];
  const kinds = new Set(sources.map((source) => source.kind));
  let score = 0;
  for (const kind of kinds) {
    if (kind === 'itch-featured') score += 5;
    else if (kind === 'itch-popular') score += 4;
    else if (['crazygames-new', 'poki-new', 'y8-new', 'gamepix-new', 'lagged-new', 'competitor-sitemap', 'armorgames-new', 'steam-upcoming'].includes(kind)) score += 3;
    else if (['press-new', 'hn-showhn', 'github-game'].includes(kind)) score += 3;
    else if (kind === 'itch-new' || kind === 'feed') score += 2;
    else score += 1;
  }
  if (sources.length >= 3) score += 7;
  else if (sources.length === 2) score += 4;

  const wordCount = candidate.gameName.trim().split(/\s+/).filter(Boolean).length;
  if (candidate.gameName.length >= 5 && candidate.gameName.length <= 45 && wordCount >= 1 && wordCount <= 6) score += 2;
  if (/^(game|online game|new game|untitled)$/i.test(candidate.gameName)) score -= 5;
  const dates = sources.map((source) => Date.parse(source.date || '')).filter(Number.isFinite);
  if (dates.length && Date.now() - Math.max(...dates) < 3 * 86400000) score += 2;
  return Math.max(0, Math.min(20, score));
}

export function candidateLevel(score) {
  if (score >= 12) return 'hot';
  if (score >= 7) return 'verify';
  return 'watch';
}
