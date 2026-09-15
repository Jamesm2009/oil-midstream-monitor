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
  // Fetch latest 200 records across ALL chokepoints (no WHERE filter — avoids
  // ArcGIS encoding issues with IN clauses). Filter client-side for our 5.
  const url = PORTWATCH_BASE
    + '?where=' + encodeURIComponent('1=1')
    + '&outFields=' + encodeURIComponent('date,portid,n_total,n_tanker')
    + '&f=json'
    + '&orderByFields=' + encodeURIComponent('date DESC')
    + '&resultRecordCount=200';

  const res = await fetch(url);
  if (!res.ok) throw new Error(`PortWatch HTTP ${res.status}`);
  const data = await res.json();

  // Diagnostic: surface what the API actually returned
  if (data.error) {
    throw new Error(`PortWatch API error: ${JSON.stringify(data.error)}`);
  }

  if (!data.features) {
    // Log the top-level keys so we can see the response shape
    const keys = Object.keys(data).join(', ');
    throw new Error(`PortWatch unexpected response shape — keys: ${keys}`);
  }

  if (data.features.length === 0) {
    throw new Error('PortWatch returned 0 features');
  }

  // Filter to our 5 chokepoints and group by portid
  const wanted = new Set(Object.keys(PORTWATCH_CHOKEPOINTS));
  const byChokepoint = {};

  for (const f of data.features) {
    const id = f.attributes.portid;
    if (!wanted.has(id)) continue;

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

  // Diagnostic: report which chokepoints we found
  const found = Object.keys(byChokepoint);
  const missing = [...wanted].filter(id => !byChokepoint[id]);
  if (found.length === 0) {
    // Grab a sample portid to show what the API actually contains
    const sampleIds = data.features.slice(0, 3).map(f => f.attributes.portid);
    throw new Error(`No matching chokepoints in ${data.features.length} features. Sample portids: ${sampleIds.join(', ')}`);
  }

  return { byChokepoint, found, missing, totalFeatures: data.features.length };
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

// /api/v1/jwc — Lloyd's Joint War Committee listed areas. Re-checked every
// 6 hours upstream. Per straits' own docs: updatedAt restamps on every check,
// lastChangedAt moves only when the circular itself changes. That is exactly
// the distinction the Monitor needs everywhere, and this endpoint is the only
// one that hands it over directly.
async function fetchJWC() {
  const r = await fetch('https://straits.live/api/v1/jwc');
  if (!r.ok) throw new Error(`straits jwc ${r.status}`);
  return r.json();
}

// ── Upstream vintage ────────────────────────────────────────────────────────
//
// straits publishes a per-section freshness signal, but the exact shape is not
// pinned down in their docs — the conventions note says to read "each section's
// verifiedAt" while the /status sample shows a top-level dataHealth map. So
// probe the plausible locations rather than assume one, and record which one
// answered. logStraitsShape() below prints what was actually found so this can
// be tightened to the real field next cycle.
//
// NOTE ON DATES. This records vintage ALONGSIDE the value; it does not change
// the date a point is filed under. Dating a curated field by its true vintage
// would immediately mark the five frozen straits fields stale, which would
// degrade N7 to unknown and change what the assessment reads. That is arguably
// the honest outcome, but it is a scoring decision, not a plumbing one, and it
// is deliberately left for a separate change.
function pickVintage(sl, section, sectionKey) {
  const health = (sl && sl.dataHealth && sl.dataHealth[sectionKey]) || null;
  const candidates = [
    section && section.lastChangedAt,   // truest: only moves on real change
    section && section.verifiedAt,
    health && health.verifiedAt,
    section && section.updatedAt,       // restamps on check — weakest
    health && health.asOf,
  ];
  let vintage = null;
  let field = null;
  const names = ['lastChangedAt', 'verifiedAt', 'dataHealth.verifiedAt', 'updatedAt', 'dataHealth.asOf'];
  for (let i = 0; i < candidates.length; i++) {
    if (typeof candidates[i] === 'string' && candidates[i].length > 0) {
      vintage = candidates[i];
      field = names[i];
      break;
    }
  }
  return {
    vintage: vintage,
    vintage_field: field,
    health: (health && (health.source || health.status)) || null,
  };
}

// Attach vintage to a stored point. Additive only — value and date keep their
// existing meaning, so nothing downstream changes shape.
function point(value, date, source, meta, curated) {
  const p = { value: value, date: date, source: source };
  if (meta) {
    if (meta.vintage) p.vintage = meta.vintage;
    if (meta.vintage_field) p.vintage_field = meta.vintage_field;
    if (meta.health) p.health = meta.health;
  }
  if (curated) p.curated = true;
  return p;
}


// Decide the date a straits point is filed under.
//
// straits' own dataHealth verdict drives this, not a list maintained here:
//   source "live"  → the reading is current; file under today as before.
//   otherwise      → curated. File under the upstream vintage, so a value that
//                    has not moved since August stops looking like today's.
//
// When a curated field offers no vintage at all, the point is NOT written.
// Writing it under today would restate exactly the lie this change removes, and
// a series that stops growing goes stale on its own, which is the fail-closed
// outcome. Every skip is logged.
function resolveDate(meta, today, isCurated) {
  if (!isCurated) return { date: today, basis: 'live' };
  const v = meta && meta.vintage;
  if (typeof v === 'string' && v.length > 0) {
    return { date: String(v).split('T')[0], basis: meta.vintage_field || 'vintage' };
  }
  return { date: null, basis: 'no vintage' };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// One-shot structural report so we stop guessing at straits' schema.
function logStraitsShape(sl, log) {
  try {
    log.push(`[STRAITS] top-level keys: ${Object.keys(sl).join(', ')}`);
    if (sl.dataHealth) {
      const dh = Object.keys(sl.dataHealth).map(k => {
        const v = sl.dataHealth[k] || {};
        return `${k}=${v.source || v.status || '?'}${v.verifiedAt ? '@' + v.verifiedAt : ''}`;
      });
      log.push(`[STRAITS] dataHealth: ${dh.join(' | ')}`);
    } else {
      log.push('[STRAITS] dataHealth: ABSENT');
    }
    for (const k of ['insurance', 'pipelineBypass', 'transits', 'aisGaps', 'vesselRisk']) {
      const s = sl[k];
      if (s && !Array.isArray(s) && typeof s === 'object') {
        const stamps = ['verifiedAt', 'lastChangedAt', 'updatedAt', 'asOf']
          .filter(f => s[f]).map(f => `${f}=${s[f]}`);
        log.push(`[STRAITS] ${k} stamps: ${stamps.length ? stamps.join(' ') : 'NONE'}`);
      }
    }
  } catch (err) {
    log.push(`[STRAITS] shape probe failed: ${err.message}`);
  }
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

    const jwcPromise = fetchJWC()
      .then(data => ({ status: 'ok', data }))
      .catch(err => ({ status: 'error', error: err.message }));

    // Wait for everything at once
    const [eiaResults, fredResults, crackResults, portWatchResult, straitsResult, jwcResult] = await Promise.all([
      Promise.all(eiaPromises),
      Promise.all(fredPromises),
      Promise.all(crackPromises),
      portWatchPromise,
      straitsPromise,
      jwcPromise,
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
      const { byChokepoint: pwData, found, missing, totalFeatures } = portWatchResult.data;
      log.push(`[PORTWATCH] ${totalFeatures} features fetched, ${found.length}/5 chokepoints matched${missing.length ? ', missing: ' + missing.join(', ') : ''}`);
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
      logStraitsShape(sl, log);

      // N1 — Pipeline bypass utilisation.
      // HAND-CURATED upstream: straits documents /api/v1/pipelines as
      // "hand-curated; timestamp refreshed weekly". These are declared rows,
      // not measurements. Petroline reading 0.0% cannot distinguish a shut line
      // from a partially flowing one, and no threshold here can recover that.
      if (sl.pipelineBypass && Array.isArray(sl.pipelineBypass)) {
        const pipeMeta = pickVintage(sl, sl.pipelineBypass, 'pipelines');
        const pipeCurated = pipeMeta.health !== 'live';
        const petroline = sl.pipelineBypass.find(p => p.id === 'petroline');
        const adcop = sl.pipelineBypass.find(p => p.id === 'adcop');

        // Guard the FIELD, not just the object. The old `if (petroline)` check
        // wrote {value: undefined} whenever straits dropped the percentage.
        if (petroline && isNum(petroline.currentUtilizationPct)) {
          const m0 = pickVintage(sl, petroline, 'pipelines');
          const m = m0.vintage ? m0 : pipeMeta;
          const d = resolveDate(m, today, pipeCurated);
          if (d.date === null) {
            log.push(`[STRAITS] petroline_pct: NOT WRITTEN — curated with no upstream vintage. Value seen: ${petroline.currentUtilizationPct}%. Series will go stale, which is correct.`);
          } else {
            const added = await appendToHistory(redis, 'series:n1:petroline_pct', [
              point(petroline.currentUtilizationPct, d.date, 'straits.live', m, pipeCurated)
            ]);
            log.push(`[STRAITS] petroline_pct: ${petroline.currentUtilizationPct}% filed ${d.date} via ${d.basis} (${added} new)`);
          }
        } else if (petroline) {
          log.push(`[STRAITS] petroline_pct: SKIPPED — currentUtilizationPct not numeric (${JSON.stringify(petroline.currentUtilizationPct)})`);
        }

        if (adcop && isNum(adcop.currentUtilizationPct)) {
          const m0 = pickVintage(sl, adcop, 'pipelines');
          const m = m0.vintage ? m0 : pipeMeta;
          const d = resolveDate(m, today, pipeCurated);
          if (d.date === null) {
            log.push(`[STRAITS] adcop_pct: NOT WRITTEN — curated with no upstream vintage. Value seen: ${adcop.currentUtilizationPct}%.`);
          } else {
            const added = await appendToHistory(redis, 'series:n1:adcop_pct', [
              point(adcop.currentUtilizationPct, d.date, 'straits.live', m, pipeCurated)
            ]);
            log.push(`[STRAITS] adcop_pct: ${adcop.currentUtilizationPct}% filed ${d.date} via ${d.basis} (${added} new)`);
          }
        } else if (adcop) {
          log.push(`[STRAITS] adcop_pct: SKIPPED — currentUtilizationPct not numeric (${JSON.stringify(adcop.currentUtilizationPct)})`);
        }

        // straits' nameplate for ADCOP is 1.5. The assessment carries 1.8,
        // corroborated independently. Log the disagreement rather than silently
        // inheriting theirs.
        if (adcop && isNum(adcop.capacityBpd)) {
          log.push(`[STRAITS] adcop nameplate upstream: ${adcop.capacityBpd} bpd (assessment carries 1.8M)`);
        }
      }

      // N2 — AIS-derived signals only. These are live feeds, not curated.
      if (sl.aisGaps && isNum(sl.aisGaps.count)) {
        const m = pickVintage(sl, sl.aisGaps, 'ships');
        const added = await appendToHistory(redis, 'series:n2:hormuz_dark_ais', [
          point(sl.aisGaps.count, today, 'straits.live/AIS', m, false)
        ]);
        log.push(`[STRAITS] hormuz_dark_ais: ${sl.aisGaps.count} (${added} new, baseline7d ${sl.aisGaps.baseline7d !== undefined ? sl.aisGaps.baseline7d : 'n/a'})`);
      } else if (sl.aisGaps) {
        log.push(`[STRAITS] hormuz_dark_ais: SKIPPED — count not numeric (${JSON.stringify(sl.aisGaps.count)})`);
      }

      if (isNum(sl.strandedOffshore)) {
        const m = pickVintage(sl, null, 'ships');
        const added = await appendToHistory(redis, 'series:n2:stranded_offshore', [
          point(sl.strandedOffshore, today, 'straits.live/AIS', m, false)
        ]);
        log.push(`[STRAITS] stranded_offshore: ${sl.strandedOffshore} (${added} new)`);
      } else if (sl.strandedOffshore !== undefined) {
        log.push(`[STRAITS] stranded_offshore: SKIPPED — not numeric (${JSON.stringify(sl.strandedOffshore)}). straits suppresses this when the AIS feed is quiet.`);
      }

      // N7 — Insurance & risk premium.
      // HAND-CURATED upstream, and straits says so: "hand-curated; timestamp
      // refreshed weekly", sourced as a straits.live estimate from carrier
      // advisories, Lloyd's List, TradeWinds and Reuters. This is one estimate,
      // not a second dashboard agreeing with anything.
      if (sl.insurance) {
        const m = pickVintage(sl, sl.insurance, 'insurance');
        const insCurated = m.health !== 'live';
        const d = resolveDate(m, today, insCurated);
        if (d.date === null) {
          log.push(`[STRAITS] insurance: NOT WRITTEN — curated with no upstream vintage. Seen: ${sl.insurance.multiple}x, $${sl.insurance.vlccPremiumHigh}. N7 will degrade to unknown as the series ages out, which is the intended behaviour.`);
        } else {
          const clubCount = Array.isArray(sl.insurance.withdrawnClubs) ? sl.insurance.withdrawnClubs.length : 0;
          if (isNum(sl.insurance.multiple)) {
            await appendToHistory(redis, 'series:n7:insurance_multiple', [
              point(sl.insurance.multiple, d.date, 'straits.live estimate', m, insCurated)
            ]);
          }
          if (isNum(sl.insurance.vlccPremiumHigh)) {
            await appendToHistory(redis, 'series:n7:vlcc_premium_high', [
              point(sl.insurance.vlccPremiumHigh, d.date, 'straits.live estimate', m, insCurated)
            ]);
          }
          await appendToHistory(redis, 'series:n7:clubs_withdrawn', [
            point(clubCount, d.date, 'straits.live estimate', m, insCurated)
          ]);
          log.push(`[STRAITS] insurance: ${sl.insurance.multiple}x, premium $${sl.insurance.vlccPremiumHigh}, ${clubCount} clubs filed ${d.date} via ${d.basis}`);
        }
        if (Array.isArray(sl.insurance.withdrawnClubs)) {
          log.push(`[STRAITS] clubs named: ${sl.insurance.withdrawnClubs.join(', ')}`);
        }
      }

      // N7 — JWC listed areas. lastChangedAt is the honest vintage; updatedAt
      // restamps on every 6-hourly check.
      if (jwcResult.status === 'error') {
        log.push(`[JWC] ERROR — ${jwcResult.error}`);
      } else {
        const j = jwcResult.data || {};
        const body = j.jwc || j;
        const changed = body.lastChangedAt || null;
        const areasVal = Array.isArray(body.areas)
          ? body.areas.join('; ')
          : (typeof body.areas === 'string' ? body.areas : (body.summary || null));
        if (areasVal) {
          const jDate = changed ? String(changed).split('T')[0] : today;
          const added = await appendToHistory(redis, 'series:n7:jwc_areas', [
            point(areasVal, jDate, "Lloyd's JWC circular via straits.live",
                  { vintage: changed, vintage_field: changed ? 'lastChangedAt' : null, health: null }, false)
          ]);
          log.push(`[JWC] jwc_areas: dated ${jDate} (${added} new)${body.mentionsArabianGulf !== undefined ? ', mentionsArabianGulf=' + body.mentionsArabianGulf : ''}`);
        } else {
          log.push(`[JWC] no usable areas field — keys: ${Object.keys(body).join(', ')}`);
        }
      }

      // N8 — Sanctions / vessel risk.
      if (sl.vesselRisk && isNum(sl.vesselRisk.high)) {
        const m = pickVintage(sl, sl.vesselRisk, 'vessels');
        const added = await appendToHistory(redis, 'series:n8:vessels_high_risk', [
          point(sl.vesselRisk.high, today, 'straits.live/AIS+OFAC', m, false)
        ]);
        log.push(`[STRAITS] vessels_high_risk: ${sl.vesselRisk.high} (${added} new)`);
      }

      // Carriers: HAND-CURATED, and we were reading the wrong field. straits
      // documents hormuzPosture as the operative one — five carriers at
      // "stopped" is what drives their own closed verdict — while `status`
      // carries Red Sea posture that says nothing about Hormuz. Count both and
      // log the difference until the two are reconciled; keep writing `status`
      // so the stored series does not silently change basis mid-flight.
      if (sl.carrierSuspensions && Array.isArray(sl.carrierSuspensions)) {
        const cm = pickVintage(sl, null, 'carriers');
        const byStatus = sl.carrierSuspensions.filter(c => c.status === 'rerouting' || c.status === 'suspended').length;
        const byPosture = sl.carrierSuspensions.filter(c => c.hormuzPosture === 'stopped').length;
        const authored = sl.carrierSuspensions
          .map(c => c.authoredAt)
          .filter(a => typeof a === 'string' && a.length > 0)
          .sort();
        const newestAuthored = authored.length ? authored[authored.length - 1] : null;

        const meta = {
          vintage: newestAuthored || cm.vintage,
          vintage_field: newestAuthored ? 'newest authoredAt' : cm.vintage_field,
          health: cm.health,
        };
        const carrierCurated = cm.health !== 'live';
        const d = resolveDate(meta, today, carrierCurated);
        if (d.date === null) {
          log.push(`[STRAITS] carriers_rerouting: NOT WRITTEN — curated with no authoredAt and no vintage. Seen: ${byStatus} of ${sl.carrierSuspensions.length}.`);
        } else {
          const added = await appendToHistory(redis, 'series:n8:carriers_rerouting', [
            point(byStatus, d.date, 'straits.live (curated)', meta, carrierCurated)
          ]);
          log.push(`[STRAITS] carriers_rerouting: ${byStatus} of ${sl.carrierSuspensions.length} by status, filed ${d.date} via ${d.basis} (${added} new)`);
        }
        log.push(`[STRAITS] carriers by hormuzPosture=stopped: ${byPosture} — straits' own closed-verdict basis. Differs from stored value: ${byPosture !== byStatus}`);
        log.push(`[STRAITS] carriers newest authoredAt: ${newestAuthored || 'ABSENT'}`);
      }
    }

    // Update timestamp
    const now = new Date().toISOString();
    await redis.set('meta:last_cron', now);
    log.push(`Completed in ${Date.now() - startTime}ms`);

    // The cron invoker discards the response body, so the log only existed in
    // a place nobody could read. Every run now lands in the Vercel runtime log.
    console.log('[CRON]\n' + log.join('\n'));

    return res.status(200).json({ ok: true, timestamp: now, log });
  } catch (err) {
    console.error('Cron error:', err);
    log.push(`FATAL: ${err.message}`);
    console.log('[CRON]\n' + log.join('\n'));
    return res.status(500).json({ error: err.message, log });
  }
};
