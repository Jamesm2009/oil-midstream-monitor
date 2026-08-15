const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const { node, series } = req.query || {};
  if (!node || !series) {
    return res.status(400).json({ error: 'Missing node or series parameter' });
  }

  try {
    const redis = getRedis();
    const redisKey = `series:${node}:${series}`;
    const history = (await redis.get(redisKey)) || [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ node, series, data: history });
  } catch (err) {
    console.error('History API error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
