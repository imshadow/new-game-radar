import { SITE_TYPE_MODEL_VERSION } from './model-versions.mjs';
import {
  ONLINE_EVIDENCE_KINDS,
  ONLINE_EVIDENCE_SOURCE_IDS,
  WIKI_EVIDENCE_KINDS,
  WIKI_EVIDENCE_SOURCE_IDS,
  POLICY_SETS,
} from './source-registry.mjs';

export { SITE_TYPE_MODEL_VERSION };

// Derived from lib/source-registry.mjs rather than hand-maintained here. These
// sets used to be one of six copies of the same information, and adding a source
// to only some of the six silently down-weighted it.
const ONLINE_SOURCE_IDS = new Set(ONLINE_EVIDENCE_SOURCE_IDS);
const WIKI_SOURCE_IDS = new Set(WIKI_EVIDENCE_SOURCE_IDS);
const ONLINE_KINDS = new Set(ONLINE_EVIDENCE_KINDS);
const WIKI_KINDS = new Set(WIKI_EVIDENCE_KINDS);

const PREMIUM_ONLINE_SOURCE_IDS = POLICY_SETS.SITE_TYPE_PREMIUM_ONLINE_IDS;

const ONLINE_DOMAINS = ['crazygames.com', 'poki.com', 'y8.com', 'gamepix.com', 'lagged.com', 'newgrounds.com', 'armorgames.com'];
const WIKI_DOMAINS = ['store.steampowered.com', 'xbox.com', 'playstation.com', 'epicgames.com'];

function hostname(value = '') {
  try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function matchesDomain(url, domains) {
  const host = hostname(url);
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function canonicalDomain(host) {
  if (!host) return '';
  if (host === 'itch.io' || host.endsWith('.itch.io')) return 'itch.io';
  for (const domain of [...ONLINE_DOMAINS, ...WIKI_DOMAINS]) {
    if (host === domain || host.endsWith(`.${domain}`)) return domain;
  }
  return host;
}

export function sourcePlatformKey(source = {}) {
  const host = canonicalDomain(hostname(source.url));
  if (host) return host;

  const id = String(source.sourceId || source.kind || source.id || '').toLowerCase();
  if (id.startsWith('itch-')) return 'itch.io';
  if (id.startsWith('newgrounds-')) return 'newgrounds.com';
  if (id.startsWith('crazygames-')) return 'crazygames.com';
  if (id.startsWith('poki-')) return 'poki.com';
  if (id.startsWith('y8-')) return 'y8.com';
  if (id.startsWith('gamepix-')) return 'gamepix.com';
  if (id.startsWith('lagged-')) return 'lagged.com';
  if (id.startsWith('steam-')) return 'store.steampowered.com';
  return id || String(source.url || '');
}

export function isOnlineSource(source = {}) {
  return ONLINE_SOURCE_IDS.has(source.sourceId) || ONLINE_KINDS.has(source.kind) || matchesDomain(source.url, ONLINE_DOMAINS);
}

export function isWikiSource(source = {}) {
  return WIKI_SOURCE_IDS.has(source.sourceId) || WIKI_KINDS.has(source.kind) || matchesDomain(source.url, WIKI_DOMAINS);
}

export function classifySiteType(candidate = {}, nowMs = Date.now()) {
  const sources = candidate.sources || [];
  const onlineSources = sources.filter(isOnlineSource);
  const wikiSources = sources.filter(isWikiSource);
  const onlinePlatforms = new Set(onlineSources.map(sourcePlatformKey).filter(Boolean));
  const premiumOnlinePlatforms = new Set(
    onlineSources
      .filter((source) => PREMIUM_ONLINE_SOURCE_IDS.has(source.sourceId))
      .map(sourcePlatformKey)
      .filter(Boolean),
  );
  const premiumOnlineCount = premiumOnlinePlatforms.size;
  const hasWishlistSource = wikiSources.some((source) => source.sourceId === 'steam-top-wishlist' || source.kind === 'steam-top-wishlist');

  let type = 'pending';
  let confidence = 'low';
  let browserPlayable = null;
  let iframeLikely = null;
  let embedStatus = 'unknown';
  const reasons = [];

  if (onlineSources.length) {
    type = 'online';
    confidence = onlinePlatforms.size >= 2 || premiumOnlineCount >= 1 ? 'high' : 'medium';
    browserPlayable = true;
    iframeLikely = null;
    embedStatus = 'needs-check';
    reasons.push(`已在${onlinePlatforms.size}个浏览器游戏平台或HTML5榜单出现`);
    if (premiumOnlineCount) reasons.push(`包含${premiumOnlineCount}个高价值在线游戏平台信号`);
    if (wikiSources.length) reasons.push('同时存在下载版本，但已有浏览器直接可玩证据');
  } else if (wikiSources.length) {
    type = 'wiki';
    confidence = 'high';
    browserPlayable = false;
    iframeLikely = false;
    embedStatus = 'not-applicable';
    if (hasWishlistSource) reasons.push('已进入Steam Top Wishlists，按预发布攻略机会模型评估');
    else reasons.push('已发现Steam或下载型游戏来源，未发现浏览器直接可玩版本');
    if ((candidate.youtube?.videoCount || 0) >= 5) reasons.push('YouTube内容生态适合攻略、Wiki和教程站');
  } else {
    reasons.push('当前来源不足以确认是HTML5在线游戏还是下载型游戏');
  }

  return {
    modelVersion: SITE_TYPE_MODEL_VERSION,
    // `nowMs` is a parameter, not a wall-clock read: this block is a pure
    // function of the candidate's sources, and a fresh timestamp here made
    // `npm run classify` produce a diff on every run even when nothing changed.
    checkedAt: new Date(nowMs).toISOString(),
    type,
    channel: type,
    confidence,
    browserPlayable,
    iframeLikely,
    embedStatus,
    onlineSourceCount: onlineSources.length,
    onlinePlatformCount: onlinePlatforms.size,
    premiumOnlineCount,
    wikiSourceCount: wikiSources.length,
    hasWishlistSource,
    reasons,
  };
}

export function siteTypeLabel(type) {
  return { online: '在线游戏型', wiki: 'Wiki攻略型', pending: '类型待确认' }[type] || '类型待确认';
}
