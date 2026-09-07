// api/assessment-snapshot.js
//
// CHANGELOG (Sep 7, 2026):
// - SCORES ITS OWN NODES. This route used to read a `status` field from
//   redis key `status:<node>`. Nothing has ever written that field:
//   api/status-override.js writes only { override, updated }, and api/data.js
//   computes status live without persisting it. So `statusObj.status` was
//   always undefined and the old default published GREEN for all eight nodes
//   on every request, regardless of the data. It now calls
//   calculateNodeStatus() over the same series it already loads, exactly as
//   api/data.js does, so the two routes cannot disagree.
// - `status:<node>` is still read, but only for the manual override.
// - OVERRIDE MASKING SURFACED, matching api/data.js: an override that presents
//   a worse computed status as something calmer is flagged, not hidden.
// - FAIL-CLOSED BUCKETING. 'unknown' has its own bucket and its own summary
//   array. Anything unrecognised degrades to 'unknown', never 'green'.
// - DUPLICATE CONFIG REMOVED. This file carried its own copy of NODES and its
//   own STALE_DAYS map, both of which had to be edited in lockstep with
//   lib/config.js. Both now come from lib/config.js.
//
// NOTE: summary.green_nodes is narrower than before — it no longer absorbs
// unknowns. summary gains unknown_nodes, masked_nodes, worst and
// snapshot_schema. Node blocks gain status_auto, status_reasons,
// rejected_inputs, critical_missing, degraded and override_masking.

const { getRedis } = require('../lib/redis');
const { NODES, STALE_THRESHOLDS } = require('../lib/config');
const { calculateNodeStatus, worstStatus, SEVERITY } = require('../lib/thresholds');

// Severity order matches lib/thresholds.js: red > unknown > amber > green.
var VALID_STATUSES = ['red', 'unknown', 'amber', 'green'];

var SCORING_KEYS = [
  'floating_storage_world', 'floating_storage_mideast',
  'shadow_fleet_share', 'west_africa_diff',
  'warrisk_band', 'g7_carriage_share'
];

var SKIP_CADENCES = ['as_changed'];

var EPCA_FLOOR = 252.4;


