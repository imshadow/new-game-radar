// Health checks for a scan report.
//
// The failure this exists to catch: upstream ran a green job for seven weeks
// while verifying nothing, because quota exhaustion, a missing API key, and a
// skipped provider all only wrote a log line. A log line is invisible on the run
// page and needs authenticated log access to read, so nobody noticed.
//
// Every check here is derived from `data/latest-report.json` alone, which keeps
// it testable and keeps it working when a provider is added or removed.

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

  if (number(report.seoErrors) > 0) {
    findings.push(finding('warning', `seoErrors = ${report.seoErrors}`, '有候选的 SEO 判定落在 error 状态。'));
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
