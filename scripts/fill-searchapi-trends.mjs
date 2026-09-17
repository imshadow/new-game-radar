import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeTrendProviderLabel, buildBalancedTrendQueue, trendValidationSummary, TREND_MODEL_VERSION } from '../lib/trend-queue.mjs';
import { TREND_PROFILE_VERSION } from '../lib/trend-verifier.mjs';
import { verifySearchApiTrendDemand, isSearchApiConfigured, getSearchApiUsage } from '../lib/searchapi-trends.mjs';
import { applyFinalRecommendation, recommendationCounts, channelCounts } from '../lib/opportunity-finalizer.mjs';
import { classifySiteType } from '../lib/site-type.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const reportPath = path.join(root, 'data', 'latest-report.json');
const enabled = String(process.env.SEARCHAPI_TRENDS_ENABLED || 'true').toLowerCase() !== 'false';
const verifyLimit = Math.max(0, Math.min(100, Number(process.env.SEARCHAPI_TRENDS_VERIFY_LIMIT || 95)));
const onlineLimit = Math.max(0, Number(process.env.SEARCHAPI_TRENDS_ONLINE_LIMIT || Math.ceil(verifyLimit * 0.7)));
const wikiLimit = Math.max(0, Number(process.env.SEARCHAPI_TRENDS_WIKI_LIMIT || Math.floor(verifyLimit * 0.3)));
const concurrency = Math.max(1, Math.min(5, Number(process.env.SEARCHAPI_TRENDS_CONCURRENCY || 3)));

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

const payload = await readJson(candidatesPath, { candidates: [] });
const candidates = Array.isArray(payload) ? payload : payload.candidates || [];
for (const candidate of candidates) candidate.siteType = classifySiteType(candidate);
const report = await readJson(reportPath, {});
const configured = isSearchApiConfigured();
let usage = await getSearchApiUsage();
const remainingAtStart = Math.max(0, Number(usage.totalLimit || 0) - Number(usage.totalUsed || 0));
const effectiveLimit = Math.min(verifyLimit, remainingAtStart);
const caps = {
  online: Math.min(onlineLimit, effectiveLimit),
  wiki: Math.min(wikiLimit, effectiveLimit),
  flexible: effectiveLimit,
};
const rawQueue = enabled && configured && effectiveLimit > 0 ? buildBalancedTrendQueue(candidates, caps) : [];
const seen = new Set();
const queue = rawQueue.filter((item) => {
  const key = item.candidate.id || item.candidate.normalizedName || item.candidate.gameName;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}).slice(0, effectiveLimit);

let verified = 0;
let errors = 0;
let requests = 0;
let quotaStopped = false;
const channelVerified = { online: 0, wiki: 0, pending: 0 };
const tierCounts = { strong: 0, secondary: 0, strategic: 0 };
const verifiedNames = [];
const errorNames = [];

async function processItem(item) {
  if (quotaStopped) return;
  const candidate = item.candidate;
  const previousTrend = candidate.trend;
  try {
    console.log(`SearchApi Trends fallback [${item.channel}/${item.tier}]: ${candidate.gameName}`);
    const verdict = await verifySearchApiTrendDemand(candidate.gameName, { siteType: item.channel, market: 'US' });
    candidate.trend = {
      ...verdict,
      modelVersion: TREND_MODEL_VERSION,
      profileVersion: TREND_PROFILE_VERSION,
      validationTier: item.tier,
      validationChannel: item.channel,
      validationReason: item.reason,
    };
    verified += 1;
    requests += Number(verdict.apiRequests || 1);
    channelVerified[item.channel] += 1;
    tierCounts[item.tier] += 1;
    verifiedNames.push(candidate.gameName);
  } catch (error) {
    const message = String(error?.message || error);
    if (error.code === 'SEARCHAPI_QUOTA_GUARD' || /credit|quota|limit|requests/i.test(message)) quotaStopped = true;
    const previousIsValid = previousTrend && !['error', 'pending'].includes(previousTrend.classification);
    candidate.trend = previousIsValid
      ? { ...previousTrend, stale: true, lastError: message, lastErrorAt: new Date().toISOString() }
      : { modelVersion: TREND_MODEL_VERSION, profileVersion: TREND_PROFILE_VERSION, checkedAt: new Date().toISOString(), status: 'error', provider: 'searchapi', classification: 'error', score: 0, validationTier: item.tier, validationChannel: item.channel, reasons: [`SearchApi趋势验证失败：${message}`] };
    errors += 1;
    errorNames.push({ name: candidate.gameName, error: message.slice(0, 240) });
  }
  applyFinalRecommendation(candidate);
}

for (let start = 0; start < queue.length && !quotaStopped; start += concurrency) {
  const batch = queue.slice(start, start + concurrency);
  await Promise.all(batch.map(processItem));
}

for (const candidate of candidates) applyFinalRecommendation(candidate);
usage = await getSearchApiUsage();
const trendSummary = trendValidationSummary(candidates);
const trendValidatedCount = trendSummary.validatedCount;
const trendEligibleCount = trendSummary.eligibleCount;
const risingCount = candidates.filter((candidate) => ['rising', 'breakout'].includes(candidate.trend?.classification)).length;
const globalRisingCount = candidates.filter((candidate) => ['rising', 'breakout'].includes(candidate.trend?.globalClassification)).length;
const allPending = buildBalancedTrendQueue(candidates, { online: 9999, wiki: 9999, flexible: 0 });
const pendingByChannel = { online: allPending.filter((item) => item.channel === 'online').length, wiki: allPending.filter((item) => item.channel === 'wiki').length };
const pendingByTier = { strong: 0, secondary: 0, strategic: 0 };
for (const item of allPending) pendingByTier[item.tier] += 1;
const trendProviderCounts = trendSummary.providerCounts;

await fs.writeFile(candidatesPath, JSON.stringify({ ...payload, candidates }, null, 2) + '\n');
await fs.writeFile(reportPath, JSON.stringify({
  ...report,
  trendsVerified: Number(report.trendsVerified || 0) + verified,
  trendErrors: Number(report.trendErrors || 0) + errors,
  trendValidatedCount,
  trendEligibleCount,
  risingCount,
  globalRisingCount,
  trendProvider: activeTrendProviderLabel(),
  trendProviderCounts,
  recommendationCounts: recommendationCounts(candidates),
  channelOpportunityCounts: channelCounts(candidates),
  searchApiConfigured: configured,
  searchApiTrendsUsage: usage,
  searchApiTrendsVerification: {
    enabled,
    configured,
    verifyLimit,
    effectiveLimit,
    remainingAtStart,
    queueSize: queue.length,
    verified,
    errors,
    requests,
    quotaStopped,
    concurrency,
    channelVerified,
    tierCounts,
    pendingByChannel,
    pendingByTier,
    verifiedNames,
    errorNames,
    ranAt: new Date().toISOString(),
  },
}, null, 2) + '\n');

console.log(`SearchApi Trends fallback complete: ${verified} verified, ${errors} errors, ${usage.totalUsed || 0}/${usage.totalLimit || 0} requests used.`);
