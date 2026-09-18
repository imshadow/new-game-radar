import { FAST_MODEL_VERSION } from './fast-signals.mjs';
import { classifySiteType } from './site-type.mjs';
import { SEO_MODEL_VERSION, TREND_MODEL_VERSION, TREND_PROFILE_VERSION, SITE_TYPE_MODEL_VERSION } from './model-versions.mjs';
import { POLICY_SETS } from './source-registry.mjs';

export { SEO_MODEL_VERSION, TREND_MODEL_VERSION, TREND_PROFILE_VERSION };

const DAY = 86400000;
// Declared in lib/source-registry.mjs. These gate which candidates may spend
// Google Trends quota, so they must list every source that is strong enough to
// justify the request — which is exactly the kind of list that silently rots
// when it is maintained in five places.
const ONLINE_STRATEGIC_KINDS = POLICY_SETS.TREND_ONLINE_STRATEGIC;
const WIKI_STRATEGIC_KINDS = POLICY_SETS.TREND_WIKI_STRATEGIC;
const NAME_ONLY_KINDS = POLICY_SETS.NAME_ONLY_KINDS;

function sourceKinds(candidate) {
  return new Set((candidate.sources || []).map((source) => source.kind || source.sourceId).filter(Boolean));
}

/**
 * 一个候选是不是「只由一个只提供名字的源带来的」。
 *
 * 判据是「**全部**来源都属于 NAME_ONLY_KINDS」—— 只要有任何一个真游戏目录
 * （Steam 列表、itch、press……）也带了它，就照常验证。所以 `Scarlet Skips`
 * （steam-popular-new + trends-rising-*）和 `dear passengers`（steam-top-wishlist
 * + steam-upcoming + trends-rising-*）都不受影响，只有 `kojima horror` 这种
 * 「除了两个趋势查询之外哪儿都没出现过」的词才会被拦。
 *
 * 没有任何来源的候选不算 name-only：那是「还没采到」，不是「采到了但没意义」。
 */
