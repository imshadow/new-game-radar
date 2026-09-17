import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateHealth, summarizeHealth } from '../lib/health-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'data', 'latest-report.json');

// GitHub workflow commands need these escapes. Without them a multi-line detail
// truncates the annotation, and a `%` swallows the rest of the line.
function escapeData(value = '') {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(value = '') {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

const report = await readJson(reportPath, {});
const findings = evaluateHealth(report, {
  trendFreePathEnabled: Number(process.env.TRENDS_VERIFY_LIMIT || 0) > 0,
});
const summary = summarizeHealth(findings);

for (const item of findings) {
  const command = item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'notice';
  console.log(`::${command} title=${escapeProperty(item.title)}::${escapeData(item.detail)}`);
}

const heading = summary.highest === 'error'
  ? '雷达健康检查：有阻断性问题'
  : summary.highest === 'warning'
    ? '雷达健康检查：有需要注意的问题'
    : '雷达健康检查：正常';

const lines = [
  `## ${heading}`,
  '',
  `- error ${summary.errors} / warning ${summary.warnings} / notice ${summary.notices}`,
  `- Serper 已配置：${report.serperConfigured === true ? '是' : '否'}`,
  `- Serper 额度：${Number(report.serperUsage?.totalUsed || 0)}/${Number(report.serperUsage?.totalLimit || 0)} 总计，${Number(report.serperUsage?.dayUsed || 0)}/${Number(report.serperUsage?.dailyLimit || 0)} 今日`,
  `- 本轮验证：SEO ${Number(report.serperVerification?.verified || 0)} 个，趋势 ${Number(report.trendsVerified || 0)} 个`,
  `- 推荐分布：${JSON.stringify(report.recommendationCounts || {})}`,
  '',
];

if (findings.length) {
  lines.push('| 级别 | 问题 | 说明 |', '|---|---|---|');
  for (const item of findings) {
    lines.push(`| ${item.level} | ${item.title} | ${item.detail} |`);
  }
} else {
  lines.push('没有发现异常。');
}

const summaryText = lines.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryText);
}
console.log(summaryText);

console.log(`Radar health: ${summary.errors} error, ${summary.warnings} warning, ${summary.notices} notice.`);
