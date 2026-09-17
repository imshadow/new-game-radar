import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySiteType, SITE_TYPE_MODEL_VERSION } from '../lib/site-type.mjs';
import { applyFinalRecommendation } from '../lib/opportunity-finalizer.mjs';
import { WIKI_PRELAUNCH_MODEL_VERSION } from '../lib/wiki-prelaunch.mjs';
import { stripDerivedBlocks, buildDashboardPayload, writeJsonCompact } from '../lib/persistence.mjs';
import { candidateId } from '../lib/scanner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const dashboardPath = path.join(root, 'data', 'dashboard.json');
const reportPath = path.join(root, 'data', 'latest-report.json');
const serpUsagePath = path.join(root, 'data', 'serpapi-usage.json');
const serperUsagePath = path.join(root, 'data', 'serper-usage.json');
const apifyStatusPath = path.join(root, 'data', 'apify-account-status.json');
const apifyUsagePath = path.join(root, 'data', 'apify-trends-usage.json');

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

const payload = await readJson(candidatesPath, { candidates: [] });
const candidates = Array.isArray(payload) ? payload : payload.candidates || [];

/**
 * Classify must be a pure function of `data/candidates.json`.
 *
 * It used to read the wall clock, and every derived block stamped a fresh
 * `checkedAt`, so running it twice produced two different files even when the
 * input had not changed. The workflow runs this script three times per cycle,
 * which meant three spurious rewrites of a 10 MB file per run — and made
 * "did anything actually change?" unanswerable from the diff.
 *
 * `updatedAt` is the scan timestamp written by `scripts/scan.mjs`. Deriving the
 * clock from it keeps the freshness windows anchored to when the evidence was
 * gathered, which is also more correct than "whatever time classify happened to
 * run".
 */
const scanNowMs = Date.parse(payload.updatedAt || '');
const nowMs = Number.isFinite(scanNowMs) ? scanNowMs : Date.now();

const counts = { online: 0, wiki: 0, pending: 0 };
const wikiPrelaunchCounts = { priority: 0, prepare: 0, watch: 0, weak: 0 };
const trendProviderCounts = {};
const seoProviderCounts = {};
const recommendationCounts = { independent: 0, 'test-now': 0, page: 0, watch: 0, reject: 0, pending: 0, error: 0 };

for (const candidate of candidates) {
  // Repair ids written by the old truncated-base64 scheme. Candidates are
  // matched by `normalizedName`, not by id, so rewriting an id here cannot
  // duplicate or split a record — it only fixes collisions that already exist
  // in the committed file. This is idempotent: `candidateId` is a pure function
  // of `normalizedName`, which never changes for a given candidate.
  if (candidate.normalizedName) candidate.id = candidateId(candidate.normalizedName);
  candidate.siteType = classifySiteType(candidate, nowMs);
  applyFinalRecommendation(candidate, nowMs);
  counts[candidate.siteType.type] = (counts[candidate.siteType.type] || 0) + 1;
  if (candidate.siteType.type === 'wiki' && candidate.wikiPrelaunch) {
    const classification = candidate.wikiPrelaunch.classification || 'weak';
    wikiPrelaunchCounts[classification] = (wikiPrelaunchCounts[classification] || 0) + 1;
    // Steam愿望单榜用于给SEO验证队列排序，但不直接替代真实SERP验证。
    const routingBoost = Math.min(20, Math.max(0, Math.round(Number(candidate.wikiPrelaunch.score || 0) / 5)));
    candidate.discoveryScore = Math.max(Number(candidate.discoveryScore || 0), routingBoost);
  }
  const trendProvider = candidate.trend?.provider;
  if (trendProvider) trendProviderCounts[trendProvider] = (trendProviderCounts[trendProvider] || 0) + 1;
  recommendationCounts[candidate.recommendation || 'pending'] = (recommendationCounts[candidate.recommendation || 'pending'] || 0) + 1;
  const seoProvider = candidate.seo?.provider;
  if (seoProvider) seoProviderCounts[seoProvider] = (seoProviderCounts[seoProvider] || 0) + 1;
}

