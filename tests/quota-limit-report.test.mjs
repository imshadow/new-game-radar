import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSerpApiUsage } from '../lib/trend-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classifySource = await fs.readFile(path.join(root, 'scripts', 'classify-site-types.mjs'), 'utf8');
const usageFile = JSON.parse(await fs.readFile(path.join(root, 'data', 'serpapi-usage.json'), 'utf8'));

// Mirrors the constants in lib/trend-verifier.mjs. `classify` must agree.
const envMonthly = Math.max(1, Number(process.env.SERPAPI_MONTHLY_LIMIT || 220));
const envDaily = Math.max(1, Number(process.env.SERPAPI_DAILY_LIMIT || 8));

/**
 * The runtime guard is the source of truth: it reads the environment and
 * overrides whatever the persisted usage file happens to say. Everything that
 * *reports* a limit has to agree with it, or a working quota fix reads as a
 * no-op — which is exactly how the upstream repo sat green with zero
 * verification for seven weeks.
 */
test('the runtime quota guard takes its limits from the environment, not the usage file', async () => {
  const usage = await getSerpApiUsage();
  assert.equal(usage.dailyLimit, envDaily);
  assert.equal(usage.monthlyLimit, envMonthly);
});

test('a stale limit in data/serpapi-usage.json cannot win over the environment', async () => {
  const usage = await getSerpApiUsage();
  // This is a live regression: the committed file still says 245/245 from before
  // SERPAPI_DAILY_LIMIT was lowered to 8. If the spread order in
  // getSerpApiUsage() ever flips, the guard silently becomes a no-op again.
  if (Number(usageFile.dailyLimit) !== envDaily) {
    assert.notEqual(usage.dailyLimit, Number(usageFile.dailyLimit));
  }
  if (Number(usageFile.monthlyLimit) !== envMonthly) {
    assert.notEqual(usage.monthlyLimit, Number(usageFile.monthlyLimit));
  }
});

test('classify derives the reported daily limit from the environment', () => {
  assert.match(
    classifySource,
    /dailyLimit:\s*Math\.max\(1,\s*Number\(process\.env\.SERPAPI_DAILY_LIMIT/,
    'the report must not echo the persisted dailyLimit',
  );
});

test('classify derives the reported monthly limit from the environment', () => {
  assert.match(
    classifySource,
    /monthlyLimit:\s*Math\.max\(1,\s*Number\(process\.env\.SERPAPI_MONTHLY_LIMIT/,
    'the report must not echo the persisted monthlyLimit',
  );
});

test('classify spreads the persisted file before applying the environment limits', () => {
  const spreadIndex = classifySource.indexOf('...serpApiUsageFile');
  const dailyIndex = classifySource.indexOf('dailyLimit: Math.max(1, Number(process.env.SERPAPI_DAILY_LIMIT');
  assert.ok(spreadIndex !== -1, 'expected the persisted usage file to be spread into serpApiUsage');
  assert.ok(dailyIndex !== -1, 'expected an env-derived dailyLimit');
  assert.ok(
    dailyIndex > spreadIndex,
    'the env-derived limit must come after the file spread, otherwise the file wins',
  );
});
