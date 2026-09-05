// lib/thresholds.js
//
// Node status scoring. Returns 'red' | 'amber' | 'green' | 'unknown'.
//
// WHAT CHANGED vs the version that produced the 2026-09-05 report:
//
// 1. FAIL-CLOSED. The old `catch { return 'green' }` turned any scoring
//    exception into an all-clear. Exceptions now produce 'unknown'.
//
// 2. NO TRUTHINESS GUARDS. Every rule was `if (v && v > X)`. Zero is falsy in
//    JS, so `cushing = 0` — actual tank bottoms — scored green, which is the
//    exact event N4 exists to detect. All comparisons are now explicit
//    null-checks against coerced numbers.
//
// 3. EXPLICIT UNKNOWN. A node whose critical inputs are missing, corrupt or
//    stale no longer scores green. It scores 'unknown' and carries reasons.
//
// 4. STALENESS GATES SCORING. Previously computed for display only, then
//    ignored by the scorer.
//
// 5. N6 SIGN CORRECTED. See getN6Status.
//
// 6. N1 AND -> combined utilisation. See getN1Status.
//
// Severity ordering for rollups: red > unknown > amber > green. 'unknown' sits
// above 'amber' deliberately: on this dashboard, not knowing whether the
// Atlantic backup route is saturated is worse than knowing it is strained.

const { readValue } = require('./values');

const SEVERITY = { green: 0, amber: 1, unknown: 2, red: 3 };

// Inputs that must be usable for a 'green' on this node to mean anything.
// If any is unusable and no rule has fired, the node degrades to 'unknown'.
const CRITICAL_INPUTS = {
  n1: ['petroline_pct', 'adcop_pct'],
  n2: ['hormuz_portwatch'],
  n3: ['floating_storage_world', 'floating_storage_mideast'],
  n4: ['spr_level', 'cushing'],
  n5: ['diesel_crack', 'wti', 'brent'],
  n6: ['west_africa_diff', 'us_oil_rig_count'],
  n7: ['insurance_multiple', 'clubs_withdrawn'],
  n8: ['carriers_rerouting', 'vessels_high_risk'],
};

// ── history helpers ──────────────────────────────────────────────────────────

function numericHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(h => (h && typeof h === 'object' ? Number(h.value) : Number(h)))
    .filter(Number.isFinite);
}

