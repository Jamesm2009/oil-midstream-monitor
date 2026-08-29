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
  { key: 'us_crude_exports_wk', node: 'n6', seriesId: 'PET.WCREXUS2.W', freq: 'weekly' },
  { key: 'us_crude_production', node: 'n6', seriesId: 'PET.WCRFPUS2.W', freq: 'weekly' },
];

// FRED daily series
const FRED_SERIES = [
  { key: 'wti', node: 'n5', seriesId: 'DCOILWTICO' },
  { key: 'brent', node: 'n5', seriesId: 'DCOILBRENTEU' },
];

// FRED series for crack spread inputs (not stored directly)
const FRED_CRACK_INPUTS = {
  gasoline: { seriesId: 'DGASNYH', fallback: null },
  diesel: { seriesId: 'DDFUELNYH', fallback: 'DHOILNYH' },
};

// IMF PortWatch — direct ArcGIS REST API (public, no key, CC0)
// Updates weekly on Tuesdays 9 AM ET with ~7 day processing lag
const PORTWATCH_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const PORTWATCH_CHOKEPOINTS = {
  'chokepoint6': { name: 'Hormuz',         total_key: 'hormuz_portwatch', tanker_key: 'hormuz_tanker' },
  'chokepoint4': { name: 'Bab el-Mandeb',  total_key: 'bab_portwatch',    tanker_key: null },
  'chokepoint1': { name: 'Suez',           total_key: 'suez_portwatch',   tanker_key: null },
  'chokepoint7': { name: 'Cape',           total_key: 'cape_portwatch',   tanker_key: null },
  'chokepoint2': { name: 'Panama',         total_key: 'panama_portwatch', tanker_key: null },
};

async function fetchEIA(seriesId, apiKey) {
  const url = `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${apiKey}&length=5&sort[0][column]=period&sort[0][direction]=desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EIA API error: ${res.status}`);
  const data = await res.json();

  if (data?.response?.data && data.response.data.length > 0) {
    return data.response.data.map(d => ({
      value: parseFloat(d.value),
      date: d.period,
      source: 'EIA',
    })).reverse();
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
      .reverse();
  }
  return [];
}

async function fetchPortWatch() {
  // Query all 5 chokepoints in one request — last 14 days
  const ids = Object.keys(PORTWATCH_CHOKEPOINTS).map(id => `'${id}'`).join(',');
  const since = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    where: `portid IN (${ids}) AND date >= ${since}`,
    outFields: 'date,portid,n_total,n_tanker',
    f: 'json',
    orderByFields: 'date DESC',
    resultRecordCount: '100',
  });

  const res = await fetch(`${PORTWATCH_BASE}?${params}`);
  if (!res.ok) throw new Error(`PortWatch API error: ${res.status}`);
  const data = await res.json();

  if (!data.features || data.features.length === 0) {
    throw new Error('PortWatch returned no features');
  }

  // Group by chokepoint, convert epoch ms → ISO date
  const byChokepoint = {};
  for (const f of data.features) {
    const id = f.attributes.portid;
    const dateMs = f.attributes.date;
    const date = new Date(dateMs).toISOString().split('T')[0];
    if (!byChokepoint[id]) byChokepoint[id] = [];
    byChokepoint[id].push({
      date,
      n_total: f.attributes.n_total,
      n_tanker: f.attributes.n_tanker,
    });
  }

  // Sort each chokepoint's points by date ascending (for appendToHistory)
  for (const id of Object.keys(byChokepoint)) {
    byChokepoint[id].sort((a, b) => a.date.localeCompare(b.date));
  }

  return byChokepoint;
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

async function fetchStraits() {
  const straitsRes = await fetch('https://straits.live/status');
  if (!straitsRes.ok) throw new Error(`straits.live ${straitsRes.status}`);
  return straitsRes.json();
}

