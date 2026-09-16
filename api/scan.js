import { scanSource } from '../lib/scanner.mjs';

export const config = {
  maxDuration: 60,
};

// Leave headroom below `maxDuration` so we can serialise a response instead of
// being killed by the platform and returning a 504 with no body at all.
const TOTAL_BUDGET_MS = Math.max(5_000, Number(process.env.SCAN_TOTAL_BUDGET_MS || 45_000));
const PER_SOURCE_BUDGET_MS = Math.max(3_000, Number(process.env.SCAN_SOURCE_BUDGET_MS || 12_000));
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SCAN_CONCURRENCY || 5)));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST 请求' });
  }

  const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
  if (!sources.length) return res.status(400).json({ error: '请至少提供一个监控源' });
  if (sources.length > 20) return res.status(400).json({ error: '单次最多扫描 20 个监控源' });

  const normalized = sources.map((source, index) => ({
    id: String(source.id || `source-${index}`),
    name: String(source.name || `Source ${index + 1}`).slice(0, 80),
    url: String(source.url || '').trim(),
    kind: String(source.kind || 'auto'),
  })).filter((source) => source.url);

  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const results = [];

  for (let index = 0; index < normalized.length; index += CONCURRENCY) {
    if (Date.now() >= deadline) {
      // Report the untouched remainder explicitly rather than dropping it.
      for (const source of normalized.slice(index)) {
        results.push({
          ok: false,
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: source.url,
          error: '扫描总预算已用完，未执行',
          entries: [],
          scannedAt: new Date().toISOString(),
        });
      }
      break;
    }
    const chunk = normalized.slice(index, index + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((source) => scanSource(source, {
      budgetMs: PER_SOURCE_BUDGET_MS,
      deadline: Math.min(deadline, Date.now() + PER_SOURCE_BUDGET_MS),
    })));
    settled.forEach((item, itemIndex) => {
      const source = chunk[itemIndex];
      if (item.status === 'fulfilled') {
        results.push({ ok: true, ...item.value });
      } else {
        results.push({
          ok: false,
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: source.url,
          error: item.reason?.message || '扫描失败',
          entries: [],
          scannedAt: new Date().toISOString(),
        });
      }
    });
  }

  return res.status(200).json({
    results,
    scannedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    budgetMs: TOTAL_BUDGET_MS,
    truncated: Date.now() >= deadline,
  });
}
