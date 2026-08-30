const { getRedis } = require('../lib/redis');

var STALE_DAYS = {
  daily: 5,
  portwatch: 10,
  weekly: 14,
  monthly: 45,
  quarterly: 120,
  assessment: 21,
  as_changed: 60
};

var SCORING_KEYS = [
  'floating_storage_world', 'floating_storage_mideast',
  'shadow_fleet_share', 'west_africa_diff',
  'warrisk_band', 'g7_carriage_share'
];

var SKIP_CADENCES = ['as_changed'];

var EPCA_FLOOR = 252.4;

var BASELINES = {
  hormuz_daily: 24,
  bab_daily: 45,
  insurance_multiple: 1.0,
  diesel_crack_normal: 25
};

var NODES = [
  {
    id: 'n1', name: 'Gulf Production & Bypass',
    redThreshold: 'Red: both pipelines at capacity',
    series: [
      { key: 'petroline_pct', unit: '%', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'adcop_pct', unit: '%', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'gulf_exports', unit: 'M bbl/d', manual: true, cadence: 'monthly' },
      { key: 'fujairah_yanbu_split', unit: '%', manual: true, cadence: 'assessment' }
    ]
  },
  {
    id: 'n2', name: 'Chokepoint Transit',
    redThreshold: 'Red: Hormuz PortWatch <=15/day',
    series: [
      { key: 'hormuz_portwatch', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'hormuz_tanker', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'hormuz_dark_ais', unit: 'vessels', manual: false, cadence: 'daily', source: 'straits.live' },
      { key: 'stranded_offshore', unit: 'vessels', manual: false, cadence: 'daily', source: 'straits.live' },
      { key: 'bab_portwatch', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'suez_portwatch', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'cape_portwatch', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'panama_portwatch', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' }
    ]
  },
  {
    id: 'n3', name: 'Tanker Availability',
    redThreshold: 'Red: world floating storage >140,000 K bbl',
    series: [
      { key: 'floating_storage_world', unit: 'K bbl', manual: true, cadence: 'weekly' },
      { key: 'floating_storage_mideast', unit: 'K bbl', manual: true, cadence: 'weekly' },
      { key: 'vlcc_spot', unit: '$/day', manual: true, cadence: 'weekly' },
      { key: 'shadow_fleet_share', unit: '%', manual: true, cadence: 'monthly' }
    ]
  },
  {
    id: 'n4', name: 'Storage Buffers',
    redThreshold: 'Red: SPR draw >4M/wk or Cushing <18M bbl',
    series: [
      { key: 'spr_level', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'cushing', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'commercial_crude', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'gasoline_stocks', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'distillate_stocks', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'refinery_utilisation', unit: '%', manual: false, cadence: 'weekly', source: 'EIA' }
    ]
  },
  {
    id: 'n5', name: 'Refining & Products',
    redThreshold: 'Red: diesel crack >$40/bbl',
    series: [
      { key: 'wti', unit: '$/bbl', manual: false, cadence: 'daily', source: 'FRED' },
      { key: 'brent', unit: '$/bbl', manual: false, cadence: 'daily', source: 'FRED' },
      { key: 'gasoline_crack', unit: '$/bbl', manual: false, cadence: 'daily', source: 'calculated' },
      { key: 'diesel_crack', unit: '$/bbl', manual: false, cadence: 'daily', source: 'calculated' }
    ]
  },
  {
    id: 'n6', name: 'Alternative Supply Routes',
    redThreshold: 'Red: West African differentials >$8/bbl',
    series: [
      { key: 'us_crude_production', unit: 'K bbl/d', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'us_crude_exports', unit: 'K bbl/d', manual: false, cadence: 'monthly', source: 'EIA' },
      { key: 'us_crude_exports_wk', unit: 'K bbl/d', manual: false, cadence: 'weekly', source: 'EIA' },
      { key: 'us_oil_rig_count', unit: 'rigs', manual: true, cadence: 'weekly' },
      { key: 'brazil_exports', unit: 'M bbl/d', manual: true, cadence: 'quarterly' },
      { key: 'guyana_production', unit: 'K bbl/d', manual: true, cadence: 'quarterly' },
      { key: 'west_africa_diff', unit: '$/bbl', manual: true, cadence: 'weekly' }
    ]
  },
  {
    id: 'n7', name: 'Insurance & Risk Premium',
    redThreshold: 'Red: insurance multiple >=20x or >=4 clubs withdrawn',
    series: [
      { key: 'insurance_multiple', unit: 'x', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'vlcc_premium_high', unit: '$', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'clubs_withdrawn', unit: 'count', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'warrisk_band', unit: '% hull', manual: true, cadence: 'weekly' },
      { key: 'jwc_areas', unit: 'text', manual: true, cadence: 'as_changed' }
    ]
  },
  {
    id: 'n8', name: 'Sanctions Architecture',
    redThreshold: 'Red: >=7 carriers rerouting',
    series: [
      { key: 'vessels_high_risk', unit: 'count', manual: false, cadence: 'daily', source: 'straits.live' },
      { key: 'carriers_rerouting', unit: 'count', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'price_cap', unit: '$/bbl', manual: true, cadence: 'as_changed' },
      { key: 'shadow_designations', unit: 'cumulative', manual: true, cadence: 'monthly' },
      { key: 'ofac_waivers', unit: 'text', manual: true, cadence: 'as_changed' },
      { key: 'g7_carriage_share', unit: '%', manual: true, cadence: 'monthly' }
    ]
  }
];

module.exports = async function handler(req, res) {
    var providedKey = req.query.key;
  var envKey = process.env.SNAPSHOT_API_KEY;
  if (!providedKey || providedKey !== envKey) {
    return res.status(401).json({
      error: 'Invalid or missing API key',
      debug: {
        env_defined: !!envKey,
        env_length: envKey ? envKey.length : 0,
        provided_length: providedKey ? providedKey.length : 0,
        match: providedKey === envKey
      }
    });
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
          return { nodeId: s.nodeId, key: s.key, unit: s.unit, manual: s.manual, cadence: s.cadence, source: s.source, data: data };
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

    for (var i = 0; i < NODES.length; i++) {
      var nd = NODES[i];
      var nid = nd.id;
      var nkey = nid.toUpperCase();
      var statusObj = statusMap[nid];
      var status = (statusObj && statusObj.status) ? statusObj.status : 'green';
      var override = (statusObj && statusObj.override) ? statusObj.override : null;

      var automated = {};
      var manual = {};
      var staleSeries = [];
      var nodeSeries = seriesByNode[nid] || {};

      var keys = Object.keys(nodeSeries);
      for (var ki = 0; ki < keys.length; ki++) {
        var sk = keys[ki];
        var sd = nodeSeries[sk];
        var latest = getLatest(sd.data);
        var latestDate = getLatestDate(sd.data);
        var isStale = checkStale(latestDate, sd.cadence, now);
        var converted = convertUnits(latest, sd.unit);

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
            source: sd.source
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

      nodes[nkey] = {
        name: nd.name,
        status: status,
        status_override: override,
        automated_metrics: automated,
        manual_metrics: manual,
        stale_series: staleSeries,
        status_logic: nd.redThreshold
      };

      if (status === 'red') redNodes.push(nkey);
      else if (status === 'amber') amberNodes.push(nkey);
      else greenNodes.push(nkey);
    }

    // Summary
    var parts = [];
    if (redNodes.length > 0) parts.push(redNodes.length + ' red');
    if (amberNodes.length > 0) parts.push(amberNodes.length + ' amber');
    if (greenNodes.length > 0) parts.push(greenNodes.length + ' green');
    var label = parts.join(' + ');
    if (redNodes.length >= 4) label += ' — systemic stress pattern';
    else if (redNodes.length >= 2) label += ' — elevated stress';

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
      summary: {
        red_nodes: redNodes,
        amber_nodes: amberNodes,
        green_nodes: greenNodes,
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
  var threshold = STALE_DAYS[cadence];
  if (!threshold) return false;
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
