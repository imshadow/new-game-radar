import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, summarizeHealth } from '../lib/health-report.mjs';

function report(overrides = {}) {
  return {
    serperConfigured: true,
    seoErrors: 0,
    seoErrorCandidates: 0,
    serpApiConfigured: true,
    searchApiConfigured: false,
    apifyTrendsUsage: { enabled: false },
    recommendationCounts: { independent: 2, pending: 0 },
    serperUsage: { totalUsed: 10, totalLimit: 2450, dayUsed: 10, dailyLimit: 80 },
    serperVerification: { queueSize: 10, verified: 10, errors: 0, quotaStopped: false },
    searchApiTrendsVerification: { enabled: false, configured: false, requests: 0 },
    trendPendingCount: 0,
    trendsVerified: 5,
    ...overrides,
  };
}

function levels(findings) {
  return findings.map((item) => item.level);
}
function titles(findings) {
  return findings.map((item) => item.title);
}

test('a healthy report produces no errors and no warnings', () => {
  const summary = summarizeHealth(evaluateHealth(report()));
  assert.equal(summary.errors, 0);
  assert.equal(summary.warnings, 0);
  assert.equal(summary.highest, null);
});

test('a missing Serper key is an error, not a silent skip', () => {
  const findings = evaluateHealth(report({ serperConfigured: false }));
  assert.equal(findings[0].level, 'error');
  assert.match(findings[0].title, /Serper 未配置/);
});

test('quotaStopped is an error, because that is the state upstream sat in for seven weeks', () => {
  const findings = evaluateHealth(report({
    serperVerification: { queueSize: 40, verified: 0, errors: 0, quotaStopped: true },
  }));
  const stopped = findings.find((item) => /额度已耗尽/.test(item.title));
  assert.ok(stopped, 'expected a quotaStopped finding');
  assert.equal(stopped.level, 'error');
});

test('a queue that produced neither successes nor failures is a silent no-op warning', () => {
  const findings = evaluateHealth(report({
    serperVerification: { queueSize: 40, verified: 0, errors: 0, quotaStopped: false },
  }));
  const noop = findings.find((item) => /一个都没验/.test(item.title));
  assert.ok(noop, 'expected a silent no-op finding');
  assert.equal(noop.level, 'warning');
});

test('an exhausted queue is not reported as a silent no-op when quota already explains it', () => {
  const findings = evaluateHealth(report({
    serperVerification: { queueSize: 40, verified: 0, errors: 0, quotaStopped: true },
  }));
  assert.equal(findings.filter((item) => /一个都没验/.test(item.title)).length, 0);
});

test('request errors are reported separately from quota exhaustion', () => {
  const findings = evaluateHealth(report({
    serperVerification: { queueSize: 10, verified: 8, errors: 2, quotaStopped: false },
  }));
  const failure = findings.find((item) => /请求失败/.test(item.title));
  assert.ok(failure);
  assert.equal(failure.level, 'warning');
});

test('crossing 90% of the one-time Serper quota warns before it runs out', () => {
  const findings = evaluateHealth(report({
    serperUsage: { totalUsed: 2300, totalLimit: 2450, dayUsed: 80, dailyLimit: 80 },
  }));
  const nearly = findings.find((item) => /总额度已用/.test(item.title));
  assert.ok(nearly);
  assert.equal(nearly.level, 'warning');
});

test('a burn rate that leaves under a week warns with the projected runway', () => {
  const findings = evaluateHealth(report({
    serperUsage: { totalUsed: 2000, totalLimit: 2450, dayUsed: 100, dailyLimit: 80 },
  }));
  const runway = findings.find((item) => /只剩约/.test(item.title));
  assert.ok(runway, 'expected a runway warning');
  assert.equal(runway.level, 'warning');
});

test('an exhausted daily budget is a notice, because it is the guard working', () => {
  const findings = evaluateHealth(report({
    serperUsage: { totalUsed: 80, totalLimit: 2450, dayUsed: 80, dailyLimit: 80 },
  }));
  const daily = findings.find((item) => /当日 Serper 额度已用尽/.test(item.title));
  assert.ok(daily);
  assert.equal(daily.level, 'notice');
});

test('having no trend provider at all warns that independent is unreachable', () => {
  const findings = evaluateHealth(report({ serpApiConfigured: false, searchApiConfigured: false }));
  const none = findings.find((item) => /没有任何趋势数据来源/.test(item.title));
  assert.ok(none);
  assert.equal(none.level, 'warning');
});

