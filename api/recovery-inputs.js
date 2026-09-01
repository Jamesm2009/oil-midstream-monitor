const { getRedis } = require('../lib/redis');

// Public endpoint — CDN-cached, key optional for authenticated enrichment
// Returns the 6 values recovery.html needs plus suggested adjustments

var EPCA_FLOOR = 252.4;

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // CDN cache: 1 hour, stale-while-revalidate 6 hours
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');

  try {
    var redis = getRedis();

    // Load the series we need in parallel
    var keys = [
      'series:n2:hormuz_portwatch',
      'series:n2:bab_portwatch',
      'series:n7:insurance_multiple',
      'series:n5:diesel_crack',
      'series:n4:spr_level',
      'series:n5:wti',
      'series:n5:brent'
    ];

    var results = await Promise.all(keys.map(function(k) { return redis.get(k); }));

    var hormuz = getLatest(results[0]);
    var bab = getLatest(results[1]);
    var ins = getLatest(results[2]);
    var diesel = getLatest(results[3]);
    var sprK = getLatest(results[4]);
    var wti = getLatest(results[5]);
    var brent = getLatest(results[6]);

    var sprMb = sprK !== null ? rnd(sprK / 1000, 1) : null;
    var sprBuf = sprMb !== null ? rnd(sprMb - EPCA_FLOOR, 1) : null;
    var dcm = diesel !== null ? diesel / 25 : null;

    // Last cron timestamp
    var lastCron = await redis.get('meta:last_cron');

    // Staleness check — flag if cron > 48h old
    var stale = false;
    if (lastCron) {
      var ageHours = (Date.now() - new Date(lastCron).getTime()) / 3600000;
      stale = ageHours > 48;
    } else {
      stale = true;
    }

    return res.status(200).json({
      last_cron: lastCron || null,
      stale: stale,
      current: {
        hormuz_daily: hormuz,
        bab_daily: bab,
        insurance_multiple: ins,
        diesel_crack: diesel !== null ? rnd(diesel, 2) : null,
        spr_mb: sprMb,
        wti: wti !== null ? rnd(wti, 2) : null,
        brent: brent !== null ? rnd(brent, 2) : null
      },
      suggested_adjustments: {
        route_status: hormuz === null ? 'unknown' : hormuz < 5 ? 'cape' : hormuz <= 15 ? 'partial' : 'full',
        insurance_months: ins === null ? null : ins > 20 ? 4 : ins > 10 ? 3 : ins > 5 ? 2 : 1,
        refinery_ramp_months: dcm === null ? null : dcm > 3 ? 2 : dcm > 2 ? 1.5 : dcm > 1 ? 1 : 0.5,
        stocks_rebuild_months: sprBuf === null ? null : sprBuf < 20 ? 4 : sprBuf < 40 ? 3 : sprBuf < 80 ? 2 : 1
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to build recovery inputs', detail: String(err.message || err) });
  }
};

function getLatest(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  var e = data[data.length - 1];
  return (e.value !== undefined) ? e.value : null;
}

function rnd(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  var f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
