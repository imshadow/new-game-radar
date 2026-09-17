// Pure accounting for the Serper account pool.
//
// Quota accounting is the recurring bug in this project — the per-run cap
// silently equalling the total cap happened three times — so the arithmetic
// lives here, away from the I/O, where it can be tested directly.

export const SERPER_SLOT_DEFINITIONS = [
  ['1', 'SERPER_API_KEY'],
  ['2', 'SERPER_API_KEY_2'],
  ['3', 'SERPER_API_KEY_3'],
  ['4', 'SERPER_API_KEY_4'],
  ['5', 'SERPER_API_KEY_5'],
];

export function currentUtcDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// `totalUsed` is a one-time allowance and never resets; `dayUsed` resets on the
// UTC day boundary, which is the same boundary scripts/verify-serper.mjs uses.
export function normalizeSerperUsage(raw = {}, { day = currentUtcDay(), totalLimit, dailyLimit } = {}) {
  return {
    totalUsed: Math.max(0, Number(raw.totalUsed || 0)),
    day,
    dayUsed: raw.day === day ? Math.max(0, Number(raw.dayUsed || 0)) : 0,
    totalLimit,
    dailyLimit,
    updatedAt: raw.updatedAt || null,
    lastError: raw.lastError || null,
  };
}

export function aggregateSerperUsage(entries = [], { day = currentUtcDay(), totalLimit, dailyLimit } = {}) {
  const accounts = {};
  let totalUsed = 0;
  let dayUsed = 0;
  for (const entry of entries) {
    const usage = normalizeSerperUsage(entry.usage || {}, { day, totalLimit, dailyLimit });
    totalUsed += usage.totalUsed;
    dayUsed += usage.dayUsed;
    accounts[entry.id] = {
      envName: entry.envName,
      totalUsed: usage.totalUsed,
      dayUsed: usage.dayUsed,
      totalLimit,
      dailyLimit,
      updatedAt: usage.updatedAt,
      lastError: usage.lastError,
    };
  }
  const slotCount = entries.length;
  return {
    enabled: slotCount > 0,
    configuredSlots: slotCount,
    day,
    totalUsed,
    dayUsed,
    // Limits scale with the number of accounts: each account brings its own
    // one-time allowance, which is the whole point of pooling.
    totalLimit: totalLimit * slotCount,
    dailyLimit: dailyLimit * slotCount,
    accounts,
  };
}

export function mergeSerperVerification(runs = [], { verifyLimit, onlineLimit, wikiLimit, minPriority } = {}) {
  const verifiedByChannel = { online: 0, wiki: 0, pending: 0 };
  const verifiedNames = [];
  let verified = 0;
  let errors = 0;
  let queueSize = 0;
  let lastVerification = {};
  for (const run of runs) {
    const verification = run.verification || {};
    verified += Number(verification.verified || 0);
    errors += Number(verification.errors || 0);
    queueSize += Number(verification.queueSize || 0);
    for (const key of Object.keys(verifiedByChannel)) {
      verifiedByChannel[key] += Number(verification.verifiedByChannel?.[key] || 0);
    }
    verifiedNames.push(...(verification.verifiedNames || []));
    lastVerification = verification;
  }
  if (!runs.length) return { ...lastVerification };
  return {
    rushMode: true,
    minPriority,
    budgetLanes: lastVerification.budgetLanes || { hot: '60%', recheck: '20%', explore: '20%' },
    limit: verifyLimit,
    onlineLimit,
    wikiLimit,
    queueSize,
    verified,
    verifiedByChannel,
    errors,
    // The chain only counts as stopped when every account is stopped.
    quotaStopped: runs.every((run) => Boolean(run.verification?.quotaStopped)),
    verifiedNames,
    accounts: Object.fromEntries(runs.map((run) => [run.slotId, {
      envName: run.envName,
      ok: run.ok,
      error: run.error,
      verified: Number(run.verification?.verified || 0),
      errors: Number(run.verification?.errors || 0),
      quotaStopped: Boolean(run.verification?.quotaStopped),
    }])),
  };
}
