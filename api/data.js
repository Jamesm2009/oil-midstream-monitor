const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES, STALE_THRESHOLDS } = require('../lib/config');
const { calculateNodeStatus } = require('../lib/thresholds');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const redis = getRedis();
    const result = { nodes: [], meta: {} };

    for (const node of NODES) {
      const nodeData = {
        id: node.id,
        name: node.name,
        category: node.category,
        summary: node.summary,
        keyMetric: node.keyMetric,
        series: [],
        status: null,
      };

      const latestValues = {};
      const histories = {};

      for (const s of node.series) {
        const redisKey = `series:${node.id}:${s.key}`;
        let history = [];
        try {
          history = (await redis.get(redisKey)) || [];
        } catch { }

        const latest = Array.isArray(history) && history.length > 0
          ? history[history.length - 1]
          : null;

        // Check staleness
        let stale = false;
        if (latest && latest.date) {
          const ageMs = Date.now() - new Date(latest.date).getTime();
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const threshold = STALE_THRESHOLDS[s.cadence] || 30;
          stale = ageDays > threshold;
        }

        nodeData.series.push({
          key: s.key,
          label: s.label,
          unit: s.unit,
          manual: s.manual,
          cadence: s.cadence,
          latest: latest,
          stale: stale,
          historyLength: history.length,
        });

        if (latest) {
          latestValues[s.key] = latest.value;
        }
        histories[s.key] = history;
      }

      // Calculate auto status
      latestValues._history = histories;
      const autoStatus = calculateNodeStatus(node.id, latestValues);

      // Check for manual override
      let statusObj;
      try {
        statusObj = await redis.get(`status:${node.id}`);
      } catch { }

      if (statusObj && statusObj.override) {
        nodeData.status = {
          current: statusObj.override,
          auto: autoStatus,
          override: statusObj.override,
          updated: statusObj.updated,
        };
      } else {
        nodeData.status = {
          current: autoStatus,
          auto: autoStatus,
          override: null,
          updated: new Date().toISOString().split('T')[0],
        };
      }

      result.nodes.push(nodeData);
    }

    // Meta
    try {
      result.meta.lastCron = await redis.get('meta:last_cron');
    } catch { }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Data API error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
