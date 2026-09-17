import { FAST_MODEL_VERSION } from './fast-signals.mjs';
import { classifySiteType } from './site-type.mjs';
import { SEO_MODEL_VERSION, TREND_MODEL_VERSION, TREND_PROFILE_VERSION, SITE_TYPE_MODEL_VERSION } from './model-versions.mjs';
import { POLICY_SETS } from './source-registry.mjs';

export { SEO_MODEL_VERSION, TREND_MODEL_VERSION, TREND_PROFILE_VERSION };

const HOUR = 3600000;
const DAY = 86400000;
// Declared in lib/source-registry.mjs. These gate which candidates may spend
// Google Trends quota, so they must list every source that is strong enough to
// justify the request — which is exactly the kind of list that silently rots
// when it is maintained in five places.
const ONLINE_STRATEGIC_KINDS = POLICY_SETS.TREND_ONLINE_STRATEGIC;
const WIKI_STRATEGIC_KINDS = POLICY_SETS.TREND_WIKI_STRATEGIC;

function sourceKinds(candidate) {
  return new Set((candidate.sources || []).map((source) => source.kind || source.sourceId).filter(Boolean));
}

function siteType(candidate) {
  return candidate.siteType?.modelVersion === SITE_TYPE_MODEL_VERSION ? candidate.siteType.type : classifySiteType(candidate).type;
}

// Which candidates may spend scarce Google Trends quota.
//
// This is the single source of truth. `scripts/scan.mjs` uses it to build the
// batch, and `scripts/fill-searchapi-trends.mjs` uses it to report
// `trendValidatedCount`. Reporting the count from a looser predicate is what
// made the report claim 286 validated trends while only 170 candidates were
// eligible to be checked at all — two definitions of one field, and the later
// writer silently won.
export function hasCurrentSeo(candidate) {
  return candidate.seo?.modelVersion === SEO_MODEL_VERSION;
}

export function isFastPassed(candidate) {
  return hasCurrentSeo(candidate)
    && candidate.fast?.modelVersion === FAST_MODEL_VERSION
    && candidate.fast?.classification === 'pass';
}

export function isTrendEligible(candidate) {
  if (!hasCurrentSeo(candidate)) return false;
  if (!['independent', 'page'].includes(candidate.seo?.classification)) return false;
  if (Number(candidate.seo?.score || 0) < 42) return false;
  if (Number(candidate.seo?.nameRisk ?? 30) > 14) return false;
  if (candidate.seo?.entityConflict) return false;
  return isFastPassed(candidate);
}

// `trendEligibleCount`, `trendValidatedCount` and `trendProviderCounts` all
// describe the same population, so they are derived together here instead of by
// three separate filters in three separate scripts. The report used to carry
// `trendValidatedCount: 286` next to `trendEligibleCount: 170` because the
// counter dropped the eligibility filter and the later writer won.
//
// `scripts/classify-site-types.mjs` was a second, independent writer of
// `trendProviderCounts` with its own filter, and it runs *after* the trend
// fillers — so fixing the fillers alone still left `serpapi: 286` beside
// `trendValidatedCount: 120`. Any counter for this population belongs here, not
// in a script, so that the last writer and the right writer stay the same
// writer.
export function trendValidationSummary(candidates = []) {
  const providerCounts = {};
  let eligibleCount = 0;
  let validatedCount = 0;
  for (const candidate of candidates) {
    if (!isTrendEligible(candidate)) continue;
    eligibleCount += 1;
    if (candidate.trend?.modelVersion !== TREND_MODEL_VERSION) continue;
    if (['pending', 'error'].includes(candidate.trend?.classification)) continue;
    validatedCount += 1;
    const provider = candidate.trend?.provider;
    if (provider) providerCounts[provider] = (providerCounts[provider] || 0) + 1;
  }
  return { eligibleCount, validatedCount, providerCounts };
}