function calcDrawRate(history) {
  const v = numericHistory(history).slice(-4);
  if (v.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < v.length; i++) deltas.push(v[i - 1] - v[i]); // positive = draw
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

function calcProductionDelta(history) {
  const v = numericHistory(history);
  if (v.length < 8) return null;
  const recent = v.slice(-4);
  const prior = v.slice(-8, -4);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  return avg(recent) - avg(prior); // negative = declining
}

// ── reader ───────────────────────────────────────────────────────────────────

/**
 * Builds a per-node reader that coerces, bounds-checks and freshness-checks
 * each value, recording every rejection so the UI can say WHY a node is
 * unknown rather than just showing a grey dot.
 */
function makeReader(ctx, out) {
  const values = (ctx && ctx.values) || {};
  const staleMap = (ctx && ctx.stale) || {};

  return function get(key) {
    const res = readValue(key, values[key], { stale: staleMap[key] === true });
    if (!res.ok) {
      out.rejected.push({
        key,
        reason: res.reason,
        detail: res.detail || null,
        raw: res.reason === 'missing' ? null : values[key],
      });
      return null;
    }
    return res.value;
  };
}

// ── node scorers ─────────────────────────────────────────────────────────────

// N1 — Gulf production & bypass
//
// Old rule required petroline >= 98 AND adcop >= 100. With ADCOP pinned at
// 100% and Petroline at 95%, roughly 6.25 of 6.5M bpd of bypass was committed
// and the node scored amber, because one line was not quite full. Bypass
// exhaustion is a capacity-weighted question, not an all-lines-full question.
const PETROLINE_CAP = 5.0; // M bpd
const ADCOP_CAP = 1.5;     // M bpd

function getN1Status(get, ctx, out) {
  const petroline = get('petroline_pct');
  const adcop = get('adcop_pct');

  if (petroline !== null && adcop !== null) {
    const committed = (PETROLINE_CAP * petroline + ADCOP_CAP * adcop) / 100;
    const combined = (committed / (PETROLINE_CAP + ADCOP_CAP)) * 100;
    out.detail.bypass_committed_mbpd = Math.round(committed * 100) / 100;
    out.detail.bypass_utilisation_pct = Math.round(combined * 10) / 10;

    if (combined >= 97) return reason(out, 'red', `combined bypass utilisation ${combined.toFixed(1)}% — no headroom`);
    if (combined >= 90) return reason(out, 'amber', `combined bypass utilisation ${combined.toFixed(1)}%`);
  }

  // Either line individually pinned is still a signal even if the other is idle.
  if (petroline !== null && petroline >= 99) return reason(out, 'amber', 'Petroline at capacity');
  if (adcop !== null && adcop >= 100) return reason(out, 'amber', 'ADCOP at capacity');

  return null;
}

// N2 — Chokepoint transit
function getN2Status(get, ctx, out) {
  const portwatch = get('hormuz_portwatch');
  const darkAis = get('hormuz_dark_ais');
  const stranded = get('stranded_offshore');
  const babPw = get('bab_portwatch');

  if (portwatch !== null) {
    if (portwatch <= 15) return reason(out, 'red', `Hormuz transits ${portwatch}/day`);
    // Compound check now runs at 0 too — the old `portwatch &&` guard skipped
    // the closure case entirely.
    if (portwatch <= 30 && babPw !== null && babPw < 10) {
      return reason(out, 'red', 'Hormuz throttled and Bab el-Mandeb near-closed');
    }
    if (portwatch <= 30) return reason(out, 'amber', `Hormuz transits ${portwatch}/day`);
  }

  if (darkAis !== null && darkAis > 60) return reason(out, 'amber', `AIS dark count ${darkAis}`);
  if (stranded !== null && stranded > 500) return reason(out, 'amber', `${stranded} vessels stranded offshore`);

  return null;
}

// N3 — Tanker availability
function getN3Status(get, ctx, out) {
  const world = get('floating_storage_world');
  const mideast = get('floating_storage_mideast');
  const shadow = get('shadow_fleet_share');

  if (world !== null && world > 140000) return reason(out, 'red', 'world floating storage at crisis absorption');
  if (mideast !== null && mideast > 30000) return reason(out, 'red', 'severe Gulf congestion');
  if (world !== null && world > 120000) return reason(out, 'amber', 'world floating storage elevated');
  if (mideast !== null && mideast > 25000) return reason(out, 'amber', 'Gulf congestion building');
  if (shadow !== null && (shadow > 33 || shadow < 23)) {
    return reason(out, 'amber', `shadow fleet carriage ${shadow}% outside 23–33 band`);
  }
  return null;
}

// N4 — Storage buffers
const DOE_FLOOR_KBBL = 282000;

function getN4Status(get, ctx, out) {
  const spr = get('spr_level');
  const cushing = get('cushing');
  const histories = (ctx && ctx.histories) || {};

  const drawRate = calcDrawRate(histories.spr_level);
  const drawMb = drawRate !== null ? drawRate / 1000 : null;
  if (drawMb !== null) out.detail.spr_draw_mb_per_wk = Math.round(drawMb * 100) / 100;

  if (drawMb !== null && drawMb > 4) return reason(out, 'red', `SPR draw ${drawMb.toFixed(1)}mb/wk`);
  // Explicit null-check: cushing === 0 is tank bottoms, not missing data.
  if (cushing !== null && cushing < 18000) return reason(out, 'red', `Cushing ${(cushing / 1000).toFixed(1)}mb below operational minimum`);
  if (drawMb !== null && drawMb > 2.5) return reason(out, 'amber', `SPR draw ${drawMb.toFixed(1)}mb/wk`);
  if (cushing !== null && cushing < 22000) return reason(out, 'amber', `Cushing ${(cushing / 1000).toFixed(1)}mb`);

  if (spr !== null && drawRate !== null && drawRate > 0) {
    const weeks = (spr - DOE_FLOOR_KBBL) / drawRate;
    out.detail.spr_weeks_to_floor = Math.round(weeks * 10) / 10;
    if (weeks < 12) return reason(out, 'amber', `SPR ${weeks.toFixed(0)} weeks above EPCA floor at current draw`);
  }
  return null;
}

// N5 — Refining & products
//
// NOTE (methodology, not a bug): cracks are computed against WTI while the
// product legs are NYH cargoes. Atlantic-basin convention is Brent. The
// thresholds below were calibrated on the WTI-based series, so changing the
// reference means recalibrating them — do both together or neither.
function getN5Status(get, ctx, out) {
  const diesel = get('diesel_crack');
  const gasoline = get('gasoline_crack');
  const wti = get('wti');
  const brent = get('brent');

  const spread = (wti !== null && brent !== null) ? Math.abs(wti - brent) : null;
  if (spread !== null) out.detail.wti_brent_spread = Math.round(spread * 100) / 100;

  if (diesel !== null && diesel > 40) return reason(out, 'red', `diesel crack $${diesel.toFixed(0)}/bbl`);
  if (diesel !== null && diesel > 30) return reason(out, 'amber', `diesel crack $${diesel.toFixed(0)}/bbl`);
  if (gasoline !== null && gasoline > 25) return reason(out, 'amber', `gasoline crack $${gasoline.toFixed(0)}/bbl`);
  if (spread !== null && spread > 12) return reason(out, 'amber', `WTI-Brent spread $${spread.toFixed(2)}`);
  return null;
}

// N6 — Alternative supply routes
//
// SIGN CORRECTION. The old rule was `west_africa_diff > 8 => red`, which is
// backwards for the mechanism the node models. When West African crude loses
// its eastern outlet and clears into Europe, WAF grades get CHEAPER against
// Dated Brent. Backup-route saturation is a widening DISCOUNT, not a premium.
//
// Calibration: Bonny Light OSP ran ~+$0.50 to +$2.16 vs Dated Brent through
// normal periods; the May 2020 glut priced Qua Iboe and Bonny Light at -$3.92
// and -$3.95, with most Nigerian grades at least $3 under. So:
//
//   RED   <= -3.00  Atlantic clearing point saturated
//   AMBER <= -1.50  backup route absorbing stress
//   AMBER >= +3.00  Atlantic tightness — informational, opposite mechanism
//
// The old `> 8` threshold has never been reached in either direction.
const WAF_RED = -3.00;
const WAF_AMBER = -1.50;
const WAF_TIGHT_AMBER = 3.00;

function getN6Status(get, ctx, out) {
  const waf = get('west_africa_diff');
  const rigs = get('us_oil_rig_count');
  const histories = (ctx && ctx.histories) || {};

  if (waf !== null && waf <= WAF_RED) {
    return reason(out, 'red', `WAF differential ${fmtDiff(waf)} vs Dated Brent — backup route saturated`);
  }
  if (rigs !== null && rigs < 350) return reason(out, 'red', `US oil rig count ${rigs} — production base eroding`);
  if (waf !== null && waf <= WAF_AMBER) {
    return reason(out, 'amber', `WAF differential ${fmtDiff(waf)} vs Dated Brent`);
  }
  if (rigs !== null && rigs < 400) return reason(out, 'amber', `US oil rig count ${rigs}`);
  if (waf !== null && waf >= WAF_TIGHT_AMBER) {
    return reason(out, 'amber', `WAF differential ${fmtDiff(waf)} — Atlantic tightness`);
  }

  const delta = calcProductionDelta(histories.us_crude_production);
  if (delta !== null) out.detail.production_delta_kbd = Math.round(delta);
  if (delta !== null && delta < -200) {
    return reason(out, 'amber', `US production down ${Math.abs(delta).toFixed(0)}K bbl/d on 4-week average`);
  }
  return null;
}

function fmtDiff(v) {
  return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
}

// N7 — Insurance & risk premium
//
// warrisk_band is a PERCENT OF HULL. It is currently holding 10000000, the
// VLCC dollar premium written into the wrong key. The old numeric branch
// (`warrisk > 5 => red`) fired on that dollar figure. Today the result is
// masked because insurance_multiple = 40 returns red first — but when the
// multiple normalises, the node would stay pinned red forever on corrupt data,
// misfiring exactly during de-escalation. values.js now rejects it as
// out-of-range, so N7 degrades to unknown instead of lying in either direction.
function getN7Status(get, ctx, out) {
  const multiple = get('insurance_multiple');
  const clubs = get('clubs_withdrawn');
  const band = get('warrisk_band'); // upper edge, in % of hull

  if (multiple !== null && multiple >= 20) return reason(out, 'red', `insurance multiple ${multiple}x peacetime`);
  if (clubs !== null && clubs >= 4) return reason(out, 'red', `${clubs} P&I clubs withdrawn`);
  if (multiple !== null && multiple >= 10) return reason(out, 'amber', `insurance multiple ${multiple}x peacetime`);
  if (clubs !== null && clubs >= 2) return reason(out, 'amber', `${clubs} P&I clubs withdrawn`);

  if (band !== null && band > 5) return reason(out, 'red', `war-risk band upper ${band}% of hull`);
  if (band !== null && band > 3) return reason(out, 'amber', `war-risk band upper ${band}% of hull`);
  return null;
}

// N8 — Sanctions architecture
//
// g7_carriage_share is now scored symmetrically. The tripwire is the share
// breaking out of its 23–33 band in EITHER direction; the old rule only
// caught the upside.
function getN8Status(get, ctx, out) {
  const highRisk = get('vessels_high_risk');
  const rerouting = get('carriers_rerouting');
  const g7Share = get('g7_carriage_share');

  if (rerouting !== null && rerouting >= 7) return reason(out, 'red', `${rerouting} major carriers rerouting`);
  if (highRisk !== null && highRisk > 80) return reason(out, 'red', `${highRisk} vessels matching OFAC SDN`);
  if (g7Share !== null && (g7Share > 35 || g7Share < 21)) {
    return reason(out, 'red', `G7-linked carriage ${g7Share}% — decisive break from 23–33 band`);
  }
  if (rerouting !== null && rerouting >= 4) return reason(out, 'amber', `${rerouting} major carriers rerouting`);
  if (highRisk !== null && highRisk > 40) return reason(out, 'amber', `${highRisk} vessels matching OFAC SDN`);
  if (g7Share !== null && (g7Share > 30 || g7Share < 23)) {
    return reason(out, 'amber', `G7-linked carriage ${g7Share}% outside 23–33 band`);
  }
  return null;
}

// ── orchestration ────────────────────────────────────────────────────────────

function reason(out, status, text) {
  out.reasons.push(text);
  return status;
}

const STATUS_FUNCTIONS = {
  n1: getN1Status,
  n2: getN2Status,
  n3: getN3Status,
  n4: getN4Status,
  n5: getN5Status,
  n6: getN6Status,
  n7: getN7Status,
  n8: getN8Status,
};

/**
 * @param {string} nodeId
 * @param {object} ctx  { values: {key: raw}, histories: {key: []}, stale: {key: bool} }
 * @returns {{status, reasons, rejected, detail, degraded, criticalMissing}}
 */
function calculateNodeStatus(nodeId, ctx) {
  const out = { reasons: [], rejected: [], detail: {} };
  const fn = STATUS_FUNCTIONS[nodeId];

  if (!fn) {
    return finish(out, 'unknown', [], ['no scoring function for ' + nodeId]);
  }

  let fired = null;
  try {
    const get = makeReader(ctx, out);
    fired = fn(get, ctx, out);
  } catch (err) {
    // Fail closed. The previous implementation returned 'green' here.
    out.threw = true;
    return finish(out, 'unknown', [], [`scoring error: ${err.message}`]);
  }

  const critical = CRITICAL_INPUTS[nodeId] || [];
  const rejectedKeys = new Set(out.rejected.map(r => r.key));
  const criticalMissing = critical.filter(k => rejectedKeys.has(k));

  // A fired rule stands on its own evidence — a red is still a red even if a
  // sibling series is broken. But a clean sheet only means green if we
  // actually looked at everything that matters.
  if (fired) return finish(out, fired, criticalMissing);
  if (criticalMissing.length > 0) {
    return finish(out, 'unknown', criticalMissing,
      criticalMissing.map(k => {
        const r = out.rejected.find(x => x.key === k);
        return `${k}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`;
      }));
  }
  return finish(out, 'green', []);
}

function finish(out, status, criticalMissing, extraReasons) {
  if (extraReasons) out.reasons.push(...extraReasons);
  return {
    status,
    reasons: out.reasons,
    rejected: out.rejected,
    detail: out.detail,
    criticalMissing: criticalMissing || [],
    degraded: Boolean(out.threw) || (criticalMissing || []).length > 0 || out.rejected.length > 0,
  };
}

function worstStatus(statuses) {
  let worst = 'green';
  for (const s of statuses) {
    if ((SEVERITY[s] || 0) > SEVERITY[worst]) worst = s;
  }
  return worst;
}

module.exports = {
  calculateNodeStatus,
  worstStatus,
  SEVERITY,
  CRITICAL_INPUTS,
  WAF_RED,
  WAF_AMBER,
};
