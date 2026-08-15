//Fix-Sort
const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const redis = getRedis();
  const log = [];
  let fixed = 0;

  // Find all series keys
  // We know the pattern from config, so we'll check all possible keys
  const { NODES } = require('../lib/config');

  for (const node of NODES) {
    for (const s of node.series) {
      const key = `series:${node.id}:${s.key}`;
      try {
        const history = await redis.get(key);
        if (!history || !Array.isArray(history) || history.length < 2) {
          continue;
        }

        // Check if first date > last date (descending order)
        const firstDate = history[0]?.date || '';
        const lastDate = history[history.length - 1]?.date || '';

        // Sort ascending by date
        history.sort((a, b) => {
          if (!a.date || !b.date) return 0;
          return a.date.localeCompare(b.date);
        });

        const newFirstDate = history[0]?.date || '';
        const newLastDate = history[history.length - 1]?.date || '';

        await redis.set(key, history);

        if (firstDate !== newFirstDate) {
          log.push(`${key}: RE-SORTED (was ${firstDate}→${lastDate}, now ${newFirstDate}→${newLastDate}, ${history.length} points)`);
          fixed++;
        } else {
          log.push(`${key}: OK (${newFirstDate}→${newLastDate}, ${history.length} points)`);
        }
      } catch (err) {
        log.push(`${key}: ERROR — ${err.message}`);
      }
    }
  }

  return res.status(200).json({ ok: true, fixed, log });
};

