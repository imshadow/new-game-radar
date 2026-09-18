import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrendRecheckDue, trendReverifyDays, trendReverifyWindowMs } from '../lib/trend-queue.mjs';
import { TREND_MODEL_VERSION, TREND_PROFILE_VERSION } from '../lib/model-versions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');

const HOUR = 3600000;
const DAY = 86400000;

// 固定时钟：所有断言都相对它算，否则用例结果会随「跑的那一刻」变化。
const NOW = Date.parse('2026-09-18T12:00:00Z');
// 显式传空 env：这些窗口可以被环境变量覆盖，用例必须与运行者的 shell 无关。
const ENV = {};

function trend(classification, ageMs, overrides = {}) {
  return {
    modelVersion: TREND_MODEL_VERSION,
    profileVersion: TREND_PROFILE_VERSION,
    classification,
    checkedAt: new Date(NOW - ageMs).toISOString(),
    ...overrides,
  };
}

/**
 * 这个文件守的是「趋势结论多久重查一次」—— 它曾经有两套定义，而且活着的那套更粗糙：
 *
 *   - `lib/trend-queue.mjs` 里的分档（rising/breakout 12 小时、strong/moderate 3 天、
 *     weak/none 7 天）只被同文件的 `classifyTrendTier` 用到，而 `classifyTrendTier` /
 *     `buildTieredTrendQueue` 在 live 路径上没有任何调用方 —— 只有测试和一个测量工具
 *     在引用。
 *   - 每轮真正决定趋势批次的是 `scripts/scan.mjs` 的 `needsTrendCheck`，一条扁平 `> 1 天`。
 *
 * 于是「结论越稳定、重查越不频繁」只是被声明了，实际跑的是「一律每天重查」。
 * 实测（2026-09-18，合格池 79 个词）：扁平规则稳态需求 79.0 次/天，分档后 51.1 次/天，
 * 而供给只有 TREND_LIMIT(10) × 约 5 轮 = 50 次/天 —— 扁平规则下必然欠账，这就是
 * `trendPendingCount` 长期停在 20~30 的原因。
 */

test('分档窗口：结论越稳定，重查越不频繁', () => {
  assert.equal(trendReverifyWindowMs('rising', ENV), 12 * HOUR, '上涨中的词时间敏感，要跟紧');
  assert.equal(trendReverifyWindowMs('breakout', ENV), 12 * HOUR);
  assert.equal(trendReverifyWindowMs('strong', ENV), 3 * DAY);
  assert.equal(trendReverifyWindowMs('moderate', ENV), 3 * DAY);
  assert.equal(trendReverifyWindowMs('weak', ENV), 7 * DAY, '「没热度」不该每天花钱再确认一次');
  assert.equal(trendReverifyWindowMs('none', ENV), 7 * DAY);
  assert.equal(trendReverifyWindowMs('pending', ENV), 0, '0 = 永远算过期，立刻重试');
  assert.equal(trendReverifyWindowMs('error', ENV), HOUR);
  assert.equal(trendReverifyWindowMs('没见过的结论', ENV), 3 * DAY, '未知结论走保守兜底');
});

test('strong/moderate 不再每天重查 —— 这是本次修复的核心', () => {
  // 旧行为是扁平 `> 1 天`，79 个合格词的稳态需求就等于 79 次/天，而供给只有 50。
  assert.ok(trendReverifyWindowMs('strong', ENV) > DAY, 'strong 的窗口必须长于 1 天，否则需求又回到 79');
  assert.equal(isTrendRecheckDue(trend('strong', DAY + HOUR), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('moderate', 2 * DAY), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('strong', 3 * DAY + HOUR), NOW, ENV), true);
});

test('rising/breakout 反而比旧规则更勤', () => {
  assert.equal(isTrendRecheckDue(trend('rising', 6 * HOUR), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('rising', 13 * HOUR), NOW, ENV), true, '旧规则要等满 1 天');
  assert.equal(isTrendRecheckDue(trend('breakout', 13 * HOUR), NOW, ENV), true);
});

test('weak / none 七天重查一次', () => {
  assert.equal(isTrendRecheckDue(trend('weak', 3 * DAY), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('none', 3 * DAY), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('weak', 8 * DAY), NOW, ENV), true);
  assert.equal(isTrendRecheckDue(trend('none', 8 * DAY), NOW, ENV), true);
});

test('pending 立刻重查 —— 窗口为 0 时不能只写 `age > window`', () => {
  // 刚写下的 pending 时间差是 0，`0 > 0` 为假，会被当成「已完成」而永远不再查。
  // 这正是 lib/seo-freshness.mjs 里同一个坑，那边也已经写明了。
  assert.equal(isTrendRecheckDue(trend('pending', 0), NOW, ENV), true);
  assert.equal(isTrendRecheckDue(trend('pending', 1), NOW, ENV), true);
});

test('error 一小时后重试，且 status=error 优先于 classification', () => {
  assert.equal(isTrendRecheckDue(trend('error', 30 * 60000), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('error', 2 * HOUR), NOW, ENV), true);
  // scan.mjs 原本先看 status==='error'。留着，否则一次失败会被当成 weak 而压 7 天。
  assert.equal(isTrendRecheckDue(trend('weak', 2 * HOUR, { status: 'error' }), NOW, ENV), true);
  assert.equal(isTrendRecheckDue(trend('weak', 2 * HOUR), NOW, ENV), false);
});

