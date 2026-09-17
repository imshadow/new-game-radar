#!/usr/bin/env node
/**
 * 一次性维护工具：把 fork 继承来的候选池砍成「我们自己的源现在还在列的词」。
 *
 * 为什么需要它：fork 会连上游的 `data/candidates.json` 一起继承过来。那份池子里
 * 的词带的是**上游的** `lastSeen`，而 lib/persistence.mjs 的保留规则把「14 天内
 * 见过」的词当成新鲜的、不许淘汰 —— 于是一池子跟本仓库毫无关系的词被永久保护，
 * 既占满 3000 上限，又和真正的候选抢 Serper 额度。
 *
 * 判据用 `lastSeen` 而不是 `firstSeen`：一个词就算最早是上游发现的，只要**我们的
 * 源现在还在列它**，它就是活的信号，应该留；反过来，`lastSeen` 停在我们开始跑
 * 之前，说明我们的源从没列过它，那才是该清掉的存量。
 *
 * 用法（默认只报告、不写文件）：
 *   node tools/prune-inherited.mjs --before 2026-09-16T10:00:00Z
 *   node tools/prune-inherited.mjs --before 2026-09-16T10:00:00Z --apply
 *
 * 2026-09-17 实测：--before 2026-09-16T10:00:00Z 时 3000 → 1207（丢弃 1793）。
 * 那个时间点来自 fork 的第一次成功运行（run #3, 2026-09-16T10:31:55Z）；实测
 * `lastSeen` 的小时分布在那之前是干净断开的（09-16T00 有 29 条属于上游）。
 *
 * 写完 candidates.json 后要跑一次 `npm run classify` 重建 dashboard.json 和计数，
 * 然后 `git restore data/latest-report.json` —— classify 会把报告里的
 * serperConfigured / serperUsage 写坏（见项目备忘铁律 11b）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonCompact } from '../lib/persistence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesPath = path.join(root, 'data', 'candidates.json');

/**
 * 按 lastSeen 切分候选。
 *
 * 时间戳缺失或解析失败的按「没见过」处理：宁可清掉，也不要让一条来路不明的记录
 * 因为解析失败而永久赖在池子里 —— 那正是这个工具要修的毛病。
 */
export function partitionByLastSeen(candidates = [], beforeMs = 0) {
  const keep = [];
  const drop = [];
  for (const candidate of candidates) {
    const lastSeen = Date.parse(candidate?.lastSeen || '');
    if (Number.isFinite(lastSeen) && lastSeen >= beforeMs) keep.push(candidate);
    else drop.push(candidate);
  }
  return { keep, drop };
}

function tally(candidates, pick) {
  const counts = {};
  for (const candidate of candidates) {
    const key = pick(candidate) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summaryLine(label, candidates) {
  const byRecommendation = tally(candidates, (candidate) => candidate.recommendation || 'pending');
  const byProvider = tally(candidates, (candidate) => candidate.seo?.provider || 'no-verdict');
  return [
    `${label} ${candidates.length}`,
    `  推荐分布: ${JSON.stringify(byRecommendation)}`,
    `  SEO 来源: ${JSON.stringify(byProvider)}`,
  ].join('\n');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

function parseArgs(argv) {
  const beforeIndex = argv.indexOf('--before');
  return {
    before: beforeIndex >= 0 ? argv[beforeIndex + 1] : null,
    apply: argv.includes('--apply'),
  };
}

async function main(argv) {
  const { before, apply } = parseArgs(argv);
  if (!before) {
    console.error('缺少 --before <ISO 时间>。用法：');
    console.error('  node tools/prune-inherited.mjs --before 2026-09-16T10:00:00Z [--apply]');
    process.exitCode = 1;
    return;
  }
  const beforeMs = Date.parse(before);
  if (!Number.isFinite(beforeMs)) {
    console.error(`--before 不是合法时间：${before}`);
    process.exitCode = 1;
    return;
  }

  const payload = await readJson(candidatesPath, { candidates: [] });
  const candidates = payload.candidates || [];
  const { keep, drop } = partitionByLastSeen(candidates, beforeMs);

  console.log(`切分点: ${new Date(beforeMs).toISOString()}（保留 lastSeen >= 此值）`);
  console.log(summaryLine('保留', keep));
  console.log(summaryLine('丢弃', drop));
  console.log(`合计 ${candidates.length} → ${keep.length}（丢弃 ${drop.length}）`);

  if (!apply) {
    console.log('dry-run：没有写任何文件。确认无误后加 --apply。');
    return;
  }
  if (drop.length === 0) {
    console.log('没有可丢弃的候选，未写入。');
    return;
  }

  await writeJsonCompact(candidatesPath, { ...payload, candidates: keep });
  console.log(`已写入 ${path.relative(root, candidatesPath)}。`);
  console.log('接着跑：npm run classify && git restore data/latest-report.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
