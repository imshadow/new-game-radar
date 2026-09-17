/**
 * SEO 结论的「保鲜期」与「是否需要重验」判定 —— 唯一来源。
 *
 * 以前这段判断内联在 scripts/verify-serper.mjs 里，是一条全局 `> 3 * DAY`。
 * 那意味着「已验证池」的稳态上限 = 每天预算 × 3 天：
 *   80 次/天 ⇒ 最多只能维持 240 个词新鲜，而池子里有 3000 个候选。
 * 天花板低于积压量，于是无论跑多久都追不上；更糟的是它自带自限陷阱 ——
 * 每多验成功一个词，就多欠一份重验债，验得越成功，留给新词的额度越少。
 *
 * 实测（2026-09-17）：348 个 serper 已验词的稳态重验需求 = 116 次/天，
 * 而预算只有 80 次/天 —— 即使一个游戏都不新出，也已经超支 145%。
 *
 * 现在按分类分档：结论越稳定，重验越不频繁。
 *   page / independent  14 天   已确认有独立页面/无竞争，格局不会隔夜翻转
 *   watch                7 天   仍在观察，需要跟得紧一些
 *   reject              30 天   已排除，不值得反复付费确认
 *   pending / error      0 天   没结论就是没结论，立刻重试
 *   其他                 3 天   保守兜底，等于旧行为
 */
import { SEO_MODEL_VERSION } from './trend-queue.mjs';

const DAY = 86400000;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 每个分类的重验周期（天）。全部可用环境变量覆盖 —— 调参不需要改代码、
 * 不需要重新推一次（每次推 = 2 次 Vercel 部署）。
 */
export function reverifyDays(env = process.env) {
  const stable = positiveNumber(env.SERPER_REVERIFY_DAYS_PAGE, 14);
  return {
    independent: stable,
    page: stable,
    reject: positiveNumber(env.SERPER_REVERIFY_DAYS_REJECT, 30),
    watch: positiveNumber(env.SERPER_REVERIFY_DAYS_WATCH, 7),
    pending: positiveNumber(env.SERPER_REVERIFY_DAYS_PENDING, 0),
    error: positiveNumber(env.SERPER_REVERIFY_DAYS_ERROR, 0),
    fallback: positiveNumber(env.SERPER_REVERIFY_DAYS_DEFAULT, 3),
  };
}

/** 某个分类的保鲜窗口（毫秒）。未知分类走 fallback，保持旧行为。 */
export function reverifyWindowMs(classification, env = process.env) {
  const days = reverifyDays(env);
  const chosen = Object.prototype.hasOwnProperty.call(days, classification) ? days[classification] : days.fallback;
  return Math.max(0, chosen) * DAY;
}

/**
 * 「临时验证」不是验证。
 *
 * scripts/verify-evidence-fallback.mjs 在 Serper 额度不足时会写一条
 * provider='evidence-fallback'、provisional=true、classification='page' 的结论，
 * 并在自己的 reasons 里明说「Serper额度不足，当前为平台证据临时验证，仍需后续SERP复核」。
 *
 * 但下游是认账的：lib/market-freshness.mjs:95 与 lib/opportunity-finalizer.mjs:189
 * 都按「未真正核验」对待它。而队列这边（needsSeo）却把它当成已验完成 —— 因为
 * provider 不是 'serper+autocomplete'、classification 又是 'page'，两个条件都不命中。
 * 结果：这批词永远拿不到真 SERP 结论，却一直在页面上以 page 展示。
 */
export function isProvisionalSeo(seo) {
  return Boolean(seo && (seo.provisional === true || seo.provider === 'evidence-fallback'));
}

export function needsSeo(candidate, env = process.env, now = Date.now()) {
  const seo = candidate?.seo;
  if (seo?.modelVersion !== SEO_MODEL_VERSION) return true;
  if (isProvisionalSeo(seo)) return true;
  if (seo?.provider === 'serper+autocomplete') {
    const checked = Date.parse(seo.checkedAt || '');
    if (!Number.isFinite(checked)) return true;
    const window = reverifyWindowMs(seo.classification, env);
    // window === 0 表示「永远算过期」（pending/error 就该立刻重试）。
    // 不能只写 `now - checked > window` —— 刚验完时差值为 0，`0 > 0` 为假，
    // 一个没有结论的 verdict 会被当成已完成。
    return window <= 0 || now - checked > window;
  }
  return ['pending', 'error', 'watch'].includes(seo?.classification)
    || ['duckduckgo+autocomplete', 'brave+autocomplete'].includes(seo?.provider)
    || Boolean(seo?.provider?.startsWith('google-cse-'));
}

/**
 * 稳态重验需求（次/天）：给定「已验池」的分类构成，算它每天要花掉多少额度。
 * 这是回答「80 次/天到底够不够」的唯一正确算法 —— 不是数新游戏有几个。
 */
export function reverifyDemand(countsByClassification = {}, env = process.env) {
  const days = reverifyDays(env);
  let demand = 0;
  for (const [classification, count] of Object.entries(countsByClassification)) {
    const window = Object.prototype.hasOwnProperty.call(days, classification) ? days[classification] : days.fallback;
    const total = Number(count) || 0;
    if (window <= 0) { demand += total; continue; }
    demand += total / window;
  }
  return demand;
}

/**
 * 单一保鲜期下的天花板：每天预算 × 保鲜天数 = 能同时维持新鲜的词数。
 * 旧行为（全局 3 天）在 80 次/天下是 240 —— 低于积压量，所以永远追不上。
 */
export function sustainablePoolSize(dailyBudget, windowDays) {
  return Math.floor(positiveNumber(dailyBudget, 0) * positiveNumber(windowDays, 0));
}
