const { getRedis } = require('../lib/redis');
const { requireAuth } = require('../lib/auth');
const { NODES } = require('../lib/config');

// Vercel Hobby allows up to 60s for serverless functions
module.exports.config = { maxDuration: 60 };

const START = '2019-01-01';

const EIA_SERIES = [
  { key: 'spr_level', node: 'n4', seriesId: 'PET.WCSSTUS1.W' },
  { key: 'cushing', node: 'n4', seriesId: 'PET.W_EPC0_SAX_YCUOK_MBBL.W' },
  { key: 'commercial_crude', node: 'n4', seriesId: 'PET.WCESTUS1.W' },
  { key: 'gasoline_stocks', node: 'n4', seriesId: 'PET.WGTSTUS1.W' },
  { key: 'distillate_stocks', node: 'n4', seriesId: 'PET.WDISTUS1.W' },
  { key: 'refinery_utilisation', node: 'n4', seriesId: 'PET.WPULEUS3.W' },
  { key: 'us_crude_exports', node: 'n6', seriesId: 'PET.MCREXUS2.M' },
];

const FRED_SERIES = [
  { key: 'wti', node: 'n5', seriesId: 'DCOILWTICO' },
  { key: 'brent', node: 'n5', seriesId: 'DCOILBRENTEU' },
  { key: 'yield_10y', node: 'n5', seriesId: 'DGS10' },
  { key: 'yield_30y', node: 'n5', seriesId: 'DGS30' },
];

// Crack spread inputs
const CRACK_SERIES = [
  { key: 'gasoline_spot', seriesId: 'DGASNYH', fallback: null },
  { key: 'ulsd_spot', seriesId: 'DDFUELNYH', fallback: 'DHOILNYH' },
];

async function fetchEIA(seriesId, apiKey) {
  const url = `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${apiKey}&start=${START}&sort[0][column]=period&sort[0][direction]=asc&length=5000`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EIA ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data?.response?.data) {
    return data.response.data.map(d => ({
      value: parseFloat(d.value),
      date: d.period,
      source: 'EIA',
    }));
  }
  // Check for error message
  if (data?.error) throw new Error(`EIA error: ${JSON.stringify(data.error)}`);
  return [];
}

async function fetchFRED(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=${START}&sort_order=asc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${res.status}`);
  const data = await res.json();
  if (data?.observations) {
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({
        value: parseFloat(o.value),
        date: o.date,
        source: 'FRED',
      }));
  }
  return [];
}

module.exports = async (req, res) => {
  // Must be authenticated
  if (!requireAuth(req, res)) return;

  // Optional: only allow specific batch via query param
  // /api/backfill?batch=eia or ?batch=fred or ?batch=crack or no param = all
  const batch = req.query?.batch || 'all';

  const redis = getRedis();
  const eiaKey = process.env.EIA_API_KEY;
  const fredKey = process.env.FRED_API_KEY;
  const log = [];
  let totalPoints = 0;

  if (!eiaKey) log.push('WARNING: EIA_API_KEY not set');
  if (!fredKey) log.push('WARNING: FRED_API_KEY not set');

  // EIA series
  if (batch === 'all' || batch === 'eia') {
    log.push('--- EIA Series ---');
    for (const s of EIA_SERIES) {
      try {
        const points = await fetchEIA(s.seriesId, eiaKey);
        const redisKey = `series:${s.node}:${s.key}`;
        await redis.set(redisKey, points);
        const range = points.length > 0 ? `${points[0].date} → ${points[points.length-1].date}` : 'empty';
        log.push(`${s.key}: ${points.length} points (${range})`);
        totalPoints += points.length;
      } catch (err) {
        log.push(`${s.key}: FAILED — ${err.message}`);
      }
    }
  }

  // FRED series
  if (batch === 'all' || batch === 'fred') {
    log.push('--- FRED Series ---');
    for (const s of FRED_SERIES) {
      try {
        const points = await fetchFRED(s.seriesId, fredKey);
        const redisKey = `series:${s.node}:${s.key}`;
        await redis.set(redisKey, points);
        const range = points.length > 0 ? `${points[0].date} → ${points[points.length-1].date}` : 'empty';
        log.push(`${s.key}: ${points.length} points (${range})`);
        totalPoints += points.length;
      } catch (err) {
        log.push(`${s.key}: FAILED — ${err.message}`);
      }
    }
  }

  // Crack spreads
  if (batch === 'all' || batch === 'crack') {
    log.push('--- Crack Spreads ---');
    try {
      // WTI for the denominator
      const wtiHistory = await fetchFRED('DCOILWTICO', fredKey);
      const wtiByDate = {};
      for (const p of wtiHistory) { wtiByDate[p.date] = p.value; }

      // Gasoline
      let gasHistory = [];
      try {
        gasHistory = await fetchFRED('DGASNYH', fredKey);
        log.push(`gasoline_spot (DGASNYH): ${gasHistory.length} raw points`);
      } catch (err) {
        log.push(`gasoline_spot (DGASNYH): FAILED — ${err.message}`);
      }

      // Diesel — try primary, then fallback
      let dieselHistory = [];
      try {
        dieselHistory = await fetchFRED('DDFUELNYH', fredKey);
        log.push(`diesel_spot (DDFUELNYH): ${dieselHistory.length} raw points`);
      } catch (err) {
        log.push(`diesel_spot (DDFUELNYH): FAILED — ${err.message}, trying fallback...`);
      }
      if (dieselHistory.length === 0) {
        try {
          dieselHistory = await fetchFRED('DHOILNYH', fredKey);
          log.push(`diesel_spot fallback (DHOILNYH): ${dieselHistory.length} raw points`);
        } catch (err) {
          log.push(`diesel_spot fallback: FAILED — ${err.message}`);
        }
      }

      // Calculate gasoline crack
      const gasCracks = [];
      for (const p of gasHistory) {
        const wti = wtiByDate[p.date];
        if (wti) {
          gasCracks.push({
            value: Math.round(((p.value * 42) - wti) * 100) / 100,
            date: p.date,
            source: 'calculated',
          });
        }
      }
      if (gasCracks.length > 0) {
        await redis.set('series:n5:gasoline_crack', gasCracks);
        log.push(`gasoline_crack: ${gasCracks.length} calculated points`);
        totalPoints += gasCracks.length;
      }

      // Calculate diesel crack
      const dieselCracks = [];
      for (const p of dieselHistory) {
        const wti = wtiByDate[p.date];
        if (wti) {
          dieselCracks.push({
            value: Math.round(((p.value * 42) - wti) * 100) / 100,
            date: p.date,
            source: 'calculated',
          });
        }
      }
      if (dieselCracks.length > 0) {
        await redis.set('series:n5:diesel_crack', dieselCracks);
        log.push(`diesel_crack: ${dieselCracks.length} calculated points`);
        totalPoints += dieselCracks.length;
      }
    } catch (err) {
      log.push(`crack calculation: FAILED — ${err.message}`);
    }
  }

  // Store config and timestamp
  await redis.set('meta:config', { nodes: NODES });
  await redis.set('meta:last_cron', new Date().toISOString());

  log.push(`--- Done: ${totalPoints} total points ---`);

  return res.status(200).json({ ok: true, totalPoints, log });
};
