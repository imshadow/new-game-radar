// Health checks for a scan report.
//
// The failure this exists to catch: upstream ran a green job for seven weeks
// while verifying nothing, because quota exhaustion, a missing API key, and a
// skipped provider all only wrote a log line. A log line is invisible on the run
// page and needs authenticated log access to read, so nobody noticed.
//
// Every check here is derived from `data/latest-report.json` alone, which keeps
// it testable and keeps it working when a provider is added or removed.

import { reverifyDemand, reverifyDays } from './seo-freshness.mjs';

const LEVEL_ORDER = { error: 0, warning: 1, notice: 2 };

function finding(level, title, detail) {
  return { level, title, detail };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function evaluateHealth(report = {}, options = {}) {
  const findings = [];
  const counts = report.recommendationCounts || {};
  const serperVerification = report.serperVerification || {};
  const serperUsage = report.serperUsage || {};
  const searchApi = report.searchApiTrendsVerification || {};

  if (report.serperConfigured !== true) {
    findings.push(finding(
      'error',
      'Serper 未配置：SEO 验证链完全关闭',
      '没有 SERPER_API_KEY 时 verify-serper.mjs 只打印一行日志然后 exit 0，候选会永远停在 pending。',
    ));
  } else {
    if (serperVerification.quotaStopped === true) {
      findings.push(finding(
        'error',
        'Serper 额度已耗尽：本轮零验证',
        `quotaStopped 为 true，本轮 verified=${number(serperVerification.verified)}。上游就是这样连绿了 7 周。`,
      ));
    }
    const queueSize = number(serperVerification.queueSize);
    const verified = number(serperVerification.verified);
    const errors = number(serperVerification.errors);
    if (queueSize > 0 && verified === 0 && errors === 0 && serperVerification.quotaStopped !== true) {
      findings.push(finding(
        'warning',
        '有待验证队列但本轮一个都没验',
        `queueSize=${queueSize} 而 verified=0、errors=0，属于静默空转。`,
      ));
    }
    if (errors > 0) {
      findings.push(finding(
        'warning',
        `Serper 本轮有 ${errors} 个请求失败`,
        '额度耗尽会走 quotaStopped 分支，所以这些是其他错误：超时、401、或响应格式变化。',
      ));
    }

    const totalLimit = number(serperUsage.totalLimit);
    const totalUsed = number(serperUsage.totalUsed);
    const dayUsed = number(serperUsage.dayUsed);
    const dailyLimit = number(serperUsage.dailyLimit);
    if (totalLimit > 0) {
      const ratio = totalUsed / totalLimit;
      if (ratio >= 0.9) {
        findings.push(finding(
          'warning',
          `Serper 总额度已用 ${(ratio * 100).toFixed(1)}%`,
          `totalUsed=${totalUsed}/${totalLimit}。免费额度是一次性的，用完不会重置。`,
        ));
      }
      if (dayUsed > 0) {
        const daysLeft = (totalLimit - totalUsed) / dayUsed;
        if (daysLeft < 7) {
          findings.push(finding(
            'warning',
            `按当前日消耗，Serper 额度只剩约 ${daysLeft.toFixed(1)} 天`,
            `日消耗 ${dayUsed}，剩余 ${totalLimit - totalUsed}。`,
          ));
        }
      }
    }
    if (dailyLimit > 0 && dayUsed >= dailyLimit) {
      findings.push(finding(
        'notice',
        '当日 Serper 额度已用尽（预期行为）',
        `dayUsed=${dayUsed}/${dailyLimit}。额度按 UTC 日重置，即北京时间 08:00。`,
      ));
    }
  }

  // 免费 SEO 路径的拦截率。这条规则是实测驱动的：2026-09-17 在 GitHub Actions
  // 上跑 run #16，19 次尝试里 18 次被 DuckDuckGo 拦（95%），只有 1 次拿到结论。
  // 免费路径的失败模式很特别 —— 它不花钱，所以「失败」看起来是免费的；但代价
  // 是真实的：一批候选被打上失败标记、每轮白等 850ms×N，下一轮再换一批重来。
  // 所以拦截必须单独报出来，而且要和「真的验证失败」分开。
  const freePath = report.seoFreePath || {};
  const seoBlocked = number(report.seoBlocked ?? freePath.blocked);
  const seoAttempted = number(freePath.attempted);
  if (seoBlocked > 0) {
    const blockedRatio = seoAttempted > 0 ? seoBlocked / seoAttempted : 1;
    findings.push(finding(
      blockedRatio >= 0.5 ? 'error' : 'warning',
      `免费 SEO 路径本轮被拦截 ${seoBlocked}/${seoAttempted} 次`,
      (number(freePath.abortedAfter) > 0
        ? `连续被拦 ${number(freePath.abortedAfter)} 次后已自动熔断，剩余候选本轮没再尝试。`
        : '还没触发熔断。')
        + 'html.duckduckgo.com 是未公开的抓取目标，对云厂商 IP 段直接返回挑战页；'
        + '被拦的候选只写了 classification:pending + blocked 标记，没有变成假的失败结论。'
        + '回退方式不用推代码：Run workflow 把 free_seo_verify_limit 选 0；'
        + '或者配 BRAVE_SEARCH_API_KEY 走 Brave 独立索引；或者加 Serper 账号。',
    ));
  }

  if (freePath.skipped === true) {
    findings.push(finding(
      'notice',
      '免费 SEO 路径正在退避，本轮没试',
      `上一轮被拦截占多数，scan.mjs 整体退避到 ${freePath.blockedUntil || '未知时间'}`
        + '（存在 data/state.json 的 seoFreePathBlockedUntil）。这是预期行为不是故障：'
        + '继续试只会拿队列最前面的高优先级候选去撞墙，撞完还要等 12 小时冷却。'
        + '一旦有一轮不再被拦，退避会自动解除。',
    ));
  }

  // 「本轮失败」和「池子里有多少 error 候选」是两个问题，必须读两个字段。
  // 它们以前共用一个字段名 seoErrors：scan.mjs 写本轮值、verify-serper.mjs 写全池值，
  // 报告按 {...report, ...} 写、后写者赢 ⇒ 注解拿全池数字说成「本轮」。
  // 现在 verify-serper.mjs 写 seoErrorCandidates，名字分开了。
  if (number(report.seoErrors) > 0) {
    findings.push(finding(
      'warning',
      `本轮免费 SEO 路径有 ${number(report.seoErrors)} 次真实失败`,
      '这是**本轮**的次数（scan.mjs 每轮重算），不含被拦截的 —— 那些算在 seoBlocked 里。'
        + '真实失败通常是超时、HTTP 非 200、或响应格式变了。',
    ));
  }

  if (number(report.seoErrorCandidates) > 0) {
    findings.push(finding(
      'warning',
      `池子里有 ${number(report.seoErrorCandidates)} 个候选的 SEO 判定是 error`,
      '这是**全池存量**（verify-serper.mjs 统计），不是本轮失败次数。'
        + 'error 候选不会进推荐，但仍在 Serper 队列里（needsSeo 对 error 返回 true），'
        + '额度恢复后会被重新验证 —— 所以它更像待办，不像故障。',
    ));
  }

  // The budget question, answered from the report instead of from intuition.
  //
  // A SERP verdict expires. Once it does, the word is back in the queue — so the
  // daily quota is not a "how many new games appeared today" budget, it is a
  // "keep every verified word fresh" budget. If re-verification alone costs more
  // than the daily quota, the scanner can never catch up, and the more
  // successfully it verifies, the further behind it gets. That is a structural
  // dead end, and it used to be completely invisible: the job stayed green.
  const seoClassificationCounts = report.seoClassificationCounts || {};
  const dailyLimit = number(serperUsage.dailyLimit);
  const reverifyCost = reverifyDemand(seoClassificationCounts);
  const verifiedPool = Object.values(seoClassificationCounts).reduce((sum, count) => sum + number(count), 0);
  if (dailyLimit > 0 && reverifyCost > 0) {
    const windows = reverifyDays();
    const windowSummary = `page/independent ${windows.page}天、watch ${windows.watch}天、reject ${windows.reject}天`;
    const spare = dailyLimit - reverifyCost;
    if (reverifyCost >= dailyLimit) {
      findings.push(finding(
        'error',
        `重验账单已吃掉全部 Serper 额度（${reverifyCost.toFixed(0)}/${dailyLimit} 次/天）`,
        `已验池 ${verifiedPool} 个词的保鲜期（${windowSummary}）需要 ${reverifyCost.toFixed(0)} 次/天，`
          + `而日额度只有 ${dailyLimit}。留给新词的额度为 ${Math.max(0, spare).toFixed(0)} —— `
          + '这意味着积压永远清不完，且每多验成功一个词就更吃紧。'
          + '要么加 Serper 账号（池已支持 SERPER_API_KEY_2.._5），要么调大 SERPER_REVERIFY_DAYS_* 。',
      ));
    } else if (reverifyCost > dailyLimit * 0.6) {
      findings.push(finding(
        'warning',
        `重验账单占掉 Serper 额度的 ${(reverifyCost / dailyLimit * 100).toFixed(0)}%`,
        `已验池 ${verifiedPool} 个词，保鲜期 ${windowSummary}，重验需 ${reverifyCost.toFixed(0)} 次/天，`
          + `日额度 ${dailyLimit}，留给新词 ${spare.toFixed(0)} 次/天。`
          + '仍能推进，但新词吞吐被压缩，积压消化会很慢。',
      ));
    } else {
      findings.push(finding(
        'notice',
        `重验账单 ${reverifyCost.toFixed(0)}/${dailyLimit} 次/天，留给新词 ${spare.toFixed(0)} 次/天`,
        `已验池 ${verifiedPool} 个词，保鲜期 ${windowSummary}。`,
      ));
    }
  }

  const trendProviders = [];
  if (report.serpApiConfigured === true) trendProviders.push('SerpApi');
  if (report.searchApiConfigured === true) trendProviders.push('SearchApi');
  if (options.trendFreePathEnabled === true) trendProviders.push('google-trends-api（免费）');
  if (report.apifyTrendsUsage?.enabled === true) trendProviders.push('Apify');
  if (trendProviders.length === 0) {
    findings.push(finding(
      'warning',
      '没有任何趋势数据来源可用',
      'keywordFreshness 只由趋势验证产出，所以 independent 在结构上不可达。',
    ));
  }
  if (searchApi.enabled === true && searchApi.configured === false) {
    findings.push(finding(
      'notice',
      'SearchApi 开关已打开但未配置密钥，被静默跳过',
      `SEARCHAPI_TRENDS_ENABLED=true 但 configured=false，本轮 requests=${number(searchApi.requests)}。`,
    ));
  }
  // Switching on the keyless path is an experiment: it scrapes an endpoint Google
  // does not publish. "Enabled but verified nothing, while requests failed" is
  // the signal that the experiment failed, and it would otherwise be invisible —
  // the job still goes green.
  if (options.trendFreePathEnabled === true && number(report.trendsVerified) === 0 && number(report.trendErrors) > 0) {
    findings.push(finding(
      'error',
      `免费趋势路径开了但一个都没验成功（${report.trendErrors} 个失败）`,
      'google-trends-api 抓的是未公开接口，Google 会用 429 拒绝突发请求。看候选 trend.lastError 区分限流和网络不通；调大 TRENDS_FREE_DELAY_MS，或把 TRENDS_VERIFY_LIMIT 设回 0 即可回退。',
    ));
  }
  if (number(report.trendPendingCount) > 0 && number(report.trendsVerified) === 0) {
    findings.push(finding(
      'notice',
      `趋势队列还有 ${report.trendPendingCount} 个待验证，本轮验证 0 个`,
      '趋势验证是慢速涓流，本身不是故障；但配合上面的 provider 检查一起看。',
    ));
  }

  if (number(counts.independent) === 0) {
    findings.push(finding(
      'notice',
      'independent = 0',
      number(counts.pending) > 0
        ? `pending ${counts.pending} 个。seoClass 或 fastClass 为 pending 时推荐恒为 pending，该判定排在趋势判定之前，所以 SEO 链没通时趋势通不通都不影响结果。`
        : '没有候选通过全部门槛。',
    ));
  }

  return findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

export function summarizeHealth(findings = []) {
  const summary = { errors: 0, warnings: 0, notices: 0, highest: null };
  for (const item of findings) {
    if (item.level === 'error') summary.errors += 1;
    else if (item.level === 'warning') summary.warnings += 1;
    else summary.notices += 1;
  }
  if (summary.errors > 0) summary.highest = 'error';
  else if (summary.warnings > 0) summary.highest = 'warning';
  else if (summary.notices > 0) summary.highest = 'notice';
  return summary;
}