export function isNameOnlySourced(candidate) {
  const kinds = sourceKinds(candidate);
  if (kinds.size === 0) return false;
  for (const kind of kinds) if (!NAME_ONLY_KINDS.has(kind)) return false;
  return true;
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
  // 只由一个「只提供名字」的源带来的候选，不许花趋势额度。
  //
  // 这条规则本来就存在，只是写在了别处：`lib/source-registry.mjs` 早就把这两个
  // kind 标成 `evidence: false`（「单独出现不足以断言 channel」）。但真正在跑的
  // 判定是 `scripts/scan.mjs` 的 `shouldAutoVerify`，它把这两个 kind 列成
  // **花额度的理由**，还在 `verifyPriority` 里给它们 +35 / +25（全函数最大的两笔
  // 加分）。于是「声明」和「执行」是两套，而且执行的那套更粗糙。
  //
  // 放在这里而不是放在 scan.mjs，是因为 `trendEligibleCount` 有 5 个写者
  // （scan / classify-site-types / fill-searchapi / fill-apify / fill-serpapi-*），
  // 它们全都从 `isTrendEligible` 或 `trendValidationSummary` 派生。gate 挂在这一层，
  // 五个写者自动一致；挂在 scan.mjs 里就只是第六套定义。
  if (isNameOnlySourced(candidate)) return false;
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

/**
 * Which trend sources are enabled *right now*.
 *
 * Deliberately separate from `trendProviderCounts`, which answers a historical
 * question: "who produced the trend verdicts we already have". The inherited
 * corpus still carries `provider: 'serpapi'` from upstream, so deriving the
 * active label from the counts advertised a live SerpApi integration while
 * `serpApiConfigured` was false — the report contradicted itself. Three scripts
 * derived it that way, so the derivation lives here instead of in each of them.
 *
 * `google-trends-api` is the keyless path: it is switched on by raising
 * `TRENDS_VERIFY_LIMIT` above zero, not by a secret, so it is gated on that.
 * The default mirrors `scripts/scan.mjs` (3), otherwise "unset" would mean
 * "off" here and "on" there.
 */
/**
 * The keyless `google-trends-api` path is switched on by `TRENDS_VERIFY_LIMIT`,
 * not by a secret.
 *
 * The default is 3 because that is what `scripts/scan.mjs` uses — it is the code
 * that actually decides whether the path runs, so its reading wins.
 * `scripts/report-health.mjs` used to default the same variable to 0, i.e.
 * "unset means off", while `scan.mjs` reads unset as 3, i.e. "unset means on":
 * one env var, two files, opposite readings. Both now call this.
 */
export function isFreeTrendPathEnabled(env = process.env) {
  const limit = Number(env.TRENDS_VERIFY_LIMIT ?? 3);
  return Number.isFinite(limit) && limit > 0;
}

export function enabledTrendProviders(env = process.env) {
  return [
    env.SERPAPI_API_KEY ? 'serpapi' : null,
    env.SEARCHAPI_API_KEY ? 'searchapi' : null,
    env.APIFY_API_TOKEN ? 'apify-data-xplorer' : null,
    isFreeTrendPathEnabled(env) ? 'google-trends-api' : null,
  ].filter(Boolean);
}

/** The report's `trendProvider` label: what is enabled, or null if nothing is. */
export function activeTrendProviderLabel(env = process.env) {
  const providers = enabledTrendProviders(env);
  return providers.length ? providers.join('+') : null;
}

/**
 * 趋势结论的「保鲜期」与「是否需要重查」判定 —— 唯一来源。
 *
 * 这里曾经有两套定义，而且活着的那套更粗糙：
 *   - 本文件的分档（rising/breakout 12 小时、strong/moderate 3 天、weak/none 7 天）
 *     只被同文件的 `classifyTrendTier` 用到，而 `classifyTrendTier` 和
 *     `buildTieredTrendQueue` 在 live 路径上没有任何调用方 —— 只有测试和一个
 *     测量工具在引用它们。
 *   - 每轮真正决定趋势批次的是 `scripts/scan.mjs` 的 `needsTrendCheck`，它是一条
 *     扁平的 `> 1 天`。
 * 于是「结论越稳定、重查越不频繁」只是被声明了，实际跑的是「一律每天重查」。
 *
 * 实测（2026-09-18，合格池 79 个词）：
 *   扁平 1 天 ⇒ 稳态需求 79.0 次/天
 *   分档     ⇒ 稳态需求 51.1 次/天（−35%）
 *   而供给只有 TREND_LIMIT(10) × 约 5 轮/天 = 50 次/天 ⇒ 扁平规则下必然欠账。
 * 这就是 `trendPendingCount` 长期停在 20~30、同时 `trendEligibleCount` 是 79 的原因：
 * 不是新游戏太多，是同一批词每天被重新欠一遍债。
 *
 * 全部可用环境变量覆盖 —— 调参不需要改代码、不需要重新推一次
 * （每次推 = 1 次 Actions + 2 次 Vercel 部署）。
 */
function positiveNumber(value, fallback) {
  // 空字符串要当成「没设置」，不能当成 0：`Number('') === 0`，而 0 在这套语义里是
  // 「永远算过期」。GitHub Actions 里 `VAR: ${{ vars.X }}` 在 X 未定义时正好是空串，
  // 那会把重查窗口悄悄清零、把额度一轮烧光。
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 每个趋势结论的重查周期（天）。0 表示「永远算过期」，即每次都重查。 */
export function trendReverifyDays(env = process.env) {
  const fresh = positiveNumber(env.TREND_REVERIFY_DAYS_FRESH, 3);
  const rising = positiveNumber(env.TREND_REVERIFY_DAYS_RISING, 0.5);
  const quiet = positiveNumber(env.TREND_REVERIFY_DAYS_QUIET, 7);
  return {
    breakout: rising,
    rising,
    strong: fresh,
    moderate: fresh,
    weak: quiet,
    none: quiet,
    pending: positiveNumber(env.TREND_REVERIFY_DAYS_PENDING, 0),
    // 报错的重试窗口比结论短得多：免费源（google-trends-api）会偶发失败，而
    // 5 轮/天意味着 1 小时≈下一轮就重试，比等 12 小时划算。这里保留 1 小时 ——
    // 也就是 scan.mjs 原本在跑的取值；旧 `isTrendDue` 里的 12 小时从来没跑过。
    error: positiveNumber(env.TREND_REVERIFY_DAYS_ERROR, 1 / 24),
    fallback: fresh,
  };
}

/** 某个趋势结论的保鲜窗口（毫秒）。未知结论走 fallback。 */
export function trendReverifyWindowMs(classification, env = process.env) {
  const days = trendReverifyDays(env);
  const chosen = Object.prototype.hasOwnProperty.call(days, classification) ? days[classification] : days.fallback;
  return Math.max(0, chosen) * DAY;
}

/**
 * 一条 trend 结论是否该重查。收口了原先散在两处的判断：
 * `scripts/scan.mjs` 的扁平 1 天，和本文件 `isTrendDue` 的分档。两者现在都走这里。
 */
export function isTrendRecheckDue(trend, nowMs = Date.now(), env = process.env) {
  if (!trend || trend.modelVersion !== TREND_MODEL_VERSION || trend.profileVersion !== TREND_PROFILE_VERSION) return true;

  const nextRetryAt = Date.parse(trend.nextRetryAt || '');
  if (Number.isFinite(nextRetryAt) && nextRetryAt > nowMs) return false;

  const checked = Date.parse(trend.checkedAt || '');
  if (!Number.isFinite(checked)) return true;

  const classification = trend.status === 'error' ? 'error' : (trend.classification || 'pending');
  const window = trendReverifyWindowMs(classification, env);
  // window === 0 表示「永远算过期」（pending/error 就该立刻重试）。
  // 不能只写 `now - checked > window` —— 刚写完时差值为 0，`0 > 0` 为假，
  // 一个没有结论的 verdict 会被当成已完成。
  return window <= 0 || nowMs - checked > window;
}

function isTrendDue(candidate, nowMs = Date.now()) {
  return isTrendRecheckDue(candidate?.trend, nowMs);
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