function isTrendDue(candidate, nowMs = Date.now()) {
  const trend = candidate.trend;
  if (!trend || trend.modelVersion !== TREND_MODEL_VERSION || trend.profileVersion !== TREND_PROFILE_VERSION) return true;

  const nextRetryAt = Date.parse(trend.nextRetryAt || '');
  if (Number.isFinite(nextRetryAt) && nextRetryAt > nowMs) return false;

  const checked = Date.parse(trend.checkedAt || '');
  if (!Number.isFinite(checked)) return true;
  const age = nowMs - checked;

  // Failed browser/API requests should cool down instead of being retried every hour.
  if (trend.status === 'error' || trend.classification === 'error') return age > 12 * HOUR;

  // Rising terms are time-sensitive and deserve frequent monitoring.
  if (['rising', 'breakout'].includes(trend.classification)) return age > 12 * HOUR;

  // Useful but non-rising demand changes more slowly.
  if (['strong', 'moderate'].includes(trend.classification)) return age > 3 * DAY;

  // Weak/none results should not repeatedly consume scarce provider credits.
  if (['weak', 'none'].includes(trend.classification)) return age > 7 * DAY;

  return age > 3 * DAY;
}

function evidence(candidate, channel) {
  const kinds = sourceKinds(candidate);
  const strategicSet = channel === 'online' ? ONLINE_STRATEGIC_KINDS : WIKI_STRATEGIC_KINDS;
  const strategicKindCount = [...kinds].filter((kind) => strategicSet.has(kind)).length;
  const sourceCount = new Set((candidate.sources || []).map((source) => source.sourceId || source.kind || source.url)).size;
  const youtubeChannels = Number(candidate.youtube?.channelCount || candidate.fast?.youtubeChannels || 0);
  const onlinePlatformCount = Number(candidate.siteType?.onlinePlatformCount || candidate.fast?.onlinePlatformCount || 0);
  return { kinds, strategicKindCount, sourceCount, youtubeChannels, onlinePlatformCount, hasStrategicSource: strategicKindCount > 0 };
}

export function classifyTrendTier(candidate, nowMs = Date.now()) {
  if (candidate.seo?.modelVersion !== SEO_MODEL_VERSION) return null;
  if (!['independent', 'page'].includes(candidate.seo?.classification)) return null;
  if (candidate.seo?.entityConflict) return null;
  if (candidate.fast?.modelVersion !== FAST_MODEL_VERSION) return null;
  if (!isTrendDue(candidate, nowMs)) return null;

  const channel = siteType(candidate);
  if (!['online', 'wiki'].includes(channel)) return null;
  const seoScore = Number(candidate.seo?.score || 0);
  const nameRisk = Number(candidate.seo?.nameRisk ?? 30);
  const fastClass = candidate.fast?.classification;
  const fastScore = Number(candidate.fast?.score || 0);
  const signals = evidence(candidate, channel);
  const age = nowMs - Date.parse(candidate.firstSeen || 0);
  const recent = Number.isFinite(age) && age <= 3 * DAY;

  if (channel === 'online') {
    if (fastClass === 'pass' && seoScore >= 35 && nameRisk <= 18) {
      return { channel, tier: 'strong', reason: '在线平台证据与快速热度均通过' };
    }
    if (fastClass === 'watch' && seoScore >= 35 && nameRisk <= 20 && (signals.onlinePlatformCount >= 1 || signals.hasStrategicSource)) {
      return { channel, tier: 'secondary', reason: '在线搜索意图通过，已有浏览器游戏平台信号' };
    }
    if (signals.hasStrategicSource && seoScore >= 30 && nameRisk <= 22 && ['pass', 'watch', 'weak'].includes(fastClass) && (recent || signals.sourceCount >= 2 || fastScore >= 18)) {
      return { channel, tier: 'strategic', reason: '来自CrazyGames、Poki、Y8、GamePix、Lagged等在线战略来源' };
    }
    return null;
  }

  if (fastClass === 'pass' && seoScore >= 42 && nameRisk <= 14) {
    return { channel, tier: 'strong', reason: 'Wiki搜索意图与快速内容生态均通过' };
  }
  if (fastClass === 'watch' && seoScore >= 44 && nameRisk <= 14 && (signals.hasStrategicSource || signals.sourceCount >= 2 || signals.youtubeChannels >= 2)) {
    return { channel, tier: 'secondary', reason: 'Wiki搜索意图通过，已有攻略或视频扩散信号' };
  }
  if (signals.hasStrategicSource && seoScore >= 38 && nameRisk <= 16 && ['pass', 'watch', 'weak'].includes(fastClass) && (recent || signals.sourceCount >= 2 || signals.youtubeChannels >= 2 || fastScore >= 20)) {
    return { channel, tier: 'strategic', reason: '来自Steam热门、itch热门或其他Wiki战略来源' };
  }
  return null;
}

