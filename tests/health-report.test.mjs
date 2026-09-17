import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, summarizeHealth } from '../lib/health-report.mjs';

function report(overrides = {}) {
  return {
    serperConfigured: true,
    seoErrors: 0,
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
