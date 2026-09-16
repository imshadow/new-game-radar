import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from '../lib/scanner.mjs';
import { scanSteamSource } from '../lib/steam-discovery.mjs';

/**
 * Pre-flight check for every source in config/sources.json.
 *
 * Adding a source that silently returns nothing is worse than not adding it:
 * the run still looks green while the radar quietly stops discovering. This
 * tool runs the real scanner (same SSRF guard, same timeout budget) against
 * every ENABLED source and reports what the parser actually produced, so a
 * broken source shows up as a failure here instead of as an empty dashboard.
 *
 *   node tools/verify-sources.mjs                 # every enabled source
 *   node tools/verify-sources.mjs steam itch      # only ids matching a substring
 *   node tools/verify-sources.mjs --min 10        # raise the "usable" bar
 *
 * Exit code is non-zero when any source fails, so CI can gate on it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const minIndex = args.indexOf('--min');
const minRaw = minIndex >= 0 ? Number(args[minIndex + 1]) : NaN;
const minEntries = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 5;
// Drop the flag and its value, but only when the flag is actually present —
// otherwise the first positional argument gets swallowed too.
const filter = args.filter((arg, index) => !arg.startsWith('--') && (minIndex < 0 || index !== minIndex + 1));

const sources = JSON.parse(await fs.readFile(path.join(root, 'config', 'sources.json'), 'utf8'));
const selected = sources
  .filter((source) => source.enabled !== false)
  .filter((source) => !filter.length || filter.some((f) => source.id.includes(f)));

function truncate(value, n = 52) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

const summary = [];
for (const source of selected) {
  const started = Date.now();
  let verdict = 'FAIL';
  let detail = '';
  let entries = [];
  try {
    const result = source.fetchKind === 'steam-listing'
      ? await scanSteamSource(source)
      : await scanSource({ ...source, kind: source.fetchKind });
    entries = result.entries || [];
    const usable = entries.filter((entry) => entry.url && entry.gameName);
    verdict = usable.length >= minEntries ? 'GOOD' : usable.length > 0 ? 'WEAK' : 'EMPTY';
    detail = `${String(usable.length).padStart(3)} entries  ${String(result.detectedType).padEnd(20)}`;
  } catch (error) {
    detail = error.message;
  }
  const elapsed = Date.now() - started;
  summary.push({ id: source.id, verdict, count: entries.length, elapsed, detail });
  const badge = { GOOD: 'ok  ', WEAK: 'warn', EMPTY: 'none', FAIL: 'FAIL' }[verdict];
  console.log(`[${badge}] ${source.id.padEnd(26)} ${detail.padEnd(38)} ${elapsed}ms`);
  for (const entry of entries.slice(0, 4)) {
    console.log(`         · ${truncate(entry.gameName)}  ${truncate(entry.url, 60)}`);
  }
}

const counts = summary.reduce((acc, item) => ({ ...acc, [item.verdict]: (acc[item.verdict] || 0) + 1 }), {});
console.log(`\n${selected.length} enabled sources: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
const broken = summary.filter((item) => item.verdict === 'FAIL' || item.verdict === 'EMPTY');
if (broken.length) {
  console.log(`\nNeeds attention: ${broken.map((item) => `${item.id} (${item.verdict})`).join(', ')}`);
  process.exitCode = 1;
}