export function trendQueueScore(candidate, tier, channel = siteType(candidate)) {
  const signals = evidence(candidate, channel);
  const tierBoost = { strong: 300, secondary: 180, strategic: 100 }[tier] || 0;
  let score = tierBoost;
  score += Number(candidate.seo?.score || 0) * 2;
  score += Number(candidate.fast?.score || 0) * 2;
  score += Number(candidate.discoveryScore || 0) * 3;
  score += signals.strategicKindCount * 22;
  score += Math.min(30, signals.sourceCount * 8);
  if (channel === 'online') {
    score += Math.min(60, signals.onlinePlatformCount * 20);
    if (candidate.fast?.onlineSuggestionCount) score += Math.min(30, candidate.fast.onlineSuggestionCount * 8);
  } else {
    score += Math.min(30, signals.youtubeChannels * 5);
    if (candidate.fast?.wikiSuggestionCount) score += Math.min(30, candidate.fast.wikiSuggestionCount * 8);
  }
  const age = Date.now() - Date.parse(candidate.firstSeen || 0);
  if (Number.isFinite(age) && age < 2 * DAY) score += 20;
  return score;
}

function allEligible(candidates) {
  const items = [];
  for (const candidate of candidates) {
    const classified = classifyTrendTier(candidate);
    if (!classified) continue;
    items.push({
      candidate,
      channel: classified.channel,
      tier: classified.tier,
      reason: classified.reason,
      priority: trendQueueScore(candidate, classified.tier, classified.channel),
    });
  }
  return items.sort((a, b) => b.priority - a.priority);
}

export function buildTieredTrendQueue(candidates, caps = { strong: 3, secondary: 3, strategic: 2 }) {
  const groups = { strong: [], secondary: [], strategic: [] };
  for (const item of allEligible(candidates)) groups[item.tier].push(item);
  return [
    ...groups.strong.slice(0, Math.max(0, Number(caps.strong || 0))),
    ...groups.secondary.slice(0, Math.max(0, Number(caps.secondary || 0))),
    ...groups.strategic.slice(0, Math.max(0, Number(caps.strategic || 0))),
  ];
}

export function buildBalancedTrendQueue(candidates, caps = { online: 5, wiki: 2, flexible: 1 }) {
  const items = allEligible(candidates);
  const online = items.filter((item) => item.channel === 'online');
  const wiki = items.filter((item) => item.channel === 'wiki');
  const selected = [
    ...online.slice(0, Math.max(0, Number(caps.online || 0))),
    ...wiki.slice(0, Math.max(0, Number(caps.wiki || 0))),
  ];
  const selectedIds = new Set(selected.map((item) => item.candidate.id || item.candidate.normalizedName));
  const overflow = items.filter((item) => !selectedIds.has(item.candidate.id || item.candidate.normalizedName));
  selected.push(...overflow.slice(0, Math.max(0, Number(caps.flexible || 0))));
  return selected.sort((a, b) => b.priority - a.priority);
}
