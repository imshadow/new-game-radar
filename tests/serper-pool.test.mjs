import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERPER_SLOT_DEFINITIONS,
  aggregateSerperUsage,
  currentUtcDay,
  mergeSerperVerification,
  normalizeSerperUsage,
} from '../lib/serper-pool.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const limits = { totalLimit: 2450, dailyLimit: 80 };

test('currentUtcDay returns the UTC date, not the local date', () => {
  assert.equal(currentUtcDay(Date.parse('2026-09-16T16:47:00Z')), '2026-09-16');
  assert.equal(currentUtcDay(Date.parse('2026-09-16T23:59:59Z')), '2026-09-16');
  assert.equal(currentUtcDay(Date.parse('2026-09-17T00:00:01Z')), '2026-09-17');
});

test('the one-time total survives a day change while the daily counter resets', () => {
  const stored = { totalUsed: 812, day: '2026-09-16', dayUsed: 80, updatedAt: '2026-09-16T16:47:47.804Z' };
  const sameDay = normalizeSerperUsage(stored, { day: '2026-09-16', ...limits });
  assert.equal(sameDay.totalUsed, 812);
  assert.equal(sameDay.dayUsed, 80);

  const nextDay = normalizeSerperUsage(stored, { day: '2026-09-17', ...limits });
  assert.equal(nextDay.totalUsed, 812, 'a one-time allowance must never reset');
  assert.equal(nextDay.dayUsed, 0);
  assert.equal(nextDay.day, '2026-09-17');
});

test('normalizeSerperUsage tolerates a missing or corrupt usage file', () => {
  const empty = normalizeSerperUsage({}, { day: '2026-09-16', ...limits });
  assert.equal(empty.totalUsed, 0);
  assert.equal(empty.dayUsed, 0);
  assert.equal(empty.lastError, null);
  assert.equal(normalizeSerperUsage(undefined, { day: '2026-09-16', ...limits }).totalUsed, 0);
});

test('aggregateSerperUsage sums accounts and scales the limits by account count', () => {
  const day = '2026-09-16';
  const usage = aggregateSerperUsage([
    { id: '1', envName: 'SERPER_API_KEY', usage: { totalUsed: 2450, day, dayUsed: 80 } },
    { id: '2', envName: 'SERPER_API_KEY_2', usage: { totalUsed: 100, day, dayUsed: 20 } },
  ], { day, ...limits });
  assert.equal(usage.configuredSlots, 2);
  assert.equal(usage.totalUsed, 2550);
  assert.equal(usage.dayUsed, 100);
  assert.equal(usage.totalLimit, 4900, 'each account brings its own one-time allowance');
  assert.equal(usage.dailyLimit, 160);
  assert.equal(usage.enabled, true);
  assert.deepEqual(Object.keys(usage.accounts), ['1', '2']);
  assert.equal(usage.accounts['2'].envName, 'SERPER_API_KEY_2');
});

test('aggregateSerperUsage with no accounts reports zero limits, not the single-account limit', () => {
  const usage = aggregateSerperUsage([], { day: '2026-09-16', ...limits });
  assert.equal(usage.enabled, false);
  assert.equal(usage.configuredSlots, 0);
  assert.equal(usage.totalLimit, 0);
  assert.equal(usage.dailyLimit, 0);
  assert.deepEqual(usage.accounts, {});
});

test('aggregateSerperUsage resets only the accounts that crossed the day boundary', () => {
  const usage = aggregateSerperUsage([
    { id: '1', envName: 'SERPER_API_KEY', usage: { totalUsed: 500, day: '2026-09-16', dayUsed: 80 } },
    { id: '2', envName: 'SERPER_API_KEY_2', usage: { totalUsed: 300, day: '2026-09-15', dayUsed: 80 } },
  ], { day: '2026-09-17', ...limits });
  assert.equal(usage.dayUsed, 0);
  assert.equal(usage.totalUsed, 800);
});

function run(slotId, verification, ok = true) {
  return { slotId, envName: `SERPER_API_KEY_${slotId}`, ok, error: ok ? null : 'exit 1', verification };
}

test('mergeSerperVerification sums the per-account results', () => {
  const merged = mergeSerperVerification([
    run('1', { verified: 80, errors: 0, queueSize: 90, verifiedByChannel: { online: 50, wiki: 30, pending: 0 }, verifiedNames: ['a'], quotaStopped: true }),
    run('2', { verified: 12, errors: 3, queueSize: 90, verifiedByChannel: { online: 8, wiki: 4, pending: 0 }, verifiedNames: ['b', 'c'], quotaStopped: false }),
  ], { verifyLimit: 90, onlineLimit: 63, wikiLimit: 27, minPriority: 80 });
  assert.equal(merged.verified, 92);
  assert.equal(merged.errors, 3);
  assert.equal(merged.queueSize, 180);
  assert.deepEqual(merged.verifiedByChannel, { online: 58, wiki: 34, pending: 0 });
  assert.deepEqual(merged.verifiedNames, ['a', 'b', 'c']);
  assert.equal(merged.limit, 90);
});

test('the chain only counts as quota-stopped when every account is stopped', () => {
  const both = mergeSerperVerification([
    run('1', { quotaStopped: true }),
    run('2', { quotaStopped: true }),
  ]);
  assert.equal(both.quotaStopped, true);

  const one = mergeSerperVerification([
    run('1', { quotaStopped: true }),
    run('2', { quotaStopped: false }),
  ]);
  assert.equal(one.quotaStopped, false, 'a healthy account must not be hidden by a dead one');
});

