import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');

/**
 * 这个文件守的是本仓最贵的一族缺陷：**同一个字段名被两个脚本写，后写者赢**。
 *
 * `data/latest-report.json` 是按 `{...report, ...}` 写的，所以任何两个脚本写同一个
 * 字段时，跑得晚的那个说了算 —— 而读的人看到的是一个含义已经变了的数字。这一族
 * 已经出现过 5 次（trendValidatedCount / trendProviderCounts / trendProvider /
 * TRENDS_VERIFY_LIMIT 的反向解读 / seoErrors）。每次的症状都一样：job 全绿、
 * 数字看着正常、但那个数字回答的不是注解声称的问题。
 */

test('seoErrors 只由 scan.mjs 写，且是「本轮」次数', async () => {
  const scan = await read('scripts/scan.mjs');
  const verifier = await read('scripts/verify-serper.mjs');

  assert.match(scan, /let seoVerified=0,seoErrors=0,seoBlocked=0/,
    'scan.mjs 每轮从 0 重算 seoErrors');
  assert.match(scan, /failed:seoErrors/, 'seoFreePath.failed 就是本轮次数');

  // 曾经 verify-serper.mjs 也写 seoErrors（值是全池 error 候选数），跑得更晚所以赢，
  // 于是健康注解拿全池数字说成「本轮」。收口方式：它改写到 seoErrorCandidates。
  const writeLine = verifier.split('\n').find((line) => line.includes('fs.writeFile(reportPath'));
  assert.ok(writeLine, 'verify-serper.mjs 应该还在写报告');
  assert.ok(!/seoErrors/.test(writeLine),
    'verify-serper.mjs 不能再写 seoErrors，否则「本轮」的含义又被全池数字顶掉');
  assert.match(writeLine, /seoErrorCandidates/,
    '全池 error 候选数要写在 seoErrorCandidates 里');
});

/**
 * 判「死代码」必须扫全仓、还要看它是不是被别的脚本 spawn 出来的 —— 只看工作流会
 * 误判。fill-serpapi-quota.mjs 就是这么被误判过一次（fill-serpapi-pool.mjs 按账号
 * runNode 它）。verify-serper.mjs 同理：工作流里只有 verify-serper-pool.mjs，
 * 但后者按账号 spawn 前者。
 */
test('verify-serper.mjs 是活代码：被池化脚本按账号 spawn', async () => {
  const pool = await read('scripts/verify-serper-pool.mjs');
  assert.match(pool, /runNode\('scripts\/verify-serper\.mjs'/,
    'verify-serper-pool.mjs 会 spawn verify-serper.mjs —— 别把它当死代码删掉');
  assert.match(pool, /spawn\(process\.execPath/, 'runNode 的实现');
});

test('seoBlocked 和 seoFreePath 只由 scan.mjs 写', async () => {
  const scripts = await fs.readdir(path.join(root, 'scripts'));
  const writers = [];
  for (const name of scripts.filter((entry) => entry.endsWith('.mjs'))) {
    const source = await read(path.join('scripts', name));
    if (/seoBlocked\s*[,:}]/.test(source) || /seoFreePath\s*:/.test(source)) writers.push(name);
  }
  assert.deepEqual(writers, ['scan.mjs'],
    'seoBlocked / seoFreePath 是 scan.mjs 独占的字段，多一个写者就意味着含义会被顶掉');
});
