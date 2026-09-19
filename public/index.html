const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES } = require('../lib/config');
const { parseBand, BAND_SERIES } = require('../lib/values');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const { node, series, value, date, source, force } = req.body || {};

    if (!node || !series || value === undefined || !date) {
      return res.status(400).json({ error: 'Missing required fields: node, series, value, date' });
    }

    // Validate node and series exist
    const nodeDef = NODES.find(n => n.id === node);
    if (!nodeDef) {
      return res.status(400).json({ error: `Unknown node: ${node}` });
    }
    const seriesDef = nodeDef.series.find(s => s.key === series);
    if (!seriesDef) {
      return res.status(400).json({ error: `Unknown series: ${series} in node ${node}` });
    }

    // Guard: the form lists automated series too (marked [auto]), so one
    // mis-selection could write a typed number over an EIA or FRED value with
    // nothing to show it had happened. Refuse unless explicitly forced.
    if (seriesDef.manual !== true && force !== true) {
      return res.status(409).json({
        error: `${series} is an automated series (${seriesDef.label}). A manual entry will be overwritten by the next cron run and will not be distinguishable from fetched data. Resend with force: true to override.`,
        code: 'AUTOMATED_SERIES',
        series: series,
        label: seriesDef.label,
      });
    }

    const redis = getRedis();
    const redisKey = `series:${node}:${series}`;

    // Get existing history
    let history = (await redis.get(redisKey)) || [];
    if (!Array.isArray(history)) history = [];

    // Parse value — band-shaped series keep their string form.
    // parseFloat('3-8') returns 3, not NaN, so the old coercion silently
    // truncated a war-risk band to its lower edge.
    let parsedValue = value;
    if (typeof value === 'string') {
      if (BAND_SERIES.has(series)) {
        const band = parseBand(value);
        if (!band) {
          return res.status(400).json({
            error: `${series} expects a band such as "3-8", or a single number`,
          });
        }
        parsedValue = value.trim(); // stored verbatim; thresholds.js parses it
      } else {
        const cleaned = value.replace(/[,\s]/g, '');
        const num = parseFloat(cleaned);
        parsedValue = isNaN(num) ? value : num;
      }
    }

    // Create new data point. `manual: true` is structural, not cosmetic: a
    // stored point previously carried only a source string, so a typed value
    // and a fetched one were indistinguishable once filed.
    const point = {
      value: parsedValue,
      date: date,
      source: source || 'manual',
      manual: true,
    };
    if (force === true && seriesDef.manual !== true) point.forced = true;

    // Duplicate date: replace the VALUE, preserve the metadata. Assigning the
    // new point wholesale destroyed curated / vintage / health flags written by
    // the cron — the same defect fixed in appendToHistory, in the other
    // direction. Losing `curated` would silently turn an upstream estimate back
    // into something that reads as a measurement.
    const PRESERVED_META = ['curated', 'vintage', 'vintage_field', 'health'];
    const existingIdx = history.findIndex(h => h.date === date);
    if (existingIdx >= 0) {
      const prior = history[existingIdx];
      for (const key of PRESERVED_META) {
        if (prior[key] !== undefined && point[key] === undefined) point[key] = prior[key];
      }
      history[existingIdx] = point;
    } else {
      history.push(point);
      // Sort by date
      history.sort((a, b) => a.date.localeCompare(b.date));
    }

    await redis.set(redisKey, history);

    return res.status(200).json({
      ok: true,
      key: redisKey,
      point: point,
      totalPoints: history.length,
    });
  } catch (err) {
    console.error('Manual input error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
