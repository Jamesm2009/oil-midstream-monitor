// api/audit-repair.js
//
// Two diagnostics over the same series inventory, in one serverless function
// because the Hobby plan caps a deployment at 12.
//
//   ?mode=integrity  (default)  Are the stored VALUES valid?
//                               Applies the lib/values.js plausibility gate to
//                               every point. With &apply=1, moves bad points to
//                               a quarantine key and rewrites without them.
//
//   ?mode=freshness             Are the stored values still MOVING?
//                               Read-only. Derives each series' true vintage
//                               from the date its value last changed, and
//                               compares that to the date it claims.
//
// Integrity mode is the only one that writes. Freshness mode has no set() call
// on any path.
//
// CHANGELOG (Sep 15, 2026):
// - Freshness mode folded in from a separate api/freshness-audit.js, which
//   could not deploy: it would have been the 13th serverless function against
//   a Hobby cap of 12, and the build fails with no explanation when that is
//   exceeded.
//
// CHANGELOG (Sep 7, 2026):
// - Was a CLI script (shebang, process.argv, console.log, no export). Nothing
//   in api/ can run that way, and there is no terminal on this project, so it
//   never deployed. Now an HTTP handler.
// - WRITES ARE RESTRICTED TO SERIES WITH DECLARED BOUNDS. readValue() rejects
//   any non-numeric value as 'unparseable', and several unscored fields hold
//   composite text on purpose — fujairah_yanbu_split "~1.6-1.8 / ~1.93",
//   vlcc_spot "~$600K+/day", price_cap "$60/bbl", ofac_waivers, jwc_areas. A
//   blanket apply would have deleted all of them. Membership of SERIES_BOUNDS
//   is the definition of "numeric series we score"; anything outside it is
//   reported under unscored_series and never written.
// - APPLY REQUIRES AN EXPLICIT ?series=. There is no mass-delete path.
//
// Usage (browser, GET):
//   /api/audit-repair                                     integrity, all series
//   /api/audit-repair?series=n6:west_africa_diff           integrity, one series
//   /api/audit-repair?series=n6:west_africa_diff&apply=1   quarantine + rewrite
//   /api/audit-repair?mode=freshness                       freshness, all series
//   /api/audit-repair?mode=freshness&min_gap=7             gaps of 7+ days only
//
// Note: ?series= scopes the audit. ?key= is reserved for auth, to match the
// other routes — the two must not be conflated.

const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES, STALE_THRESHOLDS } = require('../lib/config');
const { readValue, SERIES_BOUNDS } = require('../lib/values');

const DAY_MS = 86400000;

function buildInventory() {
  const out = [];
  for (const node of NODES) {
    for (const s of node.series) {
      out.push({
        redis_key: `series:${node.id}:${s.key}`,
        node: node.id,
        series: s.key,
        label: s.label,
        unit: s.unit,
        cadence: s.cadence,
        manual: Boolean(s.manual),
        bounds: SERIES_BOUNDS[s.key] || null,
        writable: Boolean(SERIES_BOUNDS[s.key]),
        stale_threshold_days: STALE_THRESHOLDS[s.cadence] || 30,
      });
    }
  }
  return out;
}

// Scope accepts 'n6:west_africa_diff', 'west_africa_diff', or the full
// 'series:n6:west_africa_diff'.
function matchScope(inventory, scope) {
  const norm = scope.replace(/^series:/, '');
  return inventory.filter(e =>
    e.redis_key === scope ||
    `${e.node}:${e.series}` === norm ||
    e.series === norm
  );
}

