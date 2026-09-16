/**
 * One-off measurement: what changes if `steam-top-wishlist` is added to the
 * wiki-side gating sets?
 *
 * The registry now centralises those sets, so the "fix" is a one-line change —
 * but it changes how much Google Trends quota candidates can spend, so the
 * blast radius was measured before the change was made rather than after.
 *
 * NOTE: the fix is now applied, so this script is a no-op against the current
 * registry and will report zero changes. It is kept because the same technique
 * applies to any future scoring change: mutate the set at runtime, diff the
 * derived output over the real payload, and decide with numbers instead of
 * guessing. To re-measure this specific change, remove the tag from the wiki
 * sets in lib/source-registry.mjs first.
 *
 * Result when it was run against the pre-fix registry (3000 real candidates):
 *   2 candidates gained 6 fast-score points, 0 changed Trends tier.
 *
 * Run: node tools/measure-wishlist-impact.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTrendTier } from '../lib/trend-queue.mjs';
import { POLICY_SETS } from '../lib/source-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payload = JSON.parse(fs.readFileSync(path.join(root, 'data', 'candidates.json'), 'utf8'));
const candidates = payload.candidates || payload;
const nowMs = Date.parse(payload.updatedAt || '2026-09-15T00:00:00Z');

const WIKI_SETS = [
  'FAST_WIKI_HIGH_QUALITY',
  'TREND_WIKI_STRATEGIC',
  'SEO_QUEUE_STRATEGIC',
  'SERPER_WIKI_STRATEGIC',
  'FALLBACK_WIKI_STRATEGIC',
];

function snapshot() {
  const tiers = new Map();
  for (const candidate of candidates) {
    let tier = null;
    try {
      tier = classifyTrendTier(candidate, nowMs)?.tier || null;
    } catch {
      tier = null;
    }
    tiers.set(candidate.id || candidate.gameName, tier);
  }
  return tiers;
}

const before = snapshot();

for (const name of WIKI_SETS) {
  if (POLICY_SETS[name]) POLICY_SETS[name].add('steam-top-wishlist');
}

const after = snapshot();

let promoted = 0;
const byTier = new Map();
const examples = [];
for (const [id, tier] of after) {
  const was = before.get(id) || null;
  if (was === tier) continue;
  promoted += 1;
  const key = `${was || 'none'} -> ${tier || 'none'}`;
  byTier.set(key, (byTier.get(key) || 0) + 1);
  if (examples.length < 10) examples.push(`${id}: ${key}`);
}

const wishlistOnly = candidates.filter((candidate) => {
  const sources = candidate.sources || [];
  if (!sources.length) return false;
  return sources.every((source) => [source.kind, source.sourceId].includes('steam-top-wishlist'));
});

console.log('candidates total          :', candidates.length);
console.log('found ONLY via wishlist   :', wishlistOnly.length);
console.log('tier changes after fix    :', promoted);
for (const [key, count] of [...byTier].sort((a, b) => b[1] - a[1])) {
  console.log('  ', key.padEnd(28), count);
}
if (examples.length) {
  console.log('\nexamples:');
  for (const example of examples) console.log('  ', example);
}