module.exports = async function handler(req, res) {
      var providedKey = req.query.key;
  if (!providedKey || providedKey !== process.env.SNAPSHOT_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    var redis = getRedis();
    var now = new Date();

    // Load all statuses in parallel
    var statusResults = await Promise.all(
      NODES.map(function(n) {
        return redis.get('status:' + n.id).then(function(s) { return [n.id, s]; });
      })
    );
    var statusMap = {};
    for (var si = 0; si < statusResults.length; si++) {
      statusMap[statusResults[si][0]] = statusResults[si][1];
    }

    // Load all series in parallel
    var seriesRequests = [];
    for (var ni = 0; ni < NODES.length; ni++) {
      var node = NODES[ni];
      for (var sj = 0; sj < node.series.length; sj++) {
        var s = node.series[sj];
        seriesRequests.push({
          nodeId: node.id,
          key: s.key,
          unit: s.unit,
          manual: s.manual,
          cadence: s.cadence,
          source: s.source || 'manual',
          redisKey: 'series:' + node.id + ':' + s.key
        });
      }
    }

    var seriesResults = await Promise.all(
      seriesRequests.map(function(s) {
        return redis.get(s.redisKey).then(function(data) {
          return { nodeId: s.nodeId, key: s.key, unit: s.unit, manual: s.manual, cadence: s.cadence, source: s.source, data: data, readError: null };
        }).catch(function(err) {
          // Do not let a transport failure masquerade as an empty series.
          return { nodeId: s.nodeId, key: s.key, unit: s.unit, manual: s.manual, cadence: s.cadence, source: s.source, data: null, readError: err.message || String(err) };
        });
      })
    );

    // Index by node
    var seriesByNode = {};
    for (var ri = 0; ri < seriesResults.length; ri++) {
      var r = seriesResults[ri];
      if (!seriesByNode[r.nodeId]) seriesByNode[r.nodeId] = {};
      seriesByNode[r.nodeId][r.key] = r;
    }

    // Build node details
    var nodes = {};
    var allStale = {};
    var criticalStale = [];
    var okToSkip = [];
    var redNodes = [];
    var amberNodes = [];
    var greenNodes = [];
    var unknownNodes = [];
    var maskedNodes = [];
    var allStatuses = [];

    for (var i = 0; i < NODES.length; i++) {
      var nd = NODES[i];
      var nid = nd.id;
      var nkey = nid.toUpperCase();

      var automated = {};
      var manual = {};
      var staleSeries = [];
      var nodeSeries = seriesByNode[nid] || {};

      // Scoring context, built exactly as api/data.js builds it.
      var vals = {};
      var hists = {};
      var staleFlags = {};

      var keys = Object.keys(nodeSeries);
      for (var ki = 0; ki < keys.length; ki++) {
        var sk = keys[ki];
        var sd = nodeSeries[sk];
        var latest = getLatest(sd.data);
        var latestDate = getLatestDate(sd.data);
        var isStale = checkStale(latestDate, sd.cadence, now);
        var converted = convertUnits(latest, sd.unit);

        // Raw values go to the scorer. convertUnits() is display only — the
        // thresholds and the values.js bounds are in the config unit.
        if (latest !== null) vals[sk] = latest;
        hists[sk] = Array.isArray(sd.data) ? sd.data : [];
        staleFlags[sk] = isStale || Boolean(sd.readError);

        if (sd.manual) {
          manual[sk] = {
            value: converted.val,
            unit: converted.unit,
            last_updated: latestDate || 'never',
            stale: isStale,
            source: sd.source
          };
        } else {
          automated[sk] = {
            value: converted.val,
            unit: converted.unit,
            date: latestDate || 'unknown',
            source: sd.source,
            read_error: sd.readError || null
          };
        }

        if (isStale) {
          staleSeries.push(sk);
          if (SCORING_KEYS.indexOf(sk) !== -1) {
            criticalStale.push(sk);
          } else if (SKIP_CADENCES.indexOf(sd.cadence) !== -1) {
            okToSkip.push(sk);
          }
        }
      }

      if (staleSeries.length > 0) {
        allStale[nkey] = staleSeries;
      }

      // Same scorer, same inputs as /api/data. The two routes cannot disagree.
      var scored;
      try {
        scored = calculateNodeStatus(nid, { values: vals, histories: hists, stale: staleFlags });
      } catch (scoreErr) {
        scored = {
          status: 'unknown',
          reasons: ['snapshot scoring error: ' + (scoreErr.message || String(scoreErr))],
          rejected: [], detail: {}, criticalMissing: [], degraded: true
        };
      }

      // status:<node> is read for the manual override only. It carries no
      // computed status and never has.
      var statusObj = statusMap[nid];
      var overrideObj = (statusObj && statusObj.override) ? statusObj : null;
      var override = overrideObj ? overrideObj.override : null;

      var current = override !== null ? override : scored.status;
      // Fail closed: anything unrecognised is 'unknown', never 'green'.
      if (VALID_STATUSES.indexOf(current) === -1) current = 'unknown';

      var masking = Boolean(
        overrideObj && SEVERITY[scored.status] > SEVERITY[overrideObj.override]
      );
      if (masking) maskedNodes.push(nkey);

      nodes[nkey] = {
        name: nd.name,
        status: current,
        status_auto: scored.status,
        status_override: override,
        override_updated: overrideObj ? (overrideObj.updated || null) : null,
        override_masking: masking,
        status_reasons: scored.reasons || [],
        rejected_inputs: scored.rejected || [],
        critical_missing: scored.criticalMissing || [],
        status_detail: scored.detail || {},
        degraded: Boolean(scored.degraded) || current === 'unknown',
        automated_metrics: automated,
        manual_metrics: manual,
        stale_series: staleSeries,
        status_logic: nd.thresholdInfo || []
      };

      allStatuses.push(current);

      if (current === 'red') redNodes.push(nkey);
      else if (current === 'unknown') unknownNodes.push(nkey);
      else if (current === 'amber') amberNodes.push(nkey);
      else greenNodes.push(nkey);
    }

    // Summary
    var parts = [];
    if (redNodes.length > 0) parts.push(redNodes.length + ' red');
    if (unknownNodes.length > 0) parts.push(unknownNodes.length + ' unknown');
    if (amberNodes.length > 0) parts.push(amberNodes.length + ' amber');
    if (greenNodes.length > 0) parts.push(greenNodes.length + ' green');
    var label = parts.join(' + ');
    if (redNodes.length >= 4) label += ' — systemic stress pattern';
    else if (redNodes.length >= 2) label += ' — elevated stress';
    // An unknown is an unmeasured node, not a quiet one.
    if (unknownNodes.length >= 3) label += ' — coverage degraded, greens not load-bearing';
    else if (unknownNodes.length > 0) label += ' — ' + unknownNodes.length + ' node(s) unmeasured';
    if (maskedNodes.length > 0) label += ' — ' + maskedNodes.length + ' node(s) masked by override';

    // Stale summary
    var totalStale = 0;
    var staleKeys = Object.keys(allStale);
    for (var sti = 0; sti < staleKeys.length; sti++) {
      totalStale += allStale[staleKeys[sti]].length;
    }

    // Alerts
    var alerts = buildAlerts(seriesByNode);

    // Market snapshot
    var market = buildMarket(seriesByNode);

    // Recovery gap
    var recovery = buildRecovery(seriesByNode);

    // Cron
    var lastCron = await redis.get('meta:last_cron');
    var cronAge = lastCron ? rnd((Date.now() - new Date(lastCron).getTime()) / 3600000, 2) : null;

    return res.status(200).json({
      timestamp: now.toISOString(),
      last_cron: lastCron || null,
      cron_age_hours: cronAge,
      snapshot_schema: 'fail_closed_v3',
      summary: {
        red_nodes: redNodes,
        unknown_nodes: unknownNodes,
        amber_nodes: amberNodes,
        green_nodes: greenNodes,
        masked_nodes: maskedNodes,
        worst: worstStatus(allStatuses),
        nodes_scored: redNodes.length + amberNodes.length + greenNodes.length,
        nodes_total: NODES.length,
        compound_stress: label
      },
      nodes: nodes,
      stale_summary: {
        total_stale: totalStale,
        by_node: allStale,
        critical_stale: unique(criticalStale),
        ok_to_skip: unique(okToSkip)
      },
      alerts: alerts,
      market_snapshot: market,
      recovery_gap_inputs: recovery
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to build snapshot', detail: String(err.message || err) });
  }
};

function getLatest(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  var e = data[data.length - 1];
  return (e.value !== undefined) ? e.value : null;
}

function getLatestDate(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  return data[data.length - 1].date || null;
}

function checkStale(dateStr, cadence, now) {
  if (!dateStr) return true;
  // Mirrors api/data.js. An unrecognised cadence falls back to 30 days rather
  // than being treated as permanently fresh.
  var threshold = STALE_THRESHOLDS[cadence] || 30;
  var age = (now.getTime() - new Date(dateStr).getTime()) / 86400000;
  return age > threshold;
}

function convertUnits(value, unit) {
  if (value === null || value === undefined) return { val: null, unit: unit };
  if (unit === 'K bbl') return { val: rnd(value / 1000, 1), unit: 'mb' };
  if (unit === 'K bbl/d') return { val: rnd(value / 1000, 2), unit: 'mbd' };
  return { val: value, unit: unit };
}

function rnd(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  var f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function unique(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (!seen[arr[i]]) { seen[arr[i]] = true; out.push(arr[i]); }
  }
  return out;
}

function buildAlerts(sbn) {
  var alerts = [];

  var diesel = getLatest(sbn.n5 && sbn.n5.diesel_crack ? sbn.n5.diesel_crack.data : null);
  if (diesel !== null && diesel > 40) {
    alerts.push('N5 diesel crack $' + rnd(diesel, 0) + '/bbl (' + rnd(diesel / 25, 1) + 'x normal) — red threshold exceeded');
  }

  var sprK = getLatest(sbn.n4 && sbn.n4.spr_level ? sbn.n4.spr_level.data : null);
  if (sprK !== null) {
    var sprMb = rnd(sprK / 1000, 1);
    var buf = rnd(sprMb - EPCA_FLOOR, 1);
    if (buf < 50) {
      alerts.push('N4 SPR buffer above EPCA floor now ' + buf + 'mb' + (buf < 30 ? ' — critical' : ' — approaching operational minimum'));
    }
  }

  var cushK = getLatest(sbn.n4 && sbn.n4.cushing ? sbn.n4.cushing.data : null);
  if (cushK !== null && cushK < 20000) {
    alerts.push('N4 Cushing at ' + rnd(cushK / 1000, 1) + 'mb' + (cushK < 18000 ? ' — below operational minimum' : ' — near tank bottoms'));
  }

  var ins = getLatest(sbn.n7 && sbn.n7.insurance_multiple ? sbn.n7.insurance_multiple.data : null);
  if (ins !== null && ins >= 10) {
    var clubs = getLatest(sbn.n7 && sbn.n7.clubs_withdrawn ? sbn.n7.clubs_withdrawn.data : null);
    alerts.push('N7 insurance multiple ' + ins + 'x' + (clubs ? ' — ' + clubs + ' P&I clubs withdrawn' : ''));
  }

  var dark = getLatest(sbn.n2 && sbn.n2.hormuz_dark_ais ? sbn.n2.hormuz_dark_ais.data : null);
  if (dark !== null && dark > 30) {
    alerts.push('N2 Hormuz AIS dark count ' + dark + ' — AIS reliability degrading');
  }

  var hormuz = getLatest(sbn.n2 && sbn.n2.hormuz_portwatch ? sbn.n2.hormuz_portwatch.data : null);
  if (hormuz !== null && hormuz <= 15) {
    alerts.push('N2 Hormuz transits at ' + hormuz + '/day — near-complete closure');
  }

  var reroute = getLatest(sbn.n8 && sbn.n8.carriers_rerouting ? sbn.n8.carriers_rerouting.data : null);
  if (reroute !== null && reroute >= 4) {
    alerts.push('N8 ' + reroute + ' major carriers rerouting away from Hormuz');
  }

  var petro = getLatest(sbn.n1 && sbn.n1.petroline_pct ? sbn.n1.petroline_pct.data : null);
  if (petro !== null && petro >= 95) {
    alerts.push('N1 Petroline bypass at ' + petro + '%' + (petro >= 98 ? ' — at capacity' : ' — approaching capacity'));
  }

  var worldStor = getLatest(sbn.n3 && sbn.n3.floating_storage_world ? sbn.n3.floating_storage_world.data : null);
  if (worldStor !== null && worldStor > 120000) {
    alerts.push('N3 world floating storage ' + rnd(worldStor / 1000, 0) + 'M bbl — fleet absorption ' + (worldStor > 140000 ? 'at crisis level' : 'elevated'));
  }

  return alerts;
}

function buildMarket(sbn) {
  var wti = getLatest(sbn.n5 && sbn.n5.wti ? sbn.n5.wti.data : null);
  var brent = getLatest(sbn.n5 && sbn.n5.brent ? sbn.n5.brent.data : null);
  var hormuz = getLatest(sbn.n2 && sbn.n2.hormuz_portwatch ? sbn.n2.hormuz_portwatch.data : null);
  var sprK = getLatest(sbn.n4 && sbn.n4.spr_level ? sbn.n4.spr_level.data : null);
  var diesel = getLatest(sbn.n5 && sbn.n5.diesel_crack ? sbn.n5.diesel_crack.data : null);
  var gas = getLatest(sbn.n5 && sbn.n5.gasoline_crack ? sbn.n5.gasoline_crack.data : null);

  return {
    wti: wti,
    brent: brent,
    diesel_crack: diesel,
    gasoline_crack: gas,
    hormuz_transits: hormuz,
    spr: sprK !== null ? rnd(sprK / 1000, 1) : null,
    not_tracked: ['tnx (10Y yield)', 'us30y (30Y yield)', 'usdjpy']
  };
}

function buildRecovery(sbn) {
  var hormuz = getLatest(sbn.n2 && sbn.n2.hormuz_portwatch ? sbn.n2.hormuz_portwatch.data : null);
  var bab = getLatest(sbn.n2 && sbn.n2.bab_portwatch ? sbn.n2.bab_portwatch.data : null);
  var ins = getLatest(sbn.n7 && sbn.n7.insurance_multiple ? sbn.n7.insurance_multiple.data : null);
  var diesel = getLatest(sbn.n5 && sbn.n5.diesel_crack ? sbn.n5.diesel_crack.data : null);
  var sprK = getLatest(sbn.n4 && sbn.n4.spr_level ? sbn.n4.spr_level.data : null);
  var sprMb = sprK !== null ? rnd(sprK / 1000, 1) : null;
  var sprBuf = sprMb !== null ? rnd(sprMb - EPCA_FLOOR, 1) : null;
  var dcm = diesel !== null ? diesel / 25 : null;

  return {
    hormuz_daily: hormuz,
    bab_daily: bab,
    insurance_multiple: ins,
    diesel_crack: diesel,
    spr_mb: sprMb,
    route_status: hormuz === null ? 'unknown' : hormuz < 5 ? 'cape' : hormuz <= 15 ? 'partial' : 'full',
    insurance_months: ins === null ? null : ins > 20 ? 4 : ins > 10 ? 3 : ins > 5 ? 2 : 1,
    refinery_ramp_months: dcm === null ? null : dcm > 3 ? 2 : dcm > 2 ? 1.5 : dcm > 1 ? 1 : 0.5,
    stocks_rebuild_months: sprBuf === null ? null : sprBuf < 20 ? 4 : sprBuf < 40 ? 3 : sprBuf < 80 ? 2 : 1
  };
}
