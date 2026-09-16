import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyGameKeyword, estimateNameRisk } from '../lib/seo-verifier.mjs';
import { calculateFastSignals, FAST_MODEL_VERSION } from '../lib/fast-signals.mjs';
import { SEO_MODEL_VERSION } from '../lib/trend-queue.mjs';
import { POLICY_SETS } from '../lib/source-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const reportPath = path.join(root, 'data', 'latest-report.json');
const LIMIT = Math.max(0, Math.min(50, Number(process.env.SEO_EXPAND_LIMIT || 30)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Declared in lib/source-registry.mjs, alongside every other consumer's copy of
// the same list. See the note there for why these live together.
const STRATEGIC_KINDS = POLICY_SETS.SEO_QUEUE_STRATEGIC;

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function sourceKinds(candidate) {
  return new Set((candidate.sources || []).map((source) => source.kind).filter(Boolean));
}

function needsSeo(candidate) {
  if (candidate.seo?.modelVersion !== SEO_MODEL_VERSION) return true;
  if (candidate.seo?.classification === 'pending') return true;
  if (candidate.seo?.classification === 'error') {
    const checked = Date.parse(candidate.seo?.checkedAt || '');
    return !Number.isFinite(checked) || Date.now() - checked > 12 * 3600000;
  }
  return false;
}

function isUsefulCandidate(candidate) {
  const risk = estimateNameRisk(candidate.gameName || '');
  if (risk > 18) return false;
  const kinds = sourceKinds(candidate);
  const strategic = [...kinds].some((kind) => STRATEGIC_KINDS.has(kind));
  const sourceCount = new Set((candidate.sources || []).map((source) => source.sourceId || source.kind || source.url)).size;
  const age = Date.now() - Date.parse(candidate.firstSeen || 0);
  const recent = Number.isFinite(age) && age <= 5 * 86400000;
  return strategic || sourceCount >= 2 || (recent && Number(candidate.discoveryScore || 0) >= 5 && risk <= 15);
}

function priority(candidate) {
  const kinds = sourceKinds(candidate);
  const sourceCount = new Set((candidate.sources || []).map((source) => source.sourceId || source.kind || source.url)).size;
  let score = Number(candidate.discoveryScore || 0) * 4 + Math.max(0, 24 - estimateNameRisk(candidate.gameName || ''));
  if (kinds.has('trends-rising-7d')) score += 70;
  if (kinds.has('trends-rising-30d')) score += 50;
  if (kinds.has('itch-featured')) score += 35;
  if (kinds.has('itch-popular')) score += 28;
  if (kinds.has('steam-popular-new')) score += 25;
  if (kinds.has('newgrounds-top')) score += 20;
  if (sourceCount >= 2) score += 20;
  if (sourceCount >= 3) score += 15;
  const age = Date.now() - Date.parse(candidate.firstSeen || 0);
  if (Number.isFinite(age) && age <= 2 * 86400000) score += 20;
  return score;
}

function refreshPreTrendRecommendation(candidate) {
  const seoClass = candidate.seo?.classification || 'pending';
  const fastClass = candidate.fast?.classification || 'pending';
  if (seoClass === 'error') candidate.recommendation = 'error';
  else if (seoClass === 'reject' || candidate.seo?.entityConflict || ['reject', 'weak'].includes(fastClass)) candidate.recommendation = 'reject';
  else if (fastClass === 'watch') candidate.recommendation = 'watch';
  else candidate.recommendation = candidate.trend ? candidate.recommendation || 'pending' : 'pending';
  if (['reject', 'pending', 'error'].includes(candidate.recommendation)) {
    candidate.finalScore = 0;
    candidate.score = 0;
  }
  candidate.level = candidate.recommendation;
}

const payload = await readJson(candidatesPath, { candidates: [] });
const candidates = Array.isArray(payload) ? payload : payload.candidates || [];
const report = await readJson(reportPath, {});
const queue = candidates
  .filter((candidate) => needsSeo(candidate) && isUsefulCandidate(candidate))
  .sort((a, b) => priority(b) - priority(a) || Date.parse(b.firstSeen || 0) - Date.parse(a.firstSeen || 0))
  .slice(0, LIMIT);

let verified = 0;
let errors = 0;
for (const candidate of queue) {
  try {
    console.log(`Expanded SEO verify: ${candidate.gameName}`);
    candidate.seo = {
      modelVersion: SEO_MODEL_VERSION,
      ...await verifyGameKeyword(candidate.gameName, candidate.discoveryScore || 0),
    };
    candidate.fast = calculateFastSignals(candidate, candidate.fast || {});
    verified += 1;
  } catch (error) {
    candidate.seo = {
      modelVersion: SEO_MODEL_VERSION,
      checkedAt: new Date().toISOString(),
      status: 'error',
      classification: 'error',
      score: 0,
      reasons: [`补充SEO验证失败：${error.message}`],
    };
    candidate.fast = {
      modelVersion: FAST_MODEL_VERSION,
      checkedAt: new Date().toISOString(),
      status: 'pending',
      classification: 'pending',
      score: 0,
      reasons: ['等待SEO验证恢复后重新计算快速热度'],
    };
    errors += 1;
  }
  refreshPreTrendRecommendation(candidate);
  await sleep(850);
}

await fs.writeFile(candidatesPath, JSON.stringify({ ...payload, candidates }, null, 2) + '\n');
await fs.writeFile(reportPath, JSON.stringify({
  ...report,
  seoExpansionLimit: LIMIT,
  seoExpansionQueueSize: queue.length,
  seoExpansionVerified: verified,
  seoExpansionErrors: errors,
  seoVerified: Number(report.seoVerified || 0) + verified,
  seoErrors: Number(report.seoErrors || 0) + errors,
}, null, 2) + '\n');

console.log(`Expanded SEO queue complete: ${verified} verified, ${errors} errors.`);
