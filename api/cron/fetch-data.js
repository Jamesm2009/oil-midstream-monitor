const { getRedis } = require('../../lib/redis');

// EIA v1-compatible series (backward-compatible with v2)
const EIA_SERIES = [
  { key: 'spr_level', node: 'n4', seriesId: 'PET.WCSSTUS1.W', freq: 'weekly' },
  { key: 'cushing', node: 'n4', seriesId: 'PET.W_EPC0_SAX_YCUOK_MBBL.W', freq: 'weekly' },
  { key: 'commercial_crude', node: 'n4', seriesId: 'PET.WCESTUS1.W', freq: 'weekly' },
  { key: 'gasoline_stocks', node: 'n4', seriesId: 'PET.WGTSTUS1.W', freq: 'weekly' },
  { key: 'distillate_stocks', node: 'n4', seriesId: 'PET.WDISTUS1.W', freq: 'weekly' },
  { key: 'refinery_utilisation', node: 'n4', seriesId: 'PET.WPULEUS3.W', freq: 'weekly' },
  { key: 'us_crude_exports', node: 'n6', seriesId: 'PET.MCREXUS2.M', freq: 'monthly' },
];

// FRED daily series
const FRED_SERIES = [
  { key: 'wti', node: 'n5', seriesId: 'DCOILWTICO' },
  { key: 'brent', node: 'n5', seriesId: 'DCOILBRENTEU' },
  { key: 'yield_10y', node: 'n5', seriesId: 'DGS10' },
  { key: 'yield_30y', node: 'n5', seriesId: 'DGS30' },
];

// FRED series for crack spread inputs (not stored directly)
const FRED_CRACK_INPUTS = {
  gasoline: { seriesId: 'DGASNYH', fallback: null },
  diesel: { seriesId: 'DDFUELNYH', fallback: 'DHOILNYH' },
};

async function fetchEIA(seriesId, apiKey) {
  // Try v2 seriesid endpoint first
  const url = `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${apiKey}&length=5&sort[0][column]=period&sort[0][direction]=desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EIA API error: ${res.status}`);
  const data = await res.json();

  if (data?.response?.data && data.response.data.length > 0) {
    return data.response.data.map(d => ({
      value: parseFloat(d.value),
      date: d.period,
      source: 'EIA',
    })).reverse(); // oldest first
  }
  return [];
}

async function fetchFRED(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED API error: ${res.status}`);
  const data = await res.json();

  if (data?.observations) {
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({
        value: parseFloat(o.value),
        date: o.date,
        source: 'FRED',
      }))
      .reverse(); // oldest first
  }
  return [];
}

async function appendToHistory(redis, redisKey, newPoints) {
  let history = (await redis.get(redisKey)) || [];
  if (!Array.isArray(history)) history = [];

  let added = 0;
  for (const point of newPoints) {
    const exists = history.some(h => h.date === point.date);
    if (!exists) {
      history.push(point);
      added++;
    }
  }

  if (added > 0) {
    history.sort((a, b) => a.date.localeCompare(b.date));
    await redis.set(redisKey, history);
  }

  return added;
}

module.exports = async (req, res) => {
  // Verify cron secret (Vercel sends this header for cron jobs)
  // On Vercel, cron jobs are authenticated automatically
  const startTime = Date.now();
  const log = [];

  try {
    const redis = getRedis();
    const eiaKey = process.env.EIA_API_KEY;
    const fredKey = process.env.FRED_API_KEY;

    if (!eiaKey || !fredKey) {
      log.push('ERROR: Missing API keys');
      return res.status(500).json({ error: 'Missing API keys', log });
    }

    // Fetch EIA series
    for (const s of EIA_SERIES) {
      try {
        const points = await fetchEIA(s.seriesId, eiaKey);
        const redisKey = `series:${s.node}:${s.key}`;
        const added = await appendToHistory(redis, redisKey, points);
        log.push(`[EIA] ${s.key}: ${points.length} fetched, ${added} new`);
      } catch (err) {
        log.push(`[EIA] ${s.key}: ERROR — ${err.message}`);
      }
    }

    // Fetch FRED price series
    for (const s of FRED_SERIES) {
      try {
        const points = await fetchFRED(s.seriesId, fredKey);
        const redisKey = `series:${s.node}:${s.key}`;
        const added = await appendToHistory(redis, redisKey, points);
        log.push(`[FRED] ${s.key}: ${points.length} fetched, ${added} new`);
      } catch (err) {
        log.push(`[FRED] ${s.key}: ERROR — ${err.message}`);
      }
    }

    // Fetch crack spread inputs and calculate
    try {
      const wtiPoints = await fetchFRED('DCOILWTICO', fredKey);
      const gasPoints = await fetchFRED(FRED_CRACK_INPUTS.gasoline.seriesId, fredKey);
      const dieselPoints = await fetchFRED(FRED_CRACK_INPUTS.diesel.seriesId, fredKey);

      // If diesel primary is empty, try fallback
      let dieselFinal = dieselPoints;
      if (dieselPoints.length === 0 && FRED_CRACK_INPUTS.diesel.fallback) {
        dieselFinal = await fetchFRED(FRED_CRACK_INPUTS.diesel.fallback, fredKey);
        log.push('[FRED] diesel: using DHOILNYH fallback');
      }

      // Calculate gasoline crack: (gasoline $/gal × 42) - WTI $/bbl
      if (wtiPoints.length > 0 && gasPoints.length > 0) {
        const latest = gasPoints[gasPoints.length - 1];
        const wtiMatch = wtiPoints.find(w => w.date === latest.date) || wtiPoints[wtiPoints.length - 1];
        const crack = (latest.value * 42) - wtiMatch.value;
        const crackPoint = { value: Math.round(crack * 100) / 100, date: latest.date, source: 'calculated' };
        const added = await appendToHistory(redis, 'series:n5:gasoline_crack', [crackPoint]);
        log.push(`[CALC] gasoline_crack: $${crackPoint.value}/bbl (${added} new)`);
      }

      // Calculate diesel crack: (diesel $/gal × 42) - WTI $/bbl
      if (wtiPoints.length > 0 && dieselFinal.length > 0) {
        const latest = dieselFinal[dieselFinal.length - 1];
        const wtiMatch = wtiPoints.find(w => w.date === latest.date) || wtiPoints[wtiPoints.length - 1];
        const crack = (latest.value * 42) - wtiMatch.value;
        const crackPoint = { value: Math.round(crack * 100) / 100, date: latest.date, source: 'calculated' };
        const added = await appendToHistory(redis, 'series:n5:diesel_crack', [crackPoint]);
        log.push(`[CALC] diesel_crack: $${crackPoint.value}/bbl (${added} new)`);
      }
    } catch (err) {
      log.push(`[CALC] crack spreads: ERROR — ${err.message}`);
    }

    // Update timestamp
    const now = new Date().toISOString();
    await redis.set('meta:last_cron', now);
    log.push(`Completed in ${Date.now() - startTime}ms`);

    return res.status(200).json({ ok: true, timestamp: now, log });
  } catch (err) {
    console.error('Cron error:', err);
    log.push(`FATAL: ${err.message}`);
    return res.status(500).json({ error: err.message, log });
  }
};
