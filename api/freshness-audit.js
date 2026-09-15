// api/freshness-audit.js
//
// Read-only. Writes nothing, ever.
//
// Every series carries two ages, and only one of them is displayed anywhere:
//
//   stamped age — how old the newest point's date is
//   true age    — how old the newest point's VALUE is, i.e. when it last moved
//
// A field whose upstream restamps a frozen value every day has a stamped age of
// 0 and a true age of weeks. That gap is the thing the source audit found by
// diffing two crons nine hours apart; this route computes it from stored
// history for every series at once.
//
// It works because of an accident of api/cron/fetch-data.js: appendToHistory
// skips a point whose date already exists, but straits.live advances its own
// asOf/updatedAt daily. So an unchanged upstream value is already recorded as a
// new point per day. The evidence is sitting in Redis and needs no new
// instrumentation.
//
// WHAT IT DOES NOT DO. It cannot tell "not updating" from "genuinely unchanged".
// A $60 price cap really is $60; ADCOP really does sit at 100%. So the route
// calibrates each series against its own past instead of against a fixed rule:
// a long flat run only reads as frozen when that series has historically moved
// and is now flat for far longer than it has ever been before. Everything else
// is reported with its numbers and left for a human.
//
// Usage (browser, GET):
//   /api/freshness-audit                       every series
//   /api/freshness-audit?series=n7:insurance_multiple    one series
//   /api/freshness-audit?min_gap=7             only gaps of 7+ days

const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES, STALE_THRESHOLDS } = require('../lib/config');

const DAY_MS = 86400000;