test('没有结论、或结论来自旧模型，一律重查', () => {
  assert.equal(isTrendRecheckDue(undefined, NOW, ENV), true);
  assert.equal(isTrendRecheckDue(null, NOW, ENV), true);
  assert.equal(isTrendRecheckDue({}, NOW, ENV), true);
  assert.equal(isTrendRecheckDue(trend('strong', HOUR, { modelVersion: TREND_MODEL_VERSION + 1 }), NOW, ENV), true);
  assert.equal(isTrendRecheckDue(trend('strong', HOUR, { profileVersion: TREND_PROFILE_VERSION + 1 }), NOW, ENV), true);
  assert.equal(isTrendRecheckDue({ ...trend('strong', HOUR), checkedAt: 'not-a-date' }, NOW, ENV), true);
  assert.equal(isTrendRecheckDue({ ...trend('strong', HOUR), checkedAt: undefined }, NOW, ENV), true);
});

test('nextRetryAt 未到之前不重查', () => {
  const future = new Date(NOW + HOUR).toISOString();
  const past = new Date(NOW - HOUR).toISOString();
  assert.equal(isTrendRecheckDue(trend('strong', 3 * DAY + HOUR, { nextRetryAt: future }), NOW, ENV), false);
  assert.equal(isTrendRecheckDue(trend('strong', 3 * DAY + HOUR, { nextRetryAt: past }), NOW, ENV), true);
});

test('窗口可以被环境变量覆盖 —— 调参不用重新推一次', () => {
  assert.equal(trendReverifyWindowMs('none', { TREND_REVERIFY_DAYS_QUIET: '1' }), DAY);
  assert.equal(trendReverifyWindowMs('weak', { TREND_REVERIFY_DAYS_QUIET: '1' }), DAY);
  assert.equal(trendReverifyWindowMs('strong', { TREND_REVERIFY_DAYS_FRESH: '0.5' }), 12 * HOUR);
  assert.equal(trendReverifyWindowMs('rising', { TREND_REVERIFY_DAYS_RISING: '2' }), 2 * DAY);
  assert.equal(trendReverifyWindowMs('error', { TREND_REVERIFY_DAYS_ERROR: '0' }), 0);
  assert.equal(trendReverifyWindowMs('pending', { TREND_REVERIFY_DAYS_PENDING: '1' }), DAY);
});

test('非法覆盖值退回默认，而不是变成 NaN 让整条队列消失', () => {
  assert.equal(trendReverifyWindowMs('none', { TREND_REVERIFY_DAYS_QUIET: '不是数字' }), 7 * DAY);
  assert.equal(trendReverifyWindowMs('none', { TREND_REVERIFY_DAYS_QUIET: '-1' }), 7 * DAY);
  assert.equal(trendReverifyWindowMs('none', { TREND_REVERIFY_DAYS_QUIET: '' }), 7 * DAY);
  assert.equal(trendReverifyDays({}).fallback, 3);
  assert.ok(!Number.isNaN(trendReverifyWindowMs('strong', { TREND_REVERIFY_DAYS_FRESH: 'abc' })));
});

/**
 * 守卫：这一族缺陷（同一规则两套定义，活着的那套更粗糙）在本仓已经出现过 5 次。
 * 趋势保鲜期是第 6 次，所以这里钉住「定义只能有一处」。
 */
test('趋势保鲜期只有一处定义：scan.mjs 委托给 lib/trend-queue.mjs', async () => {
  const scan = await read('scripts/scan.mjs');

  assert.match(scan, /import\s*\{[^}]*isTrendRecheckDue[^}]*\}\s*from\s*'\.\.\/lib\/trend-queue\.mjs'/,
    'scan.mjs 必须用 lib/trend-queue.mjs 的判定，不能自己再写一套');

  const needsTrendCheck = scan.split('function needsTrendCheck(candidate){')[1]?.split('\n\n')[0] || '';
  assert.match(needsTrendCheck, /isTrendRecheckDue\(/,
    'needsTrendCheck 的主体应该只剩「是否合格 + 委托判定」');
  assert.ok(!/Date\.now\(\)-checked/.test(needsTrendCheck),
    'needsTrendCheck 里不该再有自己算的时间差');
});

test('全仓没有第二处趋势重查窗口定义', async () => {
  const dirs = ['scripts', 'lib'];
  const files = [];
  for (const dir of dirs) {
    for (const name of await fs.readdir(path.join(root, dir))) {
      if (name.endsWith('.mjs')) files.push(path.join(dir, name));
    }
  }
  const offenders = [];
  for (const file of files) {
    if (file === path.join('lib', 'trend-queue.mjs')) continue;
    const source = await read(file);
    if (/const\s+(TREND_MAX_AGE|TREND_ERROR_RETRY)\s*=/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    '趋势保鲜窗口只能定义在 lib/trend-queue.mjs；多一处就是这一族缺陷的第 6 次复发');
});