function parseDate(d) {
  if (!d || typeof d !== 'string') return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

// Values are numbers, strings or null. JSON comparison handles all three
// without coercing "6" and 6 into a match.
function sameValue(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

// Longest run of consecutive equal values anywhere before the current run,
// measured in days. This is what the current run gets judged against.
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

// ── Freshness mode ──────────────────────────────────────────────────────────
//
// Every series carries two ages, and only one is displayed anywhere:
//   stamped age — how old the newest point's date is
//   true age    — how old its VALUE is, i.e. when it last moved
// A field whose upstream restamps a frozen value daily has a stamped age of 0
// and a true age of weeks. That gap is what gets published as fresh.
//
// This works because of an accident of api/cron/fetch-data.js: appendToHistory
// skips a point whose date already exists, but straits.live advances its own
// asOf/updatedAt daily. An unchanged upstream value is therefore already
// recorded as a new point per day. The evidence is in Redis already.
//
// It CANNOT tell "not updating" from "genuinely unchanged" — a $60 price cap
// really is $60. So each series is calibrated against its own past rather than
// a fixed rule, and everything else is reported for a human to judge.
async function runFreshness(redis, targets, q) {
  const minGap = q.min_gap ? Number(q.min_gap) : null;
  const now = Date.now();
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
      skipped.push({
        ...entry,
        skip_reason: (history === null || history === undefined) ? 'no data' : 'stored value is not an array',
      });
      continue;
    }

    // appendToHistory keeps these date-ascending, but do not assume it.
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
    // number now on display was actually last a new number.
    let runStart = points.length - 1;
    while (runStart > 0 && sameValue(points[runStart - 1].value, latest.value)) runStart--;

    const lastChange = points[runStart];
    const lastChangeTs = parseDate(lastChange.date);

    const stampedAge = latestTs === null ? null : Math.round((now - latestTs) / DAY_MS);
    const trueAge = lastChangeTs === null ? null : Math.round((now - lastChangeTs) / DAY_MS);
    const runDays = (latestTs !== null && lastChangeTs !== null)
      ? Math.round((latestTs - lastChangeTs) / DAY_MS)
      : null;

    const distinct = new Set(points.map(p => JSON.stringify(p.value === undefined ? null : p.value))).size;
    const priorRun = longestPriorRunDays(points, runStart);

    let classification;
    let note = null;
    if (points.length < 3) {
      classification = 'insufficient_history';
      note = 'Fewer than 3 points. No basis for comparison.';
    } else if (distinct === 1) {
      classification = 'never_varied';
      note = 'One value for its whole recorded history. Flat may be its nature, or it may never have worked. Cannot tell from here.';
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
      redis_key: entry.redis_key,
      node: entry.node,
      series: entry.series,
      label: entry.label,
      cadence: entry.cadence,
      manual: entry.manual,
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

  return {
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
      'A genuine step change to a new constant also reads as frozen — Petroline dropping to 0 and staying there will appear here.',
      'never_varied cannot be judged from history alone. Check whether the field has ever been observed to move.',
      'Freshness mode writes nothing.',
    ],
  };
}

// ── Integrity mode ──────────────────────────────────────────────────────────
async function runIntegrity(redis, targets, q, scope) {
  const apply = q.apply === '1' || q.apply === 'true';
  const confirmEmpty = q.confirm_empty === '1' || q.confirm_empty === 'true';

  if (apply && !scope) {
    return { error: 'apply requires an explicit ?series=', reason: 'There is no mass-delete path. Quarantine one series at a time.' };
  }
  if (apply && targets.length > 1) {
    return { error: `'${scope}' matched ${targets.length} series; apply needs exactly one`, matched: targets.map(t => `${t.node}:${t.series}`) };
  }

  const findings = [];
  const unscored = [];
  const skipped = [];
  let totalBad = 0;

  for (const entry of targets) {
    let history;
    try {
      history = await redis.get(entry.redis_key);
    } catch (err) {
      skipped.push({ ...entry, skip_reason: `redis read failed: ${err.message}` });
      continue;
    }

    if (history === null || history === undefined) {
      skipped.push({ ...entry, skip_reason: 'no data' });
      continue;
    }
    if (!Array.isArray(history)) {
      // Double-encoded or character-corrupted writes land here. Reported,
      // never rewritten — repairing these blind is how the corruption happened
      // in the first place.
      skipped.push({
        ...entry,
        skip_reason: 'stored value is not an array',
        stored_type: typeof history,
        stored_preview: String(JSON.stringify(history)).slice(0, 120),
      });
      continue;
    }

    const good = [];
    const bad = [];

    for (const point of history) {
      if (!point || typeof point !== 'object' || point.value === undefined) {
        bad.push({ date: (point && point.date) || null, value: point, reason: 'malformed point', detail: null });
        continue;
      }
      // No stale option: every historical point is old by definition. Freshness
      // is a scoring question, and now a freshness-mode question — not a
      // data-integrity one.
      const r = readValue(entry.series, point.value);
      if (r.ok) good.push(point);
      else bad.push({ date: point.date || null, value: point.value, reason: r.reason, detail: r.detail || null });
    }

    if (bad.length === 0) continue;

    const finding = {
      ...entry,
      total: history.length,
      good_count: good.length,
      bad_count: bad.length,
      bad: bad.slice(0, 20),
      bad_truncated: bad.length > 20 ? bad.length - 20 : 0,
      would_empty: good.length === 0,
      applied: false,
      quarantine_key: null,
    };

    if (!entry.writable) {
      finding.note = 'No declared bounds — treated as unscored. Never rewritten by this route.';
      unscored.push(finding);
      continue;
    }

    totalBad += bad.length;

    if (apply && good.length === 0 && !confirmEmpty) {
      // Emptying a series is a deliberate act, not a side effect. It leaves the
      // node scoring 'unknown' with nothing to fall back on.
      finding.note = 'Refused: this apply would remove every point. Re-run with &confirm_empty=1 if that is intended.';
      finding.refused = true;
      findings.push(finding);
      continue;
    }

    if (apply) {
      const qKey = `quarantine:${entry.redis_key}:${new Date().toISOString().split('T')[0]}`;
      // Quarantine first, so the removed points exist somewhere before the
      // series is rewritten.
      await redis.set(qKey, bad);
      await redis.set(entry.redis_key, good);
      finding.applied = true;
      finding.quarantine_key = qKey;
    }

    findings.push(finding);
  }

  return {
    mode_detail: apply ? 'apply' : 'dry_run',
    summary: {
      series_with_bad_points: findings.length,
      bad_points: totalBad,
      emptied: findings.filter(f => f.would_empty && f.applied).map(f => f.redis_key),
      refused_would_empty: findings.filter(f => f.refused).map(f => f.redis_key),
      unscored_flagged: unscored.length,
      skipped: skipped.length,
    },
    findings,
    unscored_series: unscored,
    skipped,
    next: apply
      ? 'Re-run the dry run to confirm, then check /api/data for the new node status.'
      : (findings.length > 0
          ? 'Re-run with &apply=1 and a single ?series= to quarantine.'
          : 'Nothing to repair in scope.'),
    notes: [
      'A series emptied by quarantine scores unknown. That is intended — do not backfill it with guesses.',
      'Quarantined points are kept at quarantine:<series key>:<date> and can be read back from Redis.',
      'unscored_series is informational. Those fields hold text on purpose and are never rewritten.',
      'Bounds are a scoring gate, not a history gate. A long backfill will flag genuinely old values that were correct at the time — us_crude_exports holds real 1920s figures far below its modern bounds.',
    ],
  };
}

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  try {
    const redis = getRedis();
    const q = req.query || {};
    const mode = q.mode ? String(q.mode).trim().toLowerCase() : 'integrity';
    const scope = q.series ? String(q.series).trim() : null;

    if (mode !== 'integrity' && mode !== 'freshness') {
      return res.status(400).json({ error: `Unknown mode '${mode}'`, valid: ['integrity', 'freshness'] });
    }
    if (mode === 'freshness' && (q.apply === '1' || q.apply === 'true')) {
      return res.status(400).json({ error: 'apply is not valid in freshness mode', reason: 'Freshness mode is read-only.' });
    }

    const inventory = buildInventory();
    const targets = scope ? matchScope(inventory, scope) : inventory;

    if (targets.length === 0) {
      return res.status(400).json({ error: `No series matched '${scope}'`, hint: 'Use node:series, e.g. n6:west_africa_diff' });
    }

    const body = mode === 'freshness'
      ? await runFreshness(redis, targets, q)
      : await runIntegrity(redis, targets, q, scope);

    if (body.error) return res.status(400).json(body);

    return res.status(200).json({
      mode,
      generated: new Date().toISOString(),
      scope: scope || 'all',
      series_checked: targets.length,
      read_only: mode === 'freshness',
      ...body,
    });
  } catch (err) {
    console.error('Audit route error:', err);
    return res.status(500).json({ error: 'Internal error', detail: String(err.message || err) });
  }
};
