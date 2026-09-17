import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SERPER_SLOT_DEFINITIONS,
  aggregateSerperUsage,
  currentUtcDay,
  mergeSerperVerification,
  normalizeSerperUsage,
} from '../lib/serper-pool.mjs';

// Serper has no pool in upstream: there is exactly one SERPER_API_KEY, so
// swapping in a fresh account meant manually zeroing `totalUsed` in
// data/serper-usage.json or the quota guard would block every request forever.
// This runs the existing verifier once per configured account and aggregates the
// accounting, mirroring scripts/fill-serpapi-pool.mjs.
//
// scripts/verify-serper.mjs is deliberately left untouched: its quota guard is
// the piece that must not regress, so the pool wraps it instead of editing it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const reportPath = path.join(dataDir, 'latest-report.json');
const primaryUsagePath = path.join(dataDir, 'serper-usage.json');
const poolUsagePath = path.join(dataDir, 'serper-pool-usage.json');
const reportOnly = process.argv.includes('--report-only');

const totalLimit = Math.max(1, Number(process.env.SERPER_TOTAL_LIMIT || 2450));
const dailyLimit = Math.max(1, Number(process.env.SERPER_DAILY_LIMIT || 80));
const verifyLimit = Math.max(0, Math.min(1200, Number(process.env.SERPER_VERIFY_LIMIT || 90)));
const onlineLimit = Math.max(0, Number(process.env.SERPER_ONLINE_LIMIT || Math.round(verifyLimit * 0.7)));
const wikiLimit = Math.max(0, Number(process.env.SERPER_WIKI_LIMIT || Math.round(verifyLimit * 0.3)));
const minPriority = Math.max(0, Number(process.env.SERPER_MIN_PRIORITY || 80));
const limits = { totalLimit, dailyLimit };

const slots = SERPER_SLOT_DEFINITIONS
  .map(([id, envName]) => ({
    id,
    envName,
    key: String(process.env[envName] || '').trim(),
    usagePath: id === '1' ? primaryUsagePath : path.join(dataDir, `serper-usage-${id}.json`),
  }))
  .filter((slot) => slot.key);

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
function normalize(raw) {
  return normalizeSerperUsage(raw, { day: currentUtcDay(), ...limits });
}

async function aggregateUsage() {
  const day = currentUtcDay();
  const entries = [];
  for (const slot of slots) entries.push({ id: slot.id, envName: slot.envName, usage: await readJson(slot.usagePath, {}) });
  return { ...aggregateSerperUsage(entries, { day, ...limits }), updatedAt: new Date().toISOString() };
}

function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: root, env, stdio: 'inherit' });
    child.on('error', (error) => resolve({ ok: false, code: -1, error: error.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code: code ?? -1, error: code === 0 ? null : `exit ${code}` }));
  });
}

async function writePoolReport(runs = []) {
  const usage = await aggregateUsage();
  await writeJson(poolUsagePath, usage);

  const report = await readJson(reportPath, {});
  const verification = runs.length
    ? { ...mergeSerperVerification(runs, { verifyLimit, onlineLimit, wikiLimit, minPriority }), ranAt: new Date().toISOString() }
    : { ...(report.serperVerification || {}), configuredSlots: 0 };

  await writeJson(reportPath, {
    ...report,
    serperConfigured: slots.length > 0,
    serperConfiguredSlots: slots.length,
    // Both fields carry the aggregate so the dashboard and the health check read
    // the real total across accounts; per-account detail stays in `accounts`.
    serperUsage: usage,
    serperPoolUsage: usage,
    serperVerification: verification,
  });
  return usage;
}

if (!slots.length) {
  console.log('No Serper keys configured; skipping SEO verification.');
  await writePoolReport([]);
  process.exit(0);
}

if (reportOnly) {
  const usage = await writePoolReport([]);
  console.log(`Serper pool report: ${usage.configuredSlots} account(s), daily ${usage.dayUsed}/${usage.dailyLimit}, total ${usage.totalUsed}/${usage.totalLimit}.`);
  process.exit(0);
}

const runs = [];
const firstSlot = slots[0];
let firstSlotUsageAfter = null;
for (const slot of slots) {
  // verify-serper.mjs always accounts into data/serper-usage.json, so each
  // account's counters are swapped into that path before its run and read back
  // afterwards.
  if (slot !== firstSlot) await writeJson(primaryUsagePath, normalize(await readJson(slot.usagePath, {})));

  console.log(`Running Serper SEO verification with account ${slot.id}/${slots.length} (${slot.envName}).`);
  const result = await runNode('scripts/verify-serper.mjs', {
    ...process.env,
    SERPER_API_KEY: slot.key,
    SERPER_TOTAL_LIMIT: String(totalLimit),
    SERPER_DAILY_LIMIT: String(dailyLimit),
  });

  const activeUsage = normalize(await readJson(primaryUsagePath, {}));
  if (slot === firstSlot) firstSlotUsageAfter = activeUsage;
  else await writeJson(slot.usagePath, activeUsage);

  const report = await readJson(reportPath, {});
  runs.push({ slotId: slot.id, envName: slot.envName, ok: result.ok, error: result.error, verification: report.serperVerification || {} });
}

// Restore the first configured account's counters, so the primary usage file
// describes a real account instead of whichever slot happened to run last.
if (firstSlotUsageAfter) await writeJson(primaryUsagePath, firstSlotUsageAfter);

const usage = await writePoolReport(runs);
console.log(`Serper pool complete: ${slots.length} account(s), daily ${usage.dayUsed}/${usage.dailyLimit}, total ${usage.totalUsed}/${usage.totalLimit}.`);
