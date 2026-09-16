import { safeFetchText, parseRemoteDocument } from '../lib/scanner.mjs';
import { parseSteamSearch } from '../lib/steam-discovery.mjs';

/**
 * Try one candidate URL against the real parser before adding it to
 * config/sources.json.
 *
 * Most "dead sources" are not dead — they resolve fine but return a body the
 * parser cannot read (JSON where XML was expected, a category page where a
 * listing was expected, markup that breaks a naive attribute scan). Probing
 * first is what tells the two apart, and it is the difference between "this
 * site is gone" and "this site needs a parser".
 *
 *   node tools/probe-source.mjs <url> [fetchKind] [--show]
 *
 * fetchKind defaults to `auto`. Pass `--show` to print the raw response head,
 * which is the fastest way to work out which parser a new site needs.
 */

const args = process.argv.slice(2);
const show = args.includes('--show');
const positional = args.filter((arg) => !arg.startsWith('--'));
const [url, fetchKind = 'auto'] = positional;

if (!url) {
  console.error('usage: node tools/probe-source.mjs <url> [fetchKind] [--show]');
  console.error('  fetchKind: auto | feed | sitemap | press-feed | steam-feed | steam-listing');
  console.error('             itch-listing | hn-listing | github-listing | armorgames-listing');
  console.error('             poki-listing | crazygames-listing | y8-listing | gamepix-listing | lagged-listing');
  process.exit(2);
}

const started = Date.now();
let fetched;
try {
  fetched = await safeFetchText(url);
} catch (error) {
  console.error(`FAIL  ${url}\n      ${error.message}`);
  process.exit(1);
}

const bytes = fetched.text.length;
const contentType = fetched.contentType || '(none)';
console.log(`${url}`);
console.log(`  status ok  ${bytes} bytes  ${Date.now() - started}ms  content-type: ${contentType}`);

if (show) {
  console.log('  --- raw head ---');
  console.log(`  ${fetched.text.slice(0, 600).replace(/\s+/g, ' ')}`);
  console.log('  --- end ---');
}

let parsed;
if (fetchKind === 'steam-listing') {
  parsed = { type: 'steam-listing', entries: parseSteamSearch(fetched.text) };
} else {
  parsed = parseRemoteDocument(fetched.text, fetched.finalUrl, fetchKind);
}

const entries = (parsed.entries || []).filter((entry) => entry.url && entry.gameName);
const verdict = entries.length >= 5 ? 'GOOD' : entries.length > 0 ? 'WEAK' : 'EMPTY';
console.log(`  detectedType=${parsed.type}  entries=${entries.length}  verdict=${verdict}`);
for (const entry of entries.slice(0, 10)) {
  console.log(`    · ${String(entry.gameName).padEnd(34)} ${String(entry.url).slice(0, 70)}`);
}
if (verdict === 'EMPTY') {
  console.log('  hint: re-run with --show to inspect the body, then pick a fetchKind that matches its shape.');
  process.exitCode = 1;
}
