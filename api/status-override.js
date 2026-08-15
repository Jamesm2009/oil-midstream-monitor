const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const { node, status } = req.body || {};

    if (!node) {
      return res.status(400).json({ error: 'Missing node' });
    }

    const validStatuses = ['green', 'amber', 'red', null];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status must be green, amber, red, or null (to clear override)' });
    }

    const redis = getRedis();
    const redisKey = `status:${node}`;

    const existing = (await redis.get(redisKey)) || {};

    const updated = {
      ...existing,
      override: status,
      updated: new Date().toISOString().split('T')[0],
    };

    await redis.set(redisKey, updated);

    return res.status(200).json({ ok: true, node, status: updated });
  } catch (err) {
    console.error('Status override error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
