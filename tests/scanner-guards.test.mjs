import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFetchText, parseRemoteDocument, deriveGameName, normalizeGameName } from '../lib/scanner.mjs';

/**
 * `api/scan.js` exposes `scanSource` over HTTP, so every URL it fetches is
 * attacker-controlled. These are the guards that keep that from becoming an SSRF
 * primitive or a way to hang a serverless invocation.
 */

test('rejects non-HTTP protocols', async () => {
  await assert.rejects(() => safeFetchText('ftp://example.com/file'), /只允许 HTTP 或 HTTPS URL/);
  await assert.rejects(() => safeFetchText('file:///etc/passwd'), /只允许 HTTP 或 HTTPS URL/);
});

test('rejects malformed URLs', async () => {
  await assert.rejects(() => safeFetchText('not a url'), /URL 格式不正确/);
});

test('rejects credentials embedded in the URL', async () => {
  await assert.rejects(() => safeFetchText('http://user:pass@example.com/'), /URL 不允许包含账号密码/);
});

test('rejects localhost by name', async () => {
  await assert.rejects(() => safeFetchText('http://localhost/admin'), /不允许访问本地地址/);
  await assert.rejects(() => safeFetchText('http://LOCALHOST.LOCALDOMAIN/admin'), /不允许访问本地地址/);
});

test('rejects loopback and private addresses', async () => {
  await assert.rejects(() => safeFetchText('http://127.0.0.1/'), /不允许访问内网或保留地址/);
  await assert.rejects(() => safeFetchText('http://[::1]/'), /不允许访问内网或保留地址/);
  await assert.rejects(() => safeFetchText('http://10.0.0.1/'), /不允许访问内网或保留地址/);
  await assert.rejects(() => safeFetchText('http://192.168.1.1/'), /不允许访问内网或保留地址/);
  await assert.rejects(() => safeFetchText('http://169.254.169.254/latest/meta-data/'), /不允许访问内网或保留地址/);
});

test('an exhausted budget fails immediately instead of issuing a request', async () => {
  const started = Date.now();
  await assert.rejects(
    () => safeFetchText('https://example.com/', 0, Date.now() - 1),
    /请求超时/,
  );
  // Must not have waited on DNS or a socket.
  assert.ok(Date.now() - started < 1000, 'expired deadline should short-circuit');
});

test('a shared deadline is honoured across the redirect chain', async () => {
  // A budget that is already spent must abort even when a redirect is offered.
  await assert.rejects(
    () => safeFetchText('https://example.com/', 2, Date.now() - 1),
    /请求超时/,
  );
});

test('sitemap index parsing still resolves child sitemaps', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-games-1.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-games-2.xml</loc></sitemap>
    </sitemapindex>`;
  const parsed = parseRemoteDocument(xml, 'https://example.com/sitemap.xml', 'sitemap');
  assert.equal(parsed.type, 'sitemap-index');
  assert.deepEqual(parsed.children, [
    'https://example.com/sitemap-games-1.xml',
    'https://example.com/sitemap-games-2.xml',
  ]);
});

test('feed parsing extracts titles and links', () => {
  const xml = `<rss><channel>
    <item><title>Neon Drift</title><link>https://itch.io/games/neon-drift</link><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const parsed = parseRemoteDocument(xml, 'https://itch.io/feed/new.xml', 'feed');
  assert.equal(parsed.type, 'feed');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, 'Neon Drift');
  assert.equal(parsed.entries[0].url, 'https://itch.io/games/neon-drift');
});

test('game name derivation strips platform noise from titles', () => {
  assert.equal(deriveGameName({ title: 'Neon Drift - Play Online', url: 'https://itch.io/games/neon-drift' }), 'Neon Drift');
  assert.equal(deriveGameName({ title: '', url: 'https://poki.com/en/g/neon-drift' }), 'Neon Drift');
  assert.equal(normalizeGameName('Neon Drift - Play Online Game'), 'neon drift');
});
