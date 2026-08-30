// /api/assessment-snapshot.js
// Comprehensive data dump for Claude to consume during assessment pre-build
// Returns all 8 nodes: status, key metrics, staleness flags, alerts
// Protected by simple API key (query param) — no CDN cache
//
// Usage: GET /api/assessment-snapshot?key=YOUR_API_KEY

const { getRedis } = require('../lib/redis');
const { NODES, STALE_THRESHOLDS } = require('../lib/config');

// Series whose staleness materially affects assessment conclusions
const SCORING_SERIES = new Set([
  'floating_storage_world', 'floating_storage_mideast',
  'shadow_fleet_share', 'west_africa_diff',
  'warrisk_band', 'g7_carriage_share',
]);

// Series that are event-driven and safe to skip if stale
const OK_TO_SKIP_CADENCES = new Set(['as_changed']);

// Pre-war baselines (same as recovery-inputs)
const BASELINES = {
  hormuz_daily: 24,
  bab_daily: 45,
  insurance_multiple: 1.0,
  diesel_crack_normal: 25,
};
const EPCA_FLOOR = 252.4;

module.exports = async function handler(req,   // API key auth
  const providedKey = req.query.key;
  const envKey = process.env.SNAPSHOT_API_KEY;
  if (!providedKey || providedKey !== envKey) {
    return res.status(401).json({
      error: 'Invalid or missing API key',
      debug: {
        env_defined: !!envKey,
        env_length: envKey ? envKey.length : 0,
        provided_length: providedKey ? providedKey.length : 0,
        match: providedKey === envKey,
      }
    });
  }


  // No cache — always fresh for assessment builds
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const redis = getRedis();
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // ── Load all node statuses in parallel ──
    const statusPromises = NODES.map(n =>
      redis.get(`status:${n.id}`).then(s => [n.id, s])
    );
    const statusEntries = await Promise.all(statusPromises);
    const statusMap = Object.fromEntries(statusEntries);

    // ── Load all series data in parallel ──
    const seriesRequests = [];
    for (const node of NODES) {
      for (const series of node.series) {
        seriesRequests.push({
          nodeId: node.id,
          key: series.key,
          label: series.label,
          unit: series.unit,
          manual: series.manual,
          cadence: series.cadence,
          source: series.source || (series.manual ? 'manual' : 'unknown'),
          redisKey: `series:${node.id}:${series.key}`,
        });
      }
    }

    const seriesDataPromises = seriesRequests.map(s =>
      redis.get(s.redisKey).then(data => ({ ...s, data }))
    );
    const allSeriesData = await Promise.all(seriesDataPromises);

    // Index series data by node → key
    const seriesByNode = {};
    for (const s of allSeriesData) {
      if (!seriesByNode[s.nodeId]) seriesByNode[s.nodeId] = {};
      seriesByNode[s.nodeId][s.key] = s;
    }

    // ── Build node details ──
    const nodes = {};
    const allStale = {};
    const criticalStale = [];
    const okToSkip = [];

    for (const node of NODES) {
      const nodeId = node.id;
      const nodeKey = nodeId.toUpperCase(); // N1, N2, etc. for response
      const statusObj = statusMap[nodeId];
      const status = statusObj?.status || 'green';
      const statusOverride = statusObj?.override || null;

      const automated = {};
      const manual = {};
      const staleSeries = [];

      const nodeSeries = seriesByNode[nodeId] || {};

      for (const [key, s] of Object.entries(nodeSeries)) {
        const latest = getLatest(s.data);
        const latestDate = getLatestDate(s.data);
        const isStale = checkStale(latestDate, s.cadence, now);

        // Convert units for display
        const { displayValue, displayUnit } = convertUnits(
          latest, s.unit
        );

        if (s.manual) {
          manual[key] = {
            value: displayValue,
            unit: displayUnit,
            last_updated: latestDate || 'never',
            stale: isStale,
            source: s.source,
          };
        } else {
          automated[key] = {
            value: displayValue,
            unit: displayUnit,
            date: latestDate || 'unknown',
            source: s.source,
          };
        }

        if (isStale) {
          staleSeries.push(key);

          // Classify stale series
          if (SCORING_SERIES.has(key)) {
            criticalStale.push(key);
          } else if (OK_TO_SKIP_CADENCES.has(s.cadence)) {
            okToSkip.push(key);
          }
        }
      }

      if (staleSeries.length > 0) {
        allStale[nodeKey] = staleSeries;
      }

      // Find the threshold description from config
      const statusLogic = (node.thresholdInfo && node.thresholdInfo.length > 0)
        ? node.thresholdInfo.filter(t => t.startsWith('RED:')).join('; ') || node.thresholdInfo[0]
        : '';

      nodes[nodeKey] = {
        name: node.name,
        status,
        status_override: statusOverride,
        automated_metrics: automated,
        manual_metrics: manual,
        stale_series: staleSeries,
        status_logic: statusLogic,
      };
    }

    // ── Build summary ──
    const redNodes = [];
    const amberNodes = [];
    const greenNodes = [];
    for (const [key, node] of Object.entries(nodes)) {
      if (node.status === 'red') redNodes.push(key);
      else if (node.status === 'amber') amberNodes.push(key);
      else greenNodes.push(key);
    }

    const compoundParts = [];
    if (redNodes.length > 0) compoundParts.push(`${redNodes.length} red`);
    if (amberNodes.length > 0) compoundParts.push(`${amberNodes.length} amber`);
    if (greenNodes.length > 0) compoundParts.push(`${greenNodes.length} green`);
    const compoundLabel = redNodes.length >= 4
      ? `${compoundParts.join(' + ')} — systemic stress pattern`
      : redNodes.length >= 2
        ? `${compoundParts.join(' + ')} — elevated stress`
        : compoundParts.join(' + ');

    const summary = {
      red_nodes: redNodes,
      amber_nodes: amberNodes,
      green_nodes: greenNodes,
      compound_stress: compoundLabel,
    };

    // ── Stale summary ──
    const totalStale = Object.values(allStale).flat().length;
    const staleSummary = {
      total_stale: totalStale,
      by_node: allStale,
      critical_stale: [...new Set(criticalStale)],
      ok_to_skip: [...new Set(okToSkip)],
    };

    // ── Alerts ──
    const alerts = buildAlerts(nodes, seriesByNode);

    // ── Market snapshot (from automated series) ──
    const market = buildMarketSnapshot(seriesByNode);

    // ── Recovery gap inputs ──
    const recoveryInputs = buildRecoveryInputs(seriesByNode);

    // ── Cron metadata ──
    const lastCron = await redis.get('meta:last_cron');
    const cronAgeMs = lastCron ? Date.now() - new Date(lastCron).getTime() : null;
    const cronAgeHours = cronAgeMs !== null ? round(cronAgeMs / 3600000, 2) : null;

    return res.status(200).json({
      timestamp: now.toISOString(),
      last_cron: lastCron || null,
      cron_age_hours: cronAgeHours,
      summary,
      nodes,
      stale_summary: staleSummary,
      alerts,
      market_snapshot: market,
      recovery_gap_inputs: recoveryInputs,
    });
  } catch (err) {
    console.error('assessment-snapshot error:', err);
    return res.status(500).json({
      error: 'Failed to build snapshot',
      detail: err.message,
    });
  }
};