module.exports = async (req, res) => {
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

    // ── PHASE 1: Fire ALL external API calls in parallel ──
    const eiaPromises = EIA_SERIES.map(s =>
      fetchEIA(s.seriesId, eiaKey)
        .then(points => ({ status: 'ok', key: s.key, node: s.node, points }))
        .catch(err => ({ status: 'error', key: s.key, error: err.message }))
    );

    const fredPromises = FRED_SERIES.map(s =>
      fetchFRED(s.seriesId, fredKey)
        .then(points => ({ status: 'ok', key: s.key, node: s.node, points }))
        .catch(err => ({ status: 'error', key: s.key, error: err.message }))
    );

    const crackPromises = [
      fetchFRED('DCOILWTICO', fredKey).catch(() => []),
      fetchFRED(FRED_CRACK_INPUTS.gasoline.seriesId, fredKey).catch(() => []),
      fetchFRED(FRED_CRACK_INPUTS.diesel.seriesId, fredKey).catch(() => []),
    ];

    const portWatchPromise = fetchPortWatch()
      .then(data => ({ status: 'ok', data }))
      .catch(err => ({ status: 'error', error: err.message }));

    const straitsPromise = fetchStraits()
      .then(data => ({ status: 'ok', data }))
      .catch(err => ({ status: 'error', error: err.message }));

    // Wait for everything at once
    const [eiaResults, fredResults, crackResults, portWatchResult, straitsResult] = await Promise.all([
      Promise.all(eiaPromises),
      Promise.all(fredPromises),
      Promise.all(crackPromises),
      portWatchPromise,
      straitsPromise,
    ]);

    log.push(`API calls completed in ${Date.now() - startTime}ms`);

    // ── PHASE 2: Process results and write to Redis ──

    // EIA series
    for (const r of eiaResults) {
      if (r.status === 'error') {
        log.push(`[EIA] ${r.key}: ERROR — ${r.error}`);
        continue;
      }
      const redisKey = `series:${r.node}:${r.key}`;
      const added = await appendToHistory(redis, redisKey, r.points);
      log.push(`[EIA] ${r.key}: ${r.points.length} fetched, ${added} new`);
    }

    // FRED series
    for (const r of fredResults) {
      if (r.status === 'error') {
        log.push(`[FRED] ${r.key}: ERROR — ${r.error}`);
        continue;
      }
      const redisKey = `series:${r.node}:${r.key}`;
      const added = await appendToHistory(redis, redisKey, r.points);
      log.push(`[FRED] ${r.key}: ${r.points.length} fetched, ${added} new`);
    }

    // Crack spread calculations
    try {
      const [wtiPoints, gasPoints, dieselPoints] = crackResults;

      // If diesel primary is empty, try fallback
      let dieselFinal = dieselPoints;
      if (dieselPoints.length === 0 && FRED_CRACK_INPUTS.diesel.fallback) {
        dieselFinal = await fetchFRED(FRED_CRACK_INPUTS.diesel.fallback, fredKey);
        log.push('[FRED] diesel: using DHOILNYH fallback');
      }

      // Gasoline crack: (gasoline $/gal × 42) - WTI $/bbl
      if (wtiPoints.length > 0 && gasPoints.length > 0) {
        const latest = gasPoints[gasPoints.length - 1];
        const wtiMatch = wtiPoints.find(w => w.date === latest.date) || wtiPoints[wtiPoints.length - 1];
        const crack = (latest.value * 42) - wtiMatch.value;
        const crackPoint = { value: Math.round(crack * 100) / 100, date: latest.date, source: 'calculated' };
        const added = await appendToHistory(redis, 'series:n5:gasoline_crack', [crackPoint]);
        log.push(`[CALC] gasoline_crack: $${crackPoint.value}/bbl (${added} new)`);
      }

      // Diesel crack: (diesel $/gal × 42) - WTI $/bbl
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

    // ── IMF PortWatch processing (N2 chokepoint transits) ──
    if (portWatchResult.status === 'error') {
      log.push(`[PORTWATCH] ERROR — ${portWatchResult.error}`);
    } else {
      const pwData = portWatchResult.data;
      let pwTotal = 0;

      for (const [portId, config] of Object.entries(PORTWATCH_CHOKEPOINTS)) {
        const points = pwData[portId];
        if (!points || points.length === 0) {
          log.push(`[PORTWATCH] ${config.name}: no data`);
          continue;
        }

        // Store total transits (n_total)
        const totalPoints = points.map(p => ({
          value: p.n_total,
          date: p.date,
          source: 'IMF PortWatch',
        }));
        const totalAdded = await appendToHistory(redis, `series:n2:${config.total_key}`, totalPoints);
        const latest = points[points.length - 1];
        log.push(`[PORTWATCH] ${config.name}: ${latest.n_total}/day (${totalAdded} new, latest ${latest.date})`);
        pwTotal += totalAdded;

        // Store tanker transits if configured (Hormuz only)
        if (config.tanker_key) {
          const tankerPoints = points.map(p => ({
            value: p.n_tanker,
            date: p.date,
            source: 'IMF PortWatch',
          }));
          const tankerAdded = await appendToHistory(redis, `series:n2:${config.tanker_key}`, tankerPoints);
          log.push(`[PORTWATCH] ${config.name} tankers: ${latest.n_tanker}/day (${tankerAdded} new)`);
        }
      }

      log.push(`[PORTWATCH] Total new points: ${pwTotal}`);
    }

    // ── Straits.live processing (AIS, pipelines, insurance, sanctions — NOT PortWatch) ──
    if (straitsResult.status === 'error') {
      log.push(`[STRAITS] ERROR — ${straitsResult.error}`);
    } else {
      const sl = straitsResult.data;
      const today = sl.asOf ? sl.asOf.split('T')[0] : new Date().toISOString().split('T')[0];

      // N1 — Pipeline bypass utilisation
      if (sl.pipelineBypass && Array.isArray(sl.pipelineBypass)) {
        const petroline = sl.pipelineBypass.find(p => p.id === 'petroline');
        const adcop = sl.pipelineBypass.find(p => p.id === 'adcop');
        if (petroline) {
          const added = await appendToHistory(redis, 'series:n1:petroline_pct', [
            { value: petroline.currentUtilizationPct, date: today, source: 'straits.live' }
          ]);
          log.push(`[STRAITS] petroline_pct: ${petroline.currentUtilizationPct}% (${added} new)`);
        }
        if (adcop) {
          const added = await appendToHistory(redis, 'series:n1:adcop_pct', [
            { value: adcop.currentUtilizationPct, date: today, source: 'straits.live' }
          ]);
          log.push(`[STRAITS] adcop_pct: ${adcop.currentUtilizationPct}% (${added} new)`);
        }
      }

      // N2 — AIS-derived signals only (PortWatch transits now come from direct API above)
      if (sl.aisGaps) {
        const added = await appendToHistory(redis, 'series:n2:hormuz_dark_ais', [
          { value: sl.aisGaps.count, date: today, source: 'straits.live/AIS' }
        ]);
        log.push(`[STRAITS] hormuz_dark_ais: ${sl.aisGaps.count} (${added} new)`);
      }

      if (sl.strandedOffshore !== undefined) {
        const added = await appendToHistory(redis, 'series:n2:stranded_offshore', [
          { value: sl.strandedOffshore, date: today, source: 'straits.live/AIS' }
        ]);
        log.push(`[STRAITS] stranded_offshore: ${sl.strandedOffshore} (${added} new)`);
      }

      // N7 — Insurance & risk premium
      if (sl.insurance) {
        const insDate = sl.insurance.updatedAt ? sl.insurance.updatedAt.split('T')[0] : today;
        await appendToHistory(redis, 'series:n7:insurance_multiple', [
          { value: sl.insurance.multiple, date: insDate, source: 'straits.live' }
        ]);
        await appendToHistory(redis, 'series:n7:vlcc_premium_high', [
          { value: sl.insurance.vlccPremiumHigh, date: insDate, source: 'straits.live' }
        ]);
        const clubCount = sl.insurance.withdrawnClubs ? sl.insurance.withdrawnClubs.length : 0;
        await appendToHistory(redis, 'series:n7:clubs_withdrawn', [
          { value: clubCount, date: insDate, source: 'straits.live' }
        ]);
        log.push(`[STRAITS] insurance: ${sl.insurance.multiple}x, premium $${sl.insurance.vlccPremiumHigh}, ${clubCount} clubs withdrawn`);
      }

      // N8 — Sanctions / vessel risk
      if (sl.vesselRisk) {
        const added = await appendToHistory(redis, 'series:n8:vessels_high_risk', [
          { value: sl.vesselRisk.high, date: today, source: 'straits.live/AIS+OFAC' }
        ]);
        log.push(`[STRAITS] vessels_high_risk: ${sl.vesselRisk.high} (${added} new)`);
      }

      if (sl.carrierSuspensions && Array.isArray(sl.carrierSuspensions)) {
        const rerouting = sl.carrierSuspensions.filter(c => c.status === 'rerouting' || c.status === 'suspended').length;
        const added = await appendToHistory(redis, 'series:n8:carriers_rerouting', [
          { value: rerouting, date: today, source: 'straits.live' }
        ]);
        log.push(`[STRAITS] carriers_rerouting: ${rerouting} of ${sl.carrierSuspensions.length} (${added} new)`);
      }
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
