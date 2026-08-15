const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES } = require('../lib/config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const { node, series, value, date, source } = req.body || {};

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

    const redis = getRedis();
    const redisKey = `series:${node}:${series}`;

    // Get existing history
    let history = (await redis.get(redisKey)) || [];
    if (!Array.isArray(history)) history = [];

    // Create new data point
    const point = {
      value: typeof value === 'string' ? value : parseFloat(value),
      date: date,
      source: source || 'manual',
    };

    // Check for duplicate date — replace if exists
    const existingIdx = history.findIndex(h => h.date === date);
    if (existingIdx >= 0) {
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
