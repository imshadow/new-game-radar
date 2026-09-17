import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deployment-readiness guards for the Vercel front end. These are cheap checks
// for the failure modes that only show up in a browser: a data source pointing at
// a host that is unreachable from the reader's network, or a file the dashboard
// fetches that never got committed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('the dashboard does not point its data source at a cross-origin host', () => {
  // raw.githubusercontent.com is blocked on mainland China networks. A blocked
  // host does not fail fast, so the browser sits on the request until it times
  // out and only then falls back — the page looks broken rather than slow.
  const meta = indexHtml.match(/<meta\s+name="radar-data-base"\s+content="([^"]*)"/);
  if (meta) {
    assert.ok(
      !/^https?:\/\//.test(meta[1].trim()),
      `radar-data-base points at an external host (${meta[1]}); use the same-origin /data directory`,
    );
  }
});

test('app.js falls back to the same origin when the primary data source fails', () => {
  assert.match(appJs, /FALLBACK_BASE\s*=\s*`\$\{location\.origin\}\/data`/);
  assert.match(appJs, /fetch\(`\$\{FALLBACK_BASE\}\/\$\{file\}/);
});

test('the default data base is same-origin so a missing meta still works', () => {
  assert.match(appJs, /RADAR_BASE|RAW_BASE\s*=/);
  assert.match(appJs, /\|\|\s*`\$\{location\.origin\}\/data`/);
});

test('every file the dashboard fetches is committed', () => {
  const requested = [...appJs.matchAll(/fetchData\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(requested.length > 0, 'expected app.js to fetch at least one data file');
  for (const file of requested) {
    const target = path.join(root, 'data', file);
    assert.ok(fs.existsSync(target), `data/${file} is fetched by app.js but is not in the repository`);
  }
});

test('the dashboard does not need a build step to deploy', () => {
  // Vercel's "Other" preset serves the repository root as static output, which is
  // what this project relies on: index.html, app.js, styles.css and data/ are all
  // static, and api/scan.js becomes a function.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.build, undefined, 'a build script would change the Vercel preset and output directory');
  for (const file of ['index.html', 'app.js', 'styles.css']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist at the repository root`);
  }
});

test('api/scan.js does not reach for a quota-bearing API key', () => {
  // The endpoint is public and unauthenticated, so it must never spend Serper or
  // Trends quota on behalf of an anonymous caller.
  const handler = fs.readFileSync(path.join(root, 'api', 'scan.js'), 'utf8');
  for (const name of ['SERPER_API_KEY', 'SERPAPI_API_KEY', 'SEARCHAPI_API_KEY', 'APIFY_API_TOKEN']) {
    assert.ok(!handler.includes(name), `api/scan.js must not reference ${name}`);
  }
});
