import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateNameRisk, cleanGameName } from '../lib/seo-verifier.mjs';
import { classifySiteType } from '../lib/site-type.mjs';
import { SEO_MODEL_VERSION } from '../lib/trend-queue.mjs';
import { POLICY_SETS } from '../lib/source-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const outputPath = path.join(root, 'data', 'evidence-fallback-diagnostics.json');

// Declared in lib/source-registry.mjs, which is the only place these lists live
// now. These two are deliberately narrower than the FALLBACK_* sets that the
// verifier itself uses — see the note in the registry.
const ONLINE = POLICY_SETS.DIAGNOSE_ONLINE_STRATEGIC;
const WIKI = POLICY_SETS.DIAGNOSE_WIKI_STRATEGIC;

function inc(object, key) { object[key] = (object[key] || 0) + 1; }
function sourceIds(candidate) {
  return [...new Set((candidate.sources || []).flatMap((source) => [source.sourceId, source.kind, source.id]).filter(Boolean))];
}
function hasUsableSeo(candidate) {
  const seo = candidate.seo;
  return Boolean(seo && seo.modelVersion === SEO_MODEL_VERSION && !['pending', 'error'].includes(seo.classification));
}

const payload = JSON.parse(await fs.readFile(candidatesPath, 'utf8'));
const candidates = Array.isArray(payload) ? payload : payload.candidates || [];
const pending = candidates.filter((candidate) => !hasUsableSeo(candidate));
const channelCounts = {};
const fastClassCounts = {};
const sourceCounts = {};
const strategicCounts = {};
const samples = [];

for (const candidate of pending) {
  candidate.siteType = classifySiteType(candidate);
  const channel = candidate.siteType.type || 'pending';
  const ids = sourceIds(candidate);
  const strategic = channel === 'online' ? ONLINE : WIKI;
  const strategicCount = ids.filter((id) => strategic.has(id)).length;
  const fastClass = candidate.fast?.classification || 'missing';
  const platforms = Number(candidate.siteType?.onlinePlatformCount || candidate.fast?.onlinePlatformCount || 0);
  const browserPlayable = Boolean(candidate.siteType?.browserPlayable);
  const nameRisk = estimateNameRisk(cleanGameName(candidate.gameName || ''));

  inc(channelCounts, channel);
  inc(fastClassCounts, `${channel}:${fastClass}`);
  inc(strategicCounts, `${channel}:${strategicCount}`);
  for (const id of ids) inc(sourceCounts, id);

  if (samples.length < 80 && (strategicCount > 0 || platforms > 0 || fastClass === 'pass')) {
    samples.push({
      name: candidate.gameName,
      channel,
      fastClass,
      fastScore: Number(candidate.fast?.score || 0),
      discoveryScore: Number(candidate.discoveryScore || 0),
      platforms,
      browserPlayable,
      nameRisk,
      strategicCount,
      sourceCount: ids.length,
      sourceIds: ids,
    });
  }
}

samples.sort((a, b) => (b.strategicCount * 20 + b.platforms * 15 + b.fastScore) - (a.strategicCount * 20 + a.platforms * 15 + a.fastScore));
const topSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id, count]) => ({ id, count }));

await fs.writeFile(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalCandidates: candidates.length,
  pendingSeo: pending.length,
  channelCounts,
  fastClassCounts,
  strategicCounts,
  topSources,
  samples: samples.slice(0, 50),
}, null, 2) + '\n');

console.log(`Evidence diagnostics written for ${pending.length} pending SEO candidates.`);
