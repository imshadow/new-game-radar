/**
 * Steam 发行日期的解析与「够不够新」判定 —— 唯一来源。
 *
 * 这段逻辑原来住在 lib/steam-discovery.mjs 里，于是只有那条 `steam-listing` 路径
 * （search 页）用得到它。Steam 的两个 RSS 源走的是 lib/scanner.mjs 的
 * `parseSteamFeedXml`，那边写的是 `date: pubDate`、**根本没有 releaseDate 字段**，
 * 所以它们从来没有被年龄过滤过。
 *
 * 实测（2026-09-18，直抓线上 feed）：
 *   steam-feed-newreleases 的 30 条里 29 条超过 180 天，最老 2325 天（2020-05），
 *   标题是 "Free Weekend - Fallout 76" / "Weekend Deal - The Elder Scrolls Franchise"
 *   / "New DLC Available - ROMANCE OF THE THREE KINGDOMS" —— 它是 Steam 的通用促销
 *   feed，不是「新发行 RSS」（config 里的 sourceName 写错了）。
 *   CI 池子里正好躺着这 29 个词（Noita / Squad / Risk of Rain 2 / Deep Rock Galactic
 *   / Raft / SCUM …），全部 recommendation=pending。
 *   steam-feed-topsellers 的 10 条全是 3 天龄，不需要过滤。
 *
 * 为什么单独成一个模块：lib/steam-discovery.mjs 已经 `import ... from './scanner.mjs'`，
 * 依赖方向是单向的。要让 scanner.mjs 也用上这条规则，就不能让 scanner 反过来依赖
 * steam-discovery（成环），只能把共用的部分放到两者下面。
 */

// Steam 的 `popularnew` 是一个 store *section*，不是一个时间窗口：一个游戏卖得好就
// 能在榜上待好几年。所以 `steam-popular-new` / `steam-popular-new-indie` 会把
// Palworld(2024)、Valheim(2021)、Satisfactory(2024) 当新发现反复送上来。
// 实测 run #22：240 次 Serper 验证里有 71 个来自 Steam 列表，其中老游戏只是把一次
// 付费请求花在了下游必然被趋势实体检查拒掉的地方。
//
// 180 天而不是 GOG 的 45 天。以 run #22 的 240 次验证为样本（其中 67 个来自 Steam，
// 67 个都带可解析日期），天龄聚成两簇，中间在 148~185 天处有一段干净的间隔：
// 45 天会砍掉 Endacopia（53 天），而它是那一轮仅有的两个 `page` 之一；365 天仍会
// 放 330 天的标题进来。180 落在间隔里，去掉 67 个中的 24 个（36%）—— 每一个都至少
// 185 天，没有一个还谈得上「新游戏」。
export const STEAM_MAX_AGE_DAYS = 180;

const STEAM_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * 解析 Steam 用过的所有日期写法，返回 **UTC 午夜** 的时间戳；认不出就返回 NaN。
 *
 * 认识的写法：
 *   "Sep 15, 2026"                     英文店面的 `search_released`（美式）
 *   "Sep. 15, 2026"                    同上，月份带点
 *   "30 Jul, 2026"                     非美式区域设置下的 `search_released`（日在前）
 *   "Mon, 14 Sep 2026 17:00:00 -0700"  RSS 的 <pubDate>（RFC-2822）
 *   "2026.09.15"                       点分隔
 *
 * 为什么不用 `Date.parse`：对 "Sep 15, 2026" 它会给出**本机时区的**午夜，于是「够不够
 * 新」的结论取决于跑扫描的机器 —— 正是 tests/determinism.test.mjs 要挡的那类坑。
 * 时区偏移故意忽略（只取日历日再固定成 UTC 午夜）：180 天的窗口差不到一天，而确定性
 * 是硬要求。
 *
 * 认不出的（"Coming soon"、"Q1 2027"、"To be announced"、"2026"、"September 2026"）
 * 一律 NaN，而 NaN 会被下面的过滤器**保留**。
 */
export function parseSteamReleaseDate(value) {
  const text = String(value || '').trim();
  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const month = STEAM_MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) return Date.UTC(Number(named[3]), month, Number(named[2]));
    return NaN;
  }
  // 日在前 + 可选的星期前缀。"30 Jul, 2026" 和
  // "Mon, 14 Sep 2026 17:00:00 -0700" 共用这一条。
  const dayFirst = text.match(/^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (dayFirst) {
    const month = STEAM_MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) return Date.UTC(Number(dayFirst[3]), month, Number(dayFirst[1]));
    return NaN;
  }
  const iso = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return NaN;
}

/**
 * 认不出的日期一律**保留**而不是丢掉："Coming soon"、"Q1 2027"、"To be announced"
 * 正是 Steam 渲染未发行游戏的方式，而 steam-top-wishlist / steam-upcoming-* 存在的
 * 意义就是捞这些。只有「读得出日期**并且**明确够老」的才被过滤掉。
 */
export function isFreshSteamRelease(releaseDate, nowMs = Date.now()) {
  const released = parseSteamReleaseDate(releaseDate);
  if (!Number.isFinite(released)) return true;
  // 发行日期是「日期」不是「时刻」：把截止点向下取整到 UTC 午夜，这样恰好
  // STEAM_MAX_AGE_DAYS 天前发行的标题不会因为扫描跑在几点而忽过忽不过。对齐 parseGogJson。
  const cutoff = Math.floor((nowMs - STEAM_MAX_AGE_DAYS * 86400000) / 86400000) * 86400000;
  return released >= cutoff;
}

export function filterFreshSteamEntries(entries = [], nowMs = Date.now()) {
  return entries.filter((entry) => isFreshSteamRelease(entry?.releaseDate, nowMs));
}