test('mergeSerperVerification keeps the per-account detail alongside the totals', () => {
  const merged = mergeSerperVerification([
    run('1', { verified: 5, errors: 0, quotaStopped: false }),
    run('2', { verified: 0, errors: 0, quotaStopped: true }, false),
  ]);
  assert.equal(merged.accounts['1'].verified, 5);
  assert.equal(merged.accounts['1'].quotaStopped, false);
  assert.equal(merged.accounts['2'].quotaStopped, true);
  assert.equal(merged.accounts['2'].ok, false);
  assert.equal(merged.accounts['2'].error, 'exit 1');
});

test('mergeSerperVerification with no runs produces no totals to merge', () => {
  assert.deepEqual(mergeSerperVerification(), {});
  assert.deepEqual(mergeSerperVerification([], {}), {});
});

test('the pool script carries the previous verification forward when no account is configured', () => {
  // With zero configured slots there is nothing to merge, so the previous
  // verification has to survive instead of being replaced by an empty object.
  const script = fs.readFileSync(path.join(root, 'scripts/verify-serper-pool.mjs'), 'utf8');
  assert.match(script, /\.\.\.\(report\.serperVerification \|\| \{\}\)/);
});

test('every pool slot name matches a secret wired into the workflow', () => {
  // A typo here would silently disable an account: the pool filters out slots
  // whose env var is empty, and an empty env var looks exactly like "not set up".
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/radar.yml'), 'utf8');
  for (const [, envName] of SERPER_SLOT_DEFINITIONS) {
    assert.ok(
      new RegExp(`^\\s*${envName}: \\$\\{\\{ secrets\\.${envName} \\}\\}`, 'm').test(workflow),
      `${envName} is not wired to secrets.${envName} in .github/workflows/radar.yml`,
    );
  }
});

test('the pool passes each account its own key instead of reusing the first', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/verify-serper-pool.mjs'), 'utf8');
  assert.match(script, /SERPER_API_KEY: slot\.key/);
  assert.doesNotMatch(script, /SERPER_API_KEY: slots\[0\]/);
});

function sourceFiles(...dirs) {
  return dirs.flatMap((dir) => fs
    .readdirSync(path.join(root, dir), { recursive: true })
    .map((entry) => path.join(root, dir, String(entry)))
    .filter((file) => file.endsWith('.mjs') && fs.statSync(file).isFile()));
}

test('the Serper limit defaults live in exactly one place', () => {
  // lib/serper-pool.mjs 的注释声称这个测试会扫描「第二份定义」。它以前并不扫 ——
  // 所以 scripts/verify-serper.mjs 里的 2400 一直活着，而它和 lib 里的 2450
  // 写的是同一批字段（totalLimit / dailyLimit 会进 data/serper-usage.json 和报告，
  // 额度展示和健康检查都读它）。注释里的那句承诺现在由这个测试兑现。
  const files = sourceFiles('scripts', 'lib');
  const rels = files.map((file) => path.relative(root, file).replaceAll('\\', '/'));

  // 防「假绿」：先证明扫描范围确实覆盖了这几个已知文件，否则这个守卫等于没跑。
  for (const required of [
    'lib/serper-pool.mjs',
    'scripts/verify-serper.mjs',
    'scripts/verify-serper-pool.mjs',
    'scripts/classify-site-types.mjs',
  ]) {
    assert.ok(rels.includes(required), `${required} 没被扫到 —— 扫描范围不对，守卫会假绿`);
  }

  for (const file of files) {
    const rel = path.relative(root, file).replaceAll('\\', '/');
    const src = fs.readFileSync(file, 'utf8');
    // env 名后面直接跟数字，就是又抄了一份默认值：
    //   process.env.SERPER_TOTAL_LIMIT || 2400
    //   process.env.SERPER_DAILY_LIMIT ?? 80
    // 要拿额度请用 lib/serper-pool.mjs 的 readSerperLimits()。
    assert.doesNotMatch(
      src,
      /SERPER_(?:TOTAL|DAILY)_LIMIT\s*(?:\|\||\?\?)\s*\d/,
      `${rel} 又写了一份 Serper 额度默认值，请改用 lib/serper-pool.mjs 的 readSerperLimits()`,
    );
    if (rel !== 'lib/serper-pool.mjs') {
      assert.doesNotMatch(
        src,
        /SERPER_LIMIT_DEFAULTS/,
        `${rel} 引用了 SERPER_LIMIT_DEFAULTS —— 默认值只应留在 lib/serper-pool.mjs 里`,
      );
    }
  }
});

test('every Serper limit consumer goes through readSerperLimits', () => {
  // 上一个测试挡的是「抄一份新的默认值」，这个挡的是「绕开 readSerperLimits 自己读 env」。
  // 后者更隐蔽：数字可能是对的，但日闸门/总额度的算法（Math.max(1, …)、随账号数
  // 放大）就又分叉了。
  for (const rel of ['scripts/verify-serper.mjs', 'scripts/verify-serper-pool.mjs', 'scripts/classify-site-types.mjs']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(src, /readSerperLimits/, `${rel} 没有用 readSerperLimits()`);
  }
});
