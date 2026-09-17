import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usagePath = path.join(root, 'data', 'brave-search-usage.json');
const scanSource = await fs.readFile(path.join(root, 'scripts', 'scan.mjs'), 'utf8');

// lib/seo-verifier.mjs reads its keys and limits at import time, so they have to
// be in place before the dynamic import below.
process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
process.env.BRAVE_SEARCH_MONTHLY_LIMIT = '1';
process.env.BRAVE_SEARCH_DAILY_LIMIT = '1';

const { verifyGameKeyword } = await import('../lib/seo-verifier.mjs');

const DUCK_PAGE = '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsample.itch.io%2Falpha">Alpha Sample Game by Dev - itch.io</a><a class="result__snippet">Play Alpha Sample Game online.</a></div>';
const BRAVE_PAYLOAD = { web: { results: [{ url: 'https://sample.itch.io/alpha', title: 'Alpha Sample Game - itch.io', description: 'Play the browser game' }] } };

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}
function textResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

function stubFetch() {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes('api.search.brave.com')) return jsonResponse(BRAVE_PAYLOAD);
    if (target.includes('html.duckduckgo.com')) return textResponse(DUCK_PAGE);
    if (target.includes('suggestqueries.google.com')) return jsonResponse(['alpha', []]);
    if (target.includes('duckduckgo.com/ac/')) return jsonResponse([]);
    throw new Error(`unexpected request in test: ${target}`);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

/**
 * Brave's free plan is a $5 monthly credit (about 1,000 requests), i.e. less than
 * a single Serper account's daily budget. The old code returned `pending` once
 * that ran out, so a candidate simply sat out the round — even though a
 * completely free DuckDuckGo path was sitting right below it.
 */
test('Brave 额度用完后降级到 DuckDuckGo，而不是让候选卡在 pending', async () => {
  await fs.rm(usagePath, { force: true });
  const stub = stubFetch();
  try {
    const first = await verifyGameKeyword('Alpha Sample Game', 5);
    const second = await verifyGameKeyword('Beta Sample Game', 5);
    assert.equal(first.provider, 'brave+autocomplete', '第一轮应该走 Brave');
    assert.equal(second.provider, 'duckduckgo+autocomplete', 'Brave 额度用完后应该降级，而不是 pending');
    assert.equal(second.status, 'ok');
    assert.notEqual(second.classification, 'pending');
    assert.ok(stub.seen.some((url) => url.includes('html.duckduckgo.com')), '降级后确实请求了 DuckDuckGo');
  } finally {
    stub.restore();
    // The usage file is a runtime artifact, not a fixture — don't leave it behind.
    await fs.rm(usagePath, { force: true });
  }
});

test('DuckDuckGo 返回拦截页时抛错，不产出结论', async () => {
  // 先把 Brave 的额度标成已用完，逼它走 DuckDuckGo。
  const now = new Date();
  await fs.writeFile(usagePath, JSON.stringify({
    month: now.toISOString().slice(0, 7),
    monthUsed: 1,
    day: now.toISOString().slice(0, 10),
    dayUsed: 1,
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('html.duckduckgo.com')) return textResponse('<form id="challenge-form">Anomaly detected</form>');
    if (target.includes('suggestqueries.google.com')) return jsonResponse(['x', []]);
    if (target.includes('duckduckgo.com/ac/')) return jsonResponse([]);
    throw new Error(`unexpected request in test: ${target}`);
  };
  try {
    await assert.rejects(() => verifyGameKeyword('Gamma Sample Game', 5), /拦截/);
  } finally {
    globalThis.fetch = original;
    await fs.rm(usagePath, { force: true });
  }
});

// ------------------------------------------------- single-owner guards

/**
 * The free path must never overwrite a paid Serper verdict. scan.mjs runs before
 * verify-serper.mjs and its queue used to be gated only by "how long since the
 * last check", regardless of who did the checking — so switching the free path on
 * would have re-scraped words Serper had already paid for, and starved the
 * backlog it was meant to preheat.
 */
test('免费 SEO 路径跳过 Serper 已验且模型版本当前的候选', () => {
  assert.match(scanSource, /seo\?\.provider==='serper\+autocomplete'&&seo\?\.modelVersion===SEO_MODEL_VERSION\)return false/,
    'needsSeoCheck 必须先排除 Serper 的权威结论');
  assert.ok(/const FREE_VERIFY_MAX_AGE=7\*86400000/.test(scanSource),
    '免费路径要有自己的保鲜期，不能复用 Serper 的分档规则');
  assert.ok(!/const VERIFY_MAX_AGE=3\*86400000/.test(scanSource),
    '旧的全局 3 天规则不能留在 scan.mjs 里冒充现行规则');
});

test('免费路径的开关是调度输入，不用改代码就能关掉', async () => {
  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'radar.yml'), 'utf8');
  assert.match(workflow, /free_seo_verify_limit:/, '要有 workflow_dispatch 输入');
  assert.match(workflow, /SEO_VERIFY_LIMIT: \$\{\{ inputs\.free_seo_verify_limit \|\| \d+ \}\}/,
    'SEO_VERIFY_LIMIT 必须由调度输入驱动');
  assert.ok(/BRAVE_SEARCH_MONTHLY_LIMIT: \d+/.test(workflow), 'Brave 月额度要显式声明');
  assert.ok(/BRAVE_SEARCH_DAILY_LIMIT: \d+/.test(workflow), 'Brave 日额度要显式声明');
});
