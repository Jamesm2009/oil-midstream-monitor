// api/audit-repair.js
//
// Walks stored series, applies the lib/values.js plausibility gate to every
// point, and reports what is corrupt. With ?apply=1 it moves the bad points to
// a quarantine key and rewrites the series without them.
//
// It does NOT invent replacements. A series emptied by quarantine will score
// 'unknown' under the current thresholds, which is the correct state: we know
// the number is wrong and we do not yet know the right one.
//
// CHANGELOG (Sep 7, 2026):
// - Was a CLI script (shebang, process.argv, console.log, no export). Nothing
//   in api/ can run that way, and there is no terminal on this project, so it
//   never deployed. Now an HTTP handler.
// - WRITES ARE RESTRICTED TO SERIES WITH DECLARED BOUNDS. readValue() rejects
//   any non-numeric value as 'unparseable', and several unscored fields hold
//   composite text on purpose — fujairah_yanbu_split "~1.6-1.8 / ~1.93",
//   vlcc_spot "~$600K+/day", price_cap "$60/bbl", ofac_waivers, jwc_areas. A
//   blanket apply would have deleted all of them. Membership of
//   SERIES_BOUNDS is the definition of "numeric series we score"; anything
//   outside it is reported under unscored_series and never written.
// - APPLY REQUIRES AN EXPLICIT ?series=. There is no mass-delete path.
//
// Usage (browser, GET):
//   /api/audit-repair                                  dry run, every series
//   /api/audit-repair?series=n6:west_africa_diff       dry run, one series
//   /api/audit-repair?series=n6:west_africa_diff&apply=1   quarantine + rewrite
//
// Note: ?series= scopes the audit. ?key= is reserved for auth, to match the
// other routes — the two must not be conflated.

const { requireAuth } = require('../lib/auth');
const { getRedis } = require('../lib/redis');
const { NODES } = require('../lib/config');
const { readValue, SERIES_BOUNDS } = require('../lib/values');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  try {
    const redis = getRedis();

    const q = req.query || {};
    const apply = q.apply === '1' || q.apply === 'true';
    const scope = q.series ? String(q.series).trim() : null;
    const confirmEmpty = q.confirm_empty === '1' || q.confirm_empty === 'true';

    // Full inventory from lib/config — the single source of truth.
    const inventory = [];
    for (const node of NODES) {
      for (const s of node.series) {
        inventory.push({
          redis_key: `series:${node.id}:${s.key}`,
          node: node.id,
          series: s.key,
          unit: s.unit,
          bounds: SERIES_BOUNDS[s.key] || null,
          writable: Boolean(SERIES_BOUNDS[s.key]),
        });
      }
    }

    // Scope accepts 'n6:west_africa_diff', 'west_africa_diff', or the full
    // 'series:n6:west_africa_diff'.
    let targets = inventory;
    if (scope) {
      const norm = scope.replace(/^series:/, '');
      targets = inventory.filter(e =>
        e.redis_key === scope ||
        `${e.node}:${e.series}` === norm ||
        e.series === norm
      );
      if (targets.length === 0) {
        return res.status(400).json({
          error: `No series matched '${scope}'`,
          hint: 'Use node:series, e.g. n6:west_africa_diff',
        });
      }
      if (targets.length > 1 && apply) {
        return res.status(400).json({
          error: `'${scope}' matched ${targets.length} series; apply needs exactly one`,
          matched: targets.map(t => `${t.node}:${t.series}`),
        });
      }
    }

    if (apply && !scope) {
      return res.status(400).json({
        error: 'apply requires an explicit ?series=',
        reason: 'There is no mass-delete path. Quarantine one series at a time.',
      });
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
        // never rewritten — repairing these blind is how the corruption
        // happened in the first place.
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
        // No stale option: every historical point is old by definition.
        // Freshness is a scoring question, not a data-integrity one.
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
        // Unscored / text-shaped field. Report only.
        finding.note = 'No declared bounds — treated as unscored. Never rewritten by this route.';
        unscored.push(finding);
        continue;
      }

      totalBad += bad.length;

      if (apply && good.length === 0 && !confirmEmpty) {
        // Emptying a series is a deliberate act, not a side effect. It leaves
        // the node scoring 'unknown' with nothing to fall back on.
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

    return res.status(200).json({
      mode: apply ? 'apply' : 'dry_run',
      generated: new Date().toISOString(),
      scope: scope || 'all',
      series_checked: targets.length,
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
      ],
    });
  } catch (err) {
    console.error('Audit repair error:', err);
    return res.status(500).json({ error: 'Internal error', detail: String(err.message || err) });
  }
};
