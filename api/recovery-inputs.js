// /api/recovery-inputs.js
// Public endpoint — feeds the Recovery Gap chart in the Iran briefing
// Returns 6 current values + derived stress ratios + suggested bottleneck adjustments
// CDN-cached for 1 hour (data updates once daily at 21:00 UTC cron)

const { getRedis } = require('../lib/redis');

// Pre-war baseline constants (Jan 2026 averages / 2024 norms)
const BASELINES = {
  hormuz_daily: 24,          // Jan 2026 avg from Windward/PortWatch
  bab_daily: 45,             // Jan 2026 avg
  insurance_multiple: 1.0,   // No war-risk premium = 1× base rate
  diesel_crack_normal: 25,   // 2024 avg diesel crack spread ($/bbl)
};

const EPCA_FLOOR = 252.4; // Statutory SPR floor (M bbl)

module.exports = async function handler(req, res) {
  // Public endpoint — wide CORS + CDN cache
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const redis = getRedis();

    // Fetch latest values from each relevant series — all in parallel
    const [hormuzData, babData, insData, dieselData, sprData, cushingData, lastCron] =
      await Promise.all([
        redis.get('series:n2:hormuz_portwatch'),
        redis.get('series:n2:bab_portwatch'),
        redis.get('series:n7:insurance_multiple'),
        redis.get('series:n5:diesel_crack'),
        redis.get('series:n4:spr_level'),
        redis.get('series:n4:cushing'),
        redis.get('meta:last_cron'),
      ]);

    const hormuz = getLatest(hormuzData);
    const bab = getLatest(babData);
    const insMult = getLatest(insData);
    const dieselCrack = getLatest(dieselData);
    const sprKbbl = getLatest(sprData);
    const cushingKbbl = getLatest(cushingData);

    // Convert K bbl → M bbl for SPR and Cushing
    const sprMb = sprKbbl !== null ? round(sprKbbl / 1000, 1) : null;
    const cushingMb = cushingKbbl !== null ? round(cushingKbbl / 1000, 1) : null;

    const current = {
      hormuz_daily: hormuz,
      bab_daily: bab,
      insurance_multiple: insMult,
      diesel_crack: dieselCrack,
      spr_mb: sprMb,
      cushing_mb: cushingMb,
    };

    // Derived stress ratios
    const derived = {
      hormuz_recovery_pct: hormuz !== null
        ? round((hormuz / BASELINES.hormuz_daily) * 100, 1)
        : null,
      insurance_stress_ratio: insMult,
      diesel_crack_multiple: dieselCrack !== null
        ? round(dieselCrack / BASELINES.diesel_crack_normal, 2)
        : null,
      spr_buffer_above_floor_mb: sprMb !== null
        ? round(sprMb - EPCA_FLOOR, 1)
        : null,
    };

    // Suggested bottleneck duration adjustments for the Recovery Gap chart
    const dcm = derived.diesel_crack_multiple;
    const sprBuf = derived.spr_buffer_above_floor_mb;

    const suggested = {
      route_status: hormuz === null ? 'unknown'
        : hormuz < 5 ? 'cape'
        : hormuz <= 15 ? 'partial'
        : 'full',
      insurance_months: insMult === null ? null
        : insMult > 20 ? 4
        : insMult > 10 ? 3
        : insMult > 5 ? 2
        : 1,
      refinery_ramp_months: dcm === null ? null
        : dcm > 3 ? 2
        : dcm > 2 ? 1.5
        : dcm > 1 ? 1
        : 0.5,
      stocks_rebuild_months: sprBuf === null ? null
        : sprBuf < 20 ? 4
        : sprBuf < 40 ? 3
        : sprBuf < 80 ? 2
        : 1,
    };

    // Staleness check — flag if cron hasn't run in >36 hours
    const cronAge = lastCron
      ? Date.now() - new Date(lastCron).getTime()
      : Infinity;
    const stale = cronAge > 36 * 3600 * 1000;

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      prewar_baseline: BASELINES,
      current,
      derived,
      suggested_adjustments: suggested,
      last_cron: lastCron || null,
      stale,
    });
  } catch (err) {
    console.error('recovery-inputs error:', err);
    return res.status(500).json({
      error: 'Failed to read monitor data',
      detail: err.message,
    });
  }
};

// Extract latest value from a Redis series (JSON array of {value, date, source})
function getLatest(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  const latest = data[data.length - 1];
  return latest.value !== undefined ? latest.value : null;
}

function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  return Math.round(n * 10 ** d) / 10 ** d;
}