for (const candidate of candidates) stripDerivedBlocks(candidate);
await writeJsonCompact(candidatesPath, { ...payload, candidates });
await writeJsonCompact(dashboardPath, buildDashboardPayload(candidates, {
  scannedAt: payload.updatedAt || new Date(nowMs).toISOString(),
  siteTypeCounts: counts,
  recommendationCounts,
}));

const report = await readJson(reportPath, {});
// The report is written as `{...report, ...}`, so a field that is no longer
// produced would otherwise be carried forward forever. These two belonged to
// the removed Google CSE path; drop them so the file converges.
delete report.googleCseConfiguredSlots;
delete report.googleCseUsage;
/**
 * `data/serpapi-usage.json` persists whatever limits were in effect the last
 * time it was written, so lowering `SERPAPI_DAILY_LIMIT` in the workflow left
 * the report advertising the old number while the runtime guard correctly
 * enforced the new one (`lib/trend-verifier.mjs` reads the env and overrides the
 * file). A working fix therefore looked like a no-op to anyone reading the
 * report — which is the whole failure mode the health annotations exist to
 * catch, so the report must not contradict the guard.
 *
 * Derive the limits from the environment on the read path too, exactly as the
 * fallback below already did. Spread the file first so a stale limit can never
 * win over the environment.
 */
const serpApiUsageFile = await readJson(serpUsagePath, { monthUsed: 0, dayUsed: 0, updatedAt: null });
const serpApiUsage = {
  ...serpApiUsageFile,
  monthlyLimit: Math.max(1, Number(process.env.SERPAPI_MONTHLY_LIMIT || 220)),
  dailyLimit: Math.max(1, Number(process.env.SERPAPI_DAILY_LIMIT || 8)),
};
const serperUsage = await readJson(serperUsagePath, {
  totalUsed: 0,
  day: new Date().toISOString().slice(0, 10),
  dayUsed: 0,
  totalLimit: Number(process.env.SERPER_TOTAL_LIMIT || 2400),
  dailyLimit: Number(process.env.SERPER_DAILY_LIMIT || 100),
  updatedAt: null,
  lastError: null,
});
const apifyAccountStatus = await readJson(apifyStatusPath, { configured: Boolean(process.env.APIFY_API_TOKEN), ok: false });
const apifyTrendsUsage = await readJson(apifyUsagePath, { month: new Date().toISOString().slice(0, 7), actorCalls: 0, resultItems: 0, candidatesVerified: 0, errors: 0 });

const activeSeoProvider = process.env.SERPER_API_KEY ? 'serper-google-search' : 'duckduckgo-html';
const activeTrendProviders = Object.keys(trendProviderCounts);
const activeTrendProvider = activeTrendProviders.length > 1
  ? activeTrendProviders.join('+')
  : activeTrendProviders[0] || (process.env.SERPAPI_API_KEY ? 'serpapi' : process.env.APIFY_API_TOKEN ? 'apify-data-xplorer' : null);

await fs.writeFile(reportPath, JSON.stringify({
  ...report,
  trendProvider: activeTrendProvider,
  trendProviderCounts,
  serpApiConfigured: Boolean(process.env.SERPAPI_API_KEY),
  serpApiUsage: { enabled: Boolean(process.env.SERPAPI_API_KEY), ...serpApiUsage },
  apifyConfigured: Boolean(process.env.APIFY_API_TOKEN),
  apifyAccountStatus,
  apifyTrendsUsage,
  seoProvider: activeSeoProvider,
  seoProviderCounts,
  serperConfigured: Boolean(process.env.SERPER_API_KEY),
  serperUsage: { enabled: Boolean(process.env.SERPER_API_KEY), ...serperUsage },
  braveSearchConfigured: false,
  braveSearchUsage: { enabled: false },
  siteTypeModelVersion: SITE_TYPE_MODEL_VERSION,
  siteTypeCounts: counts,
  wikiPrelaunchModelVersion: WIKI_PRELAUNCH_MODEL_VERSION,
  wikiPrelaunchCounts,
  recommendationCounts,
}, null, 2) + '\n');

console.log(`Site type classification complete: ${counts.online} online, ${counts.wiki} wiki, ${counts.pending} pending; Steam prelaunch priority ${wikiPrelaunchCounts.priority}, prepare ${wikiPrelaunchCounts.prepare}; trend providers: ${activeTrendProvider || 'none'}.`);