// ─── Helpers ───────────────────────────────────────────────────

function getLatest(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  const entry = data[data.length - 1];
  return entry.value !== undefined ? entry.value : null;
}

function getLatestDate(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  return data[data.length - 1].date || null;
}

function checkStale(dateStr, cadence, now) {
  if (!dateStr) return true;
  const threshold = STALE_THRESHOLDS[cadence];
  if (!threshold) return false; // unknown cadence → don't flag
  const age = (now.getTime() - new Date(dateStr).getTime()) / (24 * 3600 * 1000);
  return age > threshold;
}

function convertUnits(value, unit) {
  if (value === null || value === undefined) {
    return { displayValue: null, displayUnit: unit };
  }
  if (unit === 'K bbl') {
    return { displayValue: round(value / 1000, 1), displayUnit: 'mb' };
  }
  if (unit === 'K bbl/d') {
    return { displayValue: round(value / 1000, 2), displayUnit: 'mbd' };
  }
  return { displayValue: value, displayUnit: unit };
}

function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  return Math.round(n * 10 ** d) / 10 ** d;
}

// ─── Alert generation ──────────────────────────────────────────

function buildAlerts(nodes, seriesByNode) {
  const alerts = [];

  // N5: diesel crack extremes
  const dieselVal = getLatest(seriesByNode.n5?.diesel_crack?.data);
  if (dieselVal !== null && dieselVal > 40) {
    const multiple = round(dieselVal / BASELINES.diesel_crack_normal, 1);
    alerts.push(`N5 diesel crack $${round(dieselVal, 0)}/bbl (${multiple}× normal) — red threshold exceeded`);
  }

  // N4: SPR buffer
  const sprVal = getLatest(seriesByNode.n4?.spr_level?.data);
  if (sprVal !== null) {
    const sprMb = round(sprVal / 1000, 1);
    const buffer = round(sprMb - EPCA_FLOOR, 1);
    if (buffer < 50) {
      alerts.push(`N4 SPR buffer above EPCA floor now ${buffer}mb — ${buffer < 30 ? 'critical' : 'approaching operational minimum'}`);
    }
  }

  // N4: Cushing
  const cushingVal = getLatest(seriesByNode.n4?.cushing?.data);
  if (cushingVal !== null && cushingVal < 20000) {
    const cushingMb = round(cushingVal / 1000, 1);
    alerts.push(`N4 Cushing at ${cushingMb}mb — ${cushingVal < 18000 ? 'below operational minimum' : 'near tank bottoms'}`);
  }

  // N7: insurance multiple
  const insVal = getLatest(seriesByNode.n7?.insurance_multiple?.data);
  if (insVal !== null && insVal >= 10) {
    const clubs = getLatest(seriesByNode.n7?.clubs_withdrawn?.data);
    const clubNote = clubs ? ` — ${clubs} P&I clubs withdrawn` : '';
    alerts.push(`N7 insurance multiple ${insVal}×${clubNote}`);
  }

  // N2: Hormuz AIS dark fleet
  const darkVal = getLatest(seriesByNode.n2?.hormuz_dark_ais?.data);
  if (darkVal !== null && darkVal > 30) {
    alerts.push(`N2 Hormuz AIS dark count ${darkVal} — AIS reliability degrading`);
  }

  // N2: Hormuz transits critically low
  const hormuzVal = getLatest(seriesByNode.n2?.hormuz_portwatch?.data);
  if (hormuzVal !== null && hormuzVal <= 15) {
    alerts.push(`N2 Hormuz transits at ${hormuzVal}/day — near-complete closure`);
  }

  // N8: carrier rerouting
  const rerouteVal = getLatest(seriesByNode.n8?.carriers_rerouting?.data);
  if (rerouteVal !== null && rerouteVal >= 4) {
    alerts.push(`N8 ${rerouteVal} major carriers rerouting away from Hormuz`);
  }

  // N1: bypass at capacity
  const petroline = getLatest(seriesByNode.n1?.petroline_pct?.data);
  const adcop = getLatest(seriesByNode.n1?.adcop_pct?.data);
  if (petroline !== null && petroline >= 95) {
    alerts.push(`N1 Petroline bypass at ${petroline}% — ${petroline >= 98 ? 'effectively at capacity' : 'approaching capacity'}`);
  }

  // N3: floating storage
  const worldStorage = getLatest(seriesByNode.n3?.floating_storage_world?.data);
  if (worldStorage !== null && worldStorage > 120000) {
    alerts.push(`N3 world floating storage ${round(worldStorage / 1000, 0)}M bbl — fleet absorption ${worldStorage > 140000 ? 'at crisis level' : 'elevated'}`);
  }

  return alerts;
}