test('the free Google Trends path counts as a trend provider when it is switched on', () => {
  const options = { trendFreePathEnabled: true };
  const off = evaluateHealth(report({ serpApiConfigured: false }), { trendFreePathEnabled: false });
  const on = evaluateHealth(report({ serpApiConfigured: false }), options);
  assert.ok(off.some((item) => /没有任何趋势数据来源/.test(item.title)));
  assert.equal(on.filter((item) => /没有任何趋势数据来源/.test(item.title)).length, 0);
});

test('a free path that is on but verifies nothing is an error, not a green run', () => {
  // Turning on the keyless path is an experiment against an endpoint Google does
  // not publish. If it is on and every request failed, that has to be visible —
  // otherwise the job goes green and the switch looks like it worked.
  const failed = evaluateHealth(
    report({ serpApiConfigured: false, trendsVerified: 0, trendErrors: 3 }),
    { trendFreePathEnabled: true },
  );
  const rule = failed.find((item) => /免费趋势路径开了但一个都没验成功/.test(item.title));
  assert.ok(rule, 'expected the free-path failure to be reported');
  assert.equal(rule.level, 'error');

  // Partial success is progress, not failure.
  const partial = evaluateHealth(
    report({ serpApiConfigured: false, trendsVerified: 2, trendErrors: 3 }),
    { trendFreePathEnabled: true },
  );
  assert.equal(partial.filter((item) => /免费趋势路径开了但一个都没验成功/.test(item.title)).length, 0);

  // Nothing to report when there were no failures at all.
  const quiet = evaluateHealth(
    report({ serpApiConfigured: false, trendsVerified: 0, trendErrors: 0 }),
    { trendFreePathEnabled: true },
  );
  assert.equal(quiet.filter((item) => /免费趋势路径开了但一个都没验成功/.test(item.title)).length, 0);
});

test('an enabled but unconfigured provider is surfaced instead of skipped silently', () => {
  const findings = evaluateHealth(report({
    searchApiTrendsVerification: { enabled: true, configured: false, requests: 0 },
  }));
  const skipped = findings.find((item) => /静默跳过/.test(item.title));
  assert.ok(skipped);
  assert.equal(skipped.level, 'notice');
});

test('a large pending pool explains why independent is still zero', () => {
  const findings = evaluateHealth(report({ recommendationCounts: { independent: 0, pending: 2608 } }));
  const zero = findings.find((item) => item.title === 'independent = 0');
  assert.ok(zero);
  assert.match(zero.detail, /2608/);
  assert.match(zero.detail, /排在趋势判定之前/);
});

