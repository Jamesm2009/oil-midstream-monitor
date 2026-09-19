// api/data.js
//
// Changes vs the version behind the 2026-09-05 report:
//   - staleness is passed INTO scoring instead of being display-only
//   - scoring returns a rich object; 'unknown' is a first-class status
//   - manual overrides are flagged loudly, including when they mask a worse
//     computed status (the likely explanation for N6 printing green)
//   - a Redis read failure for a series no longer silently becomes []

const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES, STALE_THRESHOLDS } = require('../lib/config');
const { calculateNodeStatus, worstStatus, SEVERITY } = require('../lib/thresholds');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const redis = getRedis();
    const result = { nodes: [], meta: {} };
    const allStatuses = [];

    for (const node of NODES) {
      const nodeData = {
        id: node.id,
        name: node.name,
        category: node.category,
        summary: node.summary,
        keyMetric: node.keyMetric,
        manualSources: node.manualSources || [],
        thresholdInfo: node.thresholdInfo || [],
        series: [],
        status: null,
      };

      const values = {};
      const histories = {};
      const staleFlags = {};

      for (const s of node.series) {
        const redisKey = `series:${node.id}:${s.key}`;

        let history = [];
        let readError = null;
        try {
          const raw = await redis.get(redisKey);
          history = Array.isArray(raw) ? raw : [];
        } catch (err) {
          // Do not let a transport failure masquerade as an empty series.
          readError = err.message || String(err);
        }

        const latest = history.length > 0 ? history[history.length - 1] : null;

                let stale = false;
        let ageDays = null;
        if (latest && latest.date) {
          ageDays = (Date.now() - new Date(latest.date).getTime()) / 86400000;
        }

        if (s.cadence === 'as_changed') {
          // D48. Event-driven fields: unchanged IS the information. A JWC
          // circular unrevised for 61 days is not stale, it is unrevised — and
          // under honest vintage dating (D46) these are dated by lastChangedAt,
          // so an age threshold would start flagging correct data as rotten.
          // Absence is still not freshness: no observation at all stays stale.
          stale = !latest || !latest.date;
        } else if (ageDays !== null) {
          const threshold = STALE_THRESHOLDS[s.cadence] || 30;
          stale = ageDays > threshold;
        } else {
          stale = true; // no dated observation is not fresh
        }

                nodeData.series.push({
          key: s.key,
          label: s.label,
          unit: s.unit,
          manual: s.manual,
          cadence: s.cadence,
          latest,
          stale,
          // D46. When a node degrades to unknown the value does not vanish —
          // the UI should read "last estimate 40x, as of 15 September" rather
          // than blanking. These are lifted out of `latest` so the front end
          // does not have to know the point shape.
          vintage: latest && latest.vintage ? latest.vintage : null,
          vintageField: latest && latest.vintage_field ? latest.vintage_field : null,
          curated: Boolean(latest && latest.curated),
          ageDays: ageDays === null ? null : Math.round(ageDays),
          readError,
          historyLength: history.length,
        });

        if (latest) values[s.key] = latest.value;
        histories[s.key] = history;
        staleFlags[s.key] = stale || Boolean(readError);
      }

      const scored = calculateNodeStatus(node.id, { values, histories, stale: staleFlags });

      let override = null;
      try {
        const statusObj = await redis.get(`status:${node.id}`);
        if (statusObj && statusObj.override) override = statusObj;
      } catch { /* override unavailable — computed status stands */ }

      const current = override ? override.override : scored.status;

      nodeData.status = {
        current,
        auto: scored.status,
        override: override ? override.override : null,
        overrideUpdated: override ? override.updated : null,
        // Loud flag: an override that presents a worse computed status as
        // something calmer. This is the failure mode to check on N6.
        overrideMasking: Boolean(
          override && SEVERITY[scored.status] > SEVERITY[override.override]
        ),
        reasons: scored.reasons,
        rejected: scored.rejected,
        detail: scored.detail,
        criticalMissing: scored.criticalMissing,
        degraded: scored.degraded,
        updated: new Date().toISOString().split('T')[0],
      };

      allStatuses.push(current);
      result.nodes.push(nodeData);
    }

    const counts = { red: 0, amber: 0, green: 0, unknown: 0 };
    for (const s of allStatuses) counts[s] = (counts[s] || 0) + 1;

    result.meta.rollup = {
      counts,
      worst: worstStatus(allStatuses),
      // Surfaced separately so an assessment never reads "6 red 2 green" when
      // the two greens are actually blind spots.
      blindNodes: result.nodes.filter(n => n.status.current === 'unknown').map(n => n.id),
      maskedNodes: result.nodes.filter(n => n.status.overrideMasking).map(n => n.id),
    };

    try {
      result.meta.lastCron = await redis.get('meta:last_cron');
    } catch { result.meta.lastCron = null; }

    // D45. Detection only. The cron records that a TD3C article exists; the
    // number itself stays a manual entry, because it appears as varying prose
    // and the source is Informa copyright.
    try {
      result.meta.td3cWatch = await redis.get('meta:td3c_watch');
    } catch { result.meta.td3cWatch = null; }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Data API error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