function parseDate(d) {
  if (!d || typeof d !== 'string') return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

function sameValue(a, b) {
  // Values are numbers, strings or null. JSON comparison handles all three
  // without coercing "6" and 6 into a match.
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

// Longest run of consecutive equal values anywhere in the history, measured in
// days, excluding the final run (which is the current one).
function longestPriorRunDays(points, currentRunStartIdx) {
  let longest = 0;
  let i = 0;
  while (i < currentRunStartIdx) {
    let j = i;
    while (j + 1 < currentRunStartIdx && sameValue(points[j + 1].value, points[i].value)) j++;
    const a = parseDate(points[i].date);
    const b = parseDate(points[j].date);
    if (a !== null && b !== null) {
      const days = Math.round((b - a) / DAY_MS);
      if (days > longest) longest = days;
    }
    i = j + 1;
  }
  return longest;
}

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  try {
    const redis = getRedis();
    const q = req.query || {};
    const scope = q.series ? String(q.series).trim().replace(/^series:/, '') : null;
    const minGap = q.min_gap ? Number(q.min_gap) : null;
    const now = Date.now();

    const inventory = [];
    for (const node of NODES) {
      for (const s of node.series) {
        inventory.push({
          redis_key: `series:${node.id}:${s.key}`,
          node: node.id,
          series: s.key,
          label: s.label,
          cadence: s.cadence,
          manual: Boolean(s.manual),
          stale_threshold_days: STALE_THRESHOLDS[s.cadence] || 30,
        });
      }
    }

    const targets = scope
      ? inventory.filter(e => `${e.node}:${e.series}` === scope || e.series === scope)
      : inventory;

    if (targets.length === 0) {
      return res.status(400).json({ error: `No series matched '${scope}'`, hint: 'Use node:series, e.g. n7:insurance_multiple' });
    }

    const results = [];
    const skipped = [];

    for (const entry of targets) {
      let history;
      try {
        history = await redis.get(entry.redis_key);
      } catch (err) {
        skipped.push({ ...entry, skip_reason: `redis read failed: ${err.message}` });
        continue;
      }

      if (!Array.isArray(history) || history.length === 0) {
        skipped.push({ ...entry, skip_reason: history === null || history === undefined ? 'no data' : 'stored value is not an array' });
        continue;
      }

      // Points are stored date-ascending by appendToHistory, but do not assume it.
      const points = history
        .filter(p => p && typeof p === 'object')
        .slice()
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

      if (points.length === 0) {
        skipped.push({ ...entry, skip_reason: 'no usable points' });
        continue;
      }

      const latest = points[points.length - 1];
      const latestTs = parseDate(latest.date);

      // Walk back while the value is unchanged. That start point is when the
      // number the Monitor is showing was actually last a new number.
      let runStart = points.length - 1;
      while (runStart > 0 && sameValue(points[runStart - 1].value, latest.value)) runStart--;

      const lastChange = points[runStart];
      const lastChangeTs = parseDate(lastChange.date);

      const stampedAge = latestTs === null ? null : Math.round((now - latestTs) / DAY_MS);
      const trueAge = lastChangeTs === null ? null : Math.round((now - lastChangeTs) / DAY_MS);
      const runDays = (latestTs !== null && lastChangeTs !== null) ? Math.round((latestTs - lastChangeTs) / DAY_MS) : null;

      const distinct = new Set(points.map(p => JSON.stringify(p.value === undefined ? null : p.value))).size;
      const priorRun = longestPriorRunDays(points, runStart);

      // Classification. Deliberately conservative — the route reports, it does
      // not decide.
      let classification;
      let note = null;
      if (points.length < 3) {
        classification = 'insufficient_history';
        note = 'Fewer than 3 points. No basis for comparison.';
      } else if (distinct === 1) {
        classification = 'never_varied';
        note = 'This series has held one value for its whole recorded history. Flat may be its nature, or it may never have worked. Cannot tell from here.';
      } else if (runDays !== null && runDays >= 3 && runDays > priorRun * 2) {
        classification = 'frozen';
        note = `Flat for ${runDays}d against a previous maximum of ${priorRun}d. The stamp is advancing and the value is not.`;
      } else if (runDays !== null && runDays >= 3) {
        classification = 'flat';
        note = `Flat for ${runDays}d, but this series has been flat for ${priorRun}d before now. Within its own normal range.`;
      } else {
        classification = 'moving';
      }

      results.push({
        ...entry,
        latest_date: latest.date || null,
        latest_value: latest.value === undefined ? null : latest.value,
        latest_source: latest.source || null,
        last_change_date: lastChange.date || null,
        stamped_age_days: stampedAge,
        true_age_days: trueAge,
        gap_days: (stampedAge !== null && trueAge !== null) ? trueAge - stampedAge : null,
        run_points: points.length - runStart,
        run_days: runDays,
        total_points: points.length,
        distinct_values: distinct,
        longest_prior_flat_days: priorRun,
        classification,
        note,
      });
    }

    const filtered = minGap !== null
      ? results.filter(r => r.gap_days !== null && r.gap_days >= minGap)
      : results;

    filtered.sort((a, b) => (b.gap_days || 0) - (a.gap_days || 0));

    const by = c => results.filter(r => r.classification === c).map(r => `${r.node}:${r.series}`);

    return res.status(200).json({
      generated: new Date().toISOString(),
      read_only: true,
      scope: scope || 'all',
      series_checked: targets.length,
      summary: {
        frozen: by('frozen'),
        flat: by('flat'),
        never_varied: by('never_varied'),
        moving: by('moving').length,
        insufficient_history: by('insufficient_history'),
        skipped: skipped.length,
        widest_gap_days: filtered.length > 0 ? filtered[0].gap_days : null,
      },
      series: filtered,
      skipped,
      notes: [
        'stamped_age_days is how old the newest point claims to be. true_age_days is how old its value actually is. gap_days is the difference, and the difference is what gets published as fresh.',
        'frozen means flat for more than twice as long as this series has ever been flat before. It is a prompt to check the upstream, not a verdict.',
        'never_varied cannot be judged from history alone — a constant may be correct. Check whether the field has ever been observed to move.',
        'This route writes nothing.',
      ],
    });
  } catch (err) {
    console.error('Freshness audit error:', err);
    return res.status(500).json({ error: 'Internal error', detail: String(err.message || err) });
  }
};