test('findings are ordered by severity so the top of the list is the worst thing', () => {
  const findings = evaluateHealth(report({
    serperConfigured: false,
    recommendationCounts: { independent: 0, pending: 5 },
    trendPendingCount: 12,
    trendsVerified: 0,
  }));
  const order = levels(findings).map((level) => ({ error: 0, warning: 1, notice: 2 }[level]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(findings[0].level, 'error');
});

test('summarizeHealth counts each level and reports the highest', () => {
  assert.deepEqual(summarizeHealth([]), { errors: 0, warnings: 0, notices: 0, highest: null });
  const summary = summarizeHealth([
    { level: 'notice' }, { level: 'warning' }, { level: 'notice' },
  ]);
  assert.deepEqual(summary, { errors: 0, warnings: 1, notices: 2, highest: 'warning' });
  assert.equal(summarizeHealth([{ level: 'notice' }, { level: 'error' }]).highest, 'error');
});

test('an empty or absent report degrades to findings instead of throwing', () => {
  assert.doesNotThrow(() => evaluateHealth());
  assert.doesNotThrow(() => evaluateHealth({}));
  const findings = evaluateHealth({});
  assert.ok(findings.length > 0);
  assert.ok(titles(findings).some((title) => /Serper 未配置/.test(title)));
});

// ------------------------------------------------- the Serper budget question

/**
 * "Why is 80 requests a day not enough?" — because a SERP verdict expires, so
 * the quota is not a per-new-game budget, it is a keep-everything-fresh budget.
 * These tests pin the arithmetic that turns a silent structural dead end into a
 * finding on the run page.
 */
test('re-verification eating the whole daily quota is an error, not a green run', () => {
  const findings = evaluateHealth(report({
    serperUsage: { totalUsed: 10, totalLimit: 2450, dayUsed: 10, dailyLimit: 80 },
    // page 600/14 + watch 400/7 + reject 300/30 + independent 100/14 = 117/day
    seoClassificationCounts: { page: 600, watch: 400, reject: 300, independent: 100 },
  }));
  const budget = findings.find((item) => /重验账单已吃掉全部 Serper 额度/.test(item.title));
  assert.ok(budget, 'expected a budget finding, got: ' + titles(findings).join(' | '));
  assert.equal(budget.level, 'error');
  assert.match(budget.detail, /117/);
  assert.match(budget.detail, /80/);
  assert.match(budget.detail, /SERPER_API_KEY_2/);
});

/**
 * The measured pool on 2026-09-17 — 348 serper-verified words — cost 116
 * requests a day under the old global 3-day window, i.e. more than the entire
 * quota, for re-verification alone. Under the tiered windows the same pool costs
 * under 30, which is why the fix was a change of policy rather than more keys.
 */
test('the same pool that used to blow the budget now fits inside it', () => {
  const measured = { page: 175, watch: 93, reject: 44, independent: 36 };
  const findings = evaluateHealth(report({ seoClassificationCounts: measured }));
  const budget = findings.find((item) => /重验账单/.test(item.title));
  assert.equal(budget.level, 'notice');
  assert.match(budget.detail, /30/);
  assert.match(budget.detail, /348/);
});

test('a re-verification bill that only squeezes the budget is a warning', () => {
  const findings = evaluateHealth(report({
    serperUsage: { totalUsed: 10, totalLimit: 2450, dayUsed: 10, dailyLimit: 80 },
    // page 400/14 + watch 250/7 = 64/day, i.e. 80% of the quota.
    seoClassificationCounts: { page: 400, watch: 250 },
  }));
  const budget = findings.find((item) => /重验账单占掉 Serper 额度的/.test(item.title));
  assert.ok(budget, 'expected a warning, got: ' + titles(findings).join(' | '));
  assert.equal(budget.level, 'warning');
  assert.match(budget.detail, /留给新词/);
});

test('a healthy re-verification bill is only a notice', () => {
  const findings = evaluateHealth(report({ seoClassificationCounts: { page: 28, watch: 14 } }));
  const budget = findings.find((item) => /重验账单/.test(item.title));
  assert.ok(budget);
  assert.equal(budget.level, 'notice');
  assert.equal(summarizeHealth(findings).errors, 0);
  assert.equal(summarizeHealth(findings).warnings, 0);
});

test('the budget check scales with the account pool instead of the single key', () => {
  // 117 requests a day is unaffordable on one key and comfortable on four.
  const counts = { page: 600, watch: 400, reject: 300, independent: 100 };
  const single = evaluateHealth(report({ seoClassificationCounts: counts }));
  const pooled = evaluateHealth(report({
    seoClassificationCounts: counts,
    serperUsage: { totalUsed: 10, totalLimit: 9800, dayUsed: 10, dailyLimit: 320 },
  }));
  assert.equal(single.find((item) => /重验账单/.test(item.title)).level, 'error');
  assert.equal(pooled.find((item) => /重验账单/.test(item.title)).level, 'notice');
});

test('a report with no classification breakdown does not invent a budget finding', () => {
  const findings = evaluateHealth(report());
  assert.equal(findings.find((item) => /重验账单/.test(item.title)), undefined);
});

// ------------------------------------------------- 免费 SEO 路径的拦截

/**
 * 实测（2026-09-17，run #16）：GitHub Actions 上 19 次免费路径尝试有 18 次被
 * DuckDuckGo 拦，只有 1 次拿到结论。这条规则存在的理由是「免费路径的失败不要钱」
 * 这个错觉 —— 它不花钱，但代价是真实的：一批候选被打上失败标记、每轮白等
 * 850ms×N，下一轮换一批再来。所以它必须像花钱的路径一样被报出来。
 */
test('被拦截占多数时是 error，并指出已熔断', () => {
  const findings = evaluateHealth(report({
    seoBlocked: 18,
    seoFreePath: { queueSize: 20, attempted: 19, verified: 1, failed: 0, blocked: 18, abortedAfter: 5 },
  }));
  const rule = findings.find((item) => /免费 SEO 路径本轮被拦截/.test(item.title));
  assert.ok(rule, 'expected a block finding, got: ' + titles(findings).join(' | '));
  assert.equal(rule.level, 'error');
  assert.match(rule.detail, /熔断/);
  assert.match(rule.detail, /free_seo_verify_limit/, '要给出不用推代码的回退方式');
});

test('零星拦截只是 warning，并说明还没触发熔断', () => {
  const findings = evaluateHealth(report({
    seoBlocked: 1,
    seoFreePath: { queueSize: 20, attempted: 20, verified: 19, failed: 0, blocked: 1, abortedAfter: 0 },
  }));
  const rule = findings.find((item) => /免费 SEO 路径本轮被拦截/.test(item.title));
  assert.ok(rule);
  assert.equal(rule.level, 'warning');
  assert.match(rule.detail, /还没触发熔断/);
});

test('没有拦截就不出这条规则', () => {
  const findings = evaluateHealth(report({
    seoBlocked: 0,
    seoFreePath: { queueSize: 20, attempted: 20, verified: 20, failed: 0, blocked: 0, abortedAfter: 0 },
  }));
  assert.equal(findings.find((item) => /免费 SEO 路径本轮被拦截/.test(item.title)), undefined);
});

/**
 * seoErrors 是**本轮**的失败次数（scan.mjs 每轮重算后写入），不是全池 error
 * 候选数。这条规则最初把它当成池子里的存量，注解会让人以为池子里有 18 个坏词 ——
 * 正是本仓反复出现的「同一字段被误读」缺陷族。措辞必须说清是本轮。
 */
/**
 * 「本轮失败了几次」和「池子里有多少 error 候选」是两个问题，必须读两个字段。
 * 它们以前共用一个字段名 seoErrors：scan.mjs 写本轮值、verify-serper.mjs 写全池值，
 * 报告按 {...report, ...} 写、后写者赢 ⇒ 注解拿全池数字说成「本轮」。
 */
test('本轮失败次数与全池 error 候选数是两条独立规则', () => {
  const perRun = evaluateHealth(report({ seoErrors: 3, seoErrorCandidates: 0 }));
  const runRule = perRun.find((item) => /本轮免费 SEO 路径有 3 次真实失败/.test(item.title));
  assert.ok(runRule, 'expected the per-run rule, got: ' + titles(perRun).join(' | '));
  assert.equal(runRule.level, 'warning');
  assert.match(runRule.detail, /不含被拦截的/);
  assert.equal(perRun.find((item) => /池子里有/.test(item.title)), undefined,
    '池子里没有 error 候选时不该出全池那条');

  const pooled = evaluateHealth(report({ seoErrors: 0, seoErrorCandidates: 15 }));
  const poolRule = pooled.find((item) => /池子里有 15 个候选的 SEO 判定是 error/.test(item.title));
  assert.ok(poolRule, 'expected the pool-wide rule, got: ' + titles(pooled).join(' | '));
  assert.equal(poolRule.level, 'warning');
  assert.match(poolRule.detail, /全池存量/);
  assert.equal(pooled.find((item) => /本轮免费 SEO 路径/.test(item.title)), undefined,
    '本轮没有失败时不该出本轮那条');

  const quiet = evaluateHealth(report({ seoErrors: 0, seoErrorCandidates: 0 }));
  assert.equal(quiet.filter((item) => /SEO 判定是 error|真实失败/.test(item.title)).length, 0);
});

/**
 * 退避期间 attempted 会是 0。如果没有这条 notice，「0 次尝试」和「静默空转」
 * 在报告里长得一模一样 —— 而这个仓库最贵的一次教训就是「静默空转看起来像正常」。
 */
test('退避期间给 notice，而不是让它看起来像静默空转', () => {
  const findings = evaluateHealth(report({
    seoBlocked: 0,
    seoFreePath: {
      queueSize: 0, attempted: 0, verified: 0, failed: 0, blocked: 0,
      abortedAfter: 0, skipped: true, blockedUntil: '2026-09-18T00:00:00.000Z',
    },
  }));
  const rule = findings.find((item) => /免费 SEO 路径正在退避/.test(item.title));
  assert.ok(rule, 'expected a backoff notice, got: ' + titles(findings).join(' | '));
  assert.equal(rule.level, 'notice');
  assert.match(rule.detail, /2026-09-18T00:00:00\.000Z/);
  assert.match(rule.detail, /自动解除/);
});

test('没在退避就不出退避 notice', () => {
  const findings = evaluateHealth(report({
    seoFreePath: { queueSize: 20, attempted: 20, verified: 20, failed: 0, blocked: 0, abortedAfter: 0, skipped: false },
  }));
  assert.equal(findings.find((item) => /免费 SEO 路径正在退避/.test(item.title)), undefined);
});