// ─── Market snapshot ───────────────────────────────────────────

function buildMarketSnapshot(seriesByNode) {
  const wti = getLatest(seriesByNode.n5?.wti?.data);
  const brent = getLatest(seriesByNode.n5?.brent?.data);
  const hormuz = getLatest(seriesByNode.n2?.hormuz_portwatch?.data);
  const sprKbbl = getLatest(seriesByNode.n4?.spr_level?.data);
  const dieselCrack = getLatest(seriesByNode.n5?.diesel_crack?.data);
  const gasolineCrack = getLatest(seriesByNode.n5?.gasoline_crack?.data);

  return {
    wti,
    brent,
    diesel_crack: dieselCrack,
    gasoline_crack: gasolineCrack,
    hormuz_transits: hormuz,
    spr: sprKbbl !== null ? round(sprKbbl / 1000, 1) : null,
    // These fields are needed for market_history.json but not tracked
    // in the monitor — Claude should web-search for current values:
    not_tracked: ['tnx (10Y yield)', 'us30y (30Y yield)', 'usdjpy'],
  };
}

// ─── Recovery gap inputs ───────────────────────────────────────

function buildRecoveryInputs(seriesByNode) {
  const hormuz = getLatest(seriesByNode.n2?.hormuz_portwatch?.data);
  const bab = getLatest(seriesByNode.n2?.bab_portwatch?.data);
  const insMult = getLatest(seriesByNode.n7?.insurance_multiple?.data);
  const dieselCrack = getLatest(seriesByNode.n5?.diesel_crack?.data);
  const sprKbbl = getLatest(seriesByNode.n4?.spr_level?.data);
  const sprMb = sprKbbl !== null ? round(sprKbbl / 1000, 1) : null;
  const sprBuf = sprMb !== null ? round(sprMb - EPCA_FLOOR, 1) : null;
  const dcm = dieselCrack !== null ? dieselCrack / BASELINES.diesel_crack_normal : null;

  return {
    hormuz_daily: hormuz,
    bab_daily: bab,
    insurance_multiple: insMult,
    diesel_crack: dieselCrack,
    spr_mb: sprMb,
    route_status: hormuz === null ? 'unknown'
      : hormuz < 5 ? 'cape'
      : hormuz <= 15 ? 'partial'
      : 'full',
    insurance_months: insMult === null ? null
      : insMult > 20 ? 4 : insMult > 10 ? 3 : insMult > 5 ? 2 : 1,
    refinery_ramp_months: dcm === null ? null
      : dcm > 3 ? 2 : dcm > 2 ? 1.5 : dcm > 1 ? 1 : 0.5,
    stocks_rebuild_months: sprBuf === null ? null
      : sprBuf < 20 ? 4 : sprBuf < 40 ? 3 : sprBuf < 80 ? 2 : 1,
  };
}
