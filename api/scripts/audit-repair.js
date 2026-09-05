// api/audit-repair.js
//
// Browser-runnable version of scripts/audit-repair.js. Files under scripts/
// are not deployed as routes on Vercel — only api/ is — which is why the
// script 404s when requested over HTTP.
//
// Usage (authenticated, same auth as /api/data):
//   GET /api/audit-repair                          dry run, full report
//   GET /api/audit-repair?key=series:n6:west_africa_diff
//   GET /api/audit-repair?apply=1                  quarantine + rewrite
//   GET /api/audit-repair?apply=1&key=series:n7:warrisk_band
//
// Dry run is the default. Writes require apply=1 explicitly.

const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES } = require('../lib/config');
const { readValue, SERIES_BOUNDS } = require('../lib/values');

function allSeriesKeys() {
  const keys = [];
  for (const node of NODES) {
    for (const s of node.series) {
      keys.push({
        redisKey: `series:${node.id}:${s.key}`,
        seriesKey: s.key,
        node: node.id,
        unit: s.unit,
      });
    }
  }
  return keys;
}

async function auditSeries(redis, entry) {
  let history;
  try {
    history = await redis.get(entry.redisKey);
  } catch (err) {
    return { ...entry, error: `redis read failed: ${err.message}` };
  }

  if (!Array.isArray(history)) {
    return { ...entry, error: history === null ? 'no data' : 'stored value is not an array' };
  }

  const good = [];
  const bad = [];

  for (const point of history) {
    if (!point || typeof point !== 'object' || point.value === undefined) {
      bad.push({ point, reason: 'malformed point' });
      continue;
    }
    const res = readValue(entry.seriesKey, point.value);
    if (res.ok) good.push(point);
    else bad.push({ date: point.date || null, value: point.value, reason: res.reason, detail: res.detail || null });
  }

  return { ...entry, total: history.length, goodCount: good.length, good, bad };
}

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const apply = String(req.query.apply || '') === '1';
  const keyFilter = req.query.key || null;

  try {
    const redis = getRedis();

    // Fail fast on a bad endpoint instead of walking every series first.
    try {
      await redis.ping();
    } catch (err) {
      return res.status(502).json({
        error: 'Redis unreachable',
        detail: err.message,
        hint: 'Check UPSTASH_REDIS_REST_URL is the https REST endpoint with no port, path or trailing slash.',
      });
    }

    const entries = allSeriesKeys().filter(e => !keyFilter || e.redisKey === keyFilter);
    if (entries.length === 0) {
      return res.status(404).json({ error: `No series matched ${keyFilter}` });
    }

    const report = [];
    const emptied = [];
    const applyFailures = [];
    let totalBad = 0;
    let totalPoints = 0;

    for (const entry of entries) {
      const r = await auditSeries(redis, entry);

      if (r.error) {
        report.push({ key: r.redisKey, skipped: r.error });
        continue;
      }

      totalPoints += r.total;
      if (r.bad.length === 0) continue;
      totalBad += r.bad.length;

      const item = {
        key: r.redisKey,
        unit: r.unit,
        bounds: SERIES_BOUNDS[r.seriesKey] || null,
        total: r.total,
        rejected: r.bad.length,
        retained: r.goodCount,
        samples: r.bad.slice(0, 10),
        applied: false,
      };

      if (r.goodCount === 0) emptied.push(r.redisKey);

      if (apply) {
        const qKey = `quarantine:${r.redisKey}:${new Date().toISOString().split('T')[0]}`;
        try {
          // Quarantine copy is written BEFORE the series is rewritten, so a
          // mid-operation failure can never drop points without a copy.
          await redis.set(qKey, r.bad);
          await redis.set(r.redisKey, r.good);
          item.applied = true;
          item.quarantineKey = qKey;
        } catch (err) {
          item.applyError = err.message;
          applyFailures.push({ key: r.redisKey, error: err.message });
        }
      }

      report.push(item);
    }

    return res.status(applyFailures.length ? 207 : 200).json({
      mode: apply ? 'apply' : 'dry-run',
      scanned: { series: entries.length, points: totalPoints },
      totalRejected: totalBad,
      series: report,
      emptied,
      applyFailures,
      note: emptied.length
        ? 'Emptied series will score UNKNOWN. That is the intended state — do not backfill with guesses.'
        : undefined,
      next: apply ? undefined : 'Re-run with ?apply=1 to quarantine and rewrite.',
    });
  } catch (err) {
    console.error('audit-repair error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};
