const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const fs = require('fs');
const path = require('path');

module.exports.config = { maxDuration: 60 };

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const redis = getRedis();
  const log = [];
  let totalPoints = 0;

  // Read the backfill data file
  const dataPath = path.join(process.cwd(), 'data', 'portwatch-backfill.json');
  if (!fs.existsSync(dataPath)) {
    return res.status(404).json({ error: 'portwatch-backfill.json not found in data/' });
  }

  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const keys = Object.keys(data);

    // Optional: process only one key at a time via ?key= parameter
    const targetKey = req.query?.key;

    for (const key of keys) {
      if (targetKey && key !== targetKey) continue;

      const points = data[key];
      if (!Array.isArray(points) || points.length === 0) {
        log.push(`${key}: empty, skipped`);
        continue;
      }

      // Sort ascending by date
      points.sort((a, b) => a.date.localeCompare(b.date));

      await redis.set(key, points);
      const first = points[0].date;
      const last = points[points.length - 1].date;
      log.push(`${key}: ${points.length} points (${first} → ${last})`);
      totalPoints += points.length;
    }

    log.push(`--- Done: ${totalPoints} total points across ${targetKey ? 1 : keys.length} series ---`);
    return res.status(200).json({ ok: true, totalPoints, log });
  } catch (err) {
    log.push(`ERROR: ${err.message}`);
    return res.status(500).json({ error: err.message, log });
  }
};
