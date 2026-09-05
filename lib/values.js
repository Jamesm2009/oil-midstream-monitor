// lib/values.js
//
// Coercion + plausibility gate for every scored series.
//
// Rationale: the 2026-09-05 report scored N6 green while west_africa_diff held
// 94.49 (an outright price, not a differential), and N7 held warrisk_band =
// 10000000 (a dollar premium written into a percent field). Neither was caught
// because the scorer compared raw stored values directly.
//
// Every value now passes through readValue() before scoring. A value that is
// missing, non-numeric, or outside its declared plausible range is REJECTED —
// it does not score, and its absence degrades the node to 'unknown' rather
// than silently leaving it green.

// [min, max] in the series' own declared config unit. Bounds are deliberately
// wide: they exist to catch unit errors and wrong-series writes, not to
// second-guess the market.
const SERIES_BOUNDS = {
  // N1 — pipeline utilisation (%)
  petroline_pct:              [0, 105],
  adcop_pct:                  [0, 105],

  // N2 — chokepoint transits (vessels/day)
  hormuz_portwatch:           [0, 200],
  hormuz_tanker:              [0, 120],
  hormuz_dark_ais:            [0, 500],
  stranded_offshore:          [0, 2000],
  bab_portwatch:              [0, 200],
  suez_portwatch:             [0, 200],
  cape_portwatch:             [0, 200],
  panama_portwatch:           [0, 200],

  // N3 — tanker availability
  floating_storage_world:     [0, 400000],    // K bbl
  floating_storage_mideast:   [0, 150000],    // K bbl
  vlcc_spot:                  [0, 2000000],   // $/day
  shadow_fleet_share:         [0, 100],       // %

  // N4 — storage (K bbl)
  spr_level:                  [0, 800000],
  cushing:                    [0, 100000],
  commercial_crude:           [0, 700000],
  gasoline_stocks:            [0, 400000],
  distillate_stocks:          [0, 300000],
  refinery_utilisation:       [0, 105],       // %

  // N5 — prices ($/bbl). WTI floor is negative on purpose: 2020-04-20.
  wti:                        [-60, 400],
  brent:                      [0, 400],
  gasoline_crack:             [-40, 200],
  diesel_crack:               [-40, 250],

  // N6 — alternative routes
  us_crude_production:        [5000, 20000],  // K bbl/d
  us_crude_exports:           [200, 10000],   // K bbl/d — catches the 0.0M artifact
  us_crude_exports_wk:        [200, 10000],   // K bbl/d
  us_oil_rig_count:           [100, 900],     // rigs
  brazil_exports:             [0.2, 4.0],     // M bbl/d — catches the 8.5 entry
  guyana_production:          [0, 3000],      // K bbl/d
  west_africa_diff:           [-15, 10],      // $/bbl vs Dated Brent — catches 94.49

  // N7 — insurance
  insurance_multiple:         [1, 300],       // x peacetime
  vlcc_premium_high:          [0, 50000000],  // $
  clubs_withdrawn:            [0, 20],        // count
  warrisk_band:               [0, 100],       // % of hull — catches 10000000

  // N8 — sanctions
  vessels_high_risk:          [0, 5000],
  carriers_rerouting:         [0, 50],
  price_cap:                  [0, 200],       // $/bbl
  shadow_fleet_designations:  [0, 5000],
  g7_carriage_share:          [0, 100],       // %
};

// Series legitimately stored as a range string, e.g. "3-8" for a war-risk band.
const BAND_SERIES = new Set(['warrisk_band']);

/**
 * Strict numeric coercion. Returns a finite number or null.
 * Tolerates currency symbols, thousands separators and trailing % on strings,
 * because manual entry produces all three. Explicitly does NOT treat '' or
 * null as 0.
 */
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const cleaned = raw.replace(/[$,\s%]/g, '').replace(/[~]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a band such as "3-8" or "3–8" into { low, high }.
 * A bare number is treated as a degenerate band. Returns null if unparseable.
 * Note: a leading minus is handled, so "-2--1" is not supported and will be
 * rejected — bands of that shape should be stored as {low, high} objects.
 */
function parseBand(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const low = toNumber(raw.low);
    const high = toNumber(raw.high);
    if (low !== null && high !== null) return { low, high };
    return null;
  }
  if (typeof raw === 'string') {
    const m = raw.replace(/[$,\s%]/g, '').match(/^(-?\d*\.?\d+)[-–](-?\d*\.?\d+)$/);
    if (m) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      if (Number.isFinite(low) && Number.isFinite(high)) return { low, high };
    }
  }
  const n = toNumber(raw);
  if (n !== null) return { low: n, high: n };
  return null;
}

/**
 * The single entry point scoring uses.
 *
 * Returns { ok, value, band, reason }.
 *   ok:false + reason:'missing'    — no data stored
 *   ok:false + reason:'unparseable'— stored but not a number/band
 *   ok:false + reason:'out_of_range' — stored, numeric, implausible for the unit
 *   ok:false + reason:'stale'      — usable but older than its cadence allows
 */
function readValue(key, raw, opts) {
  const options = opts || {};

  if (raw === null || raw === undefined) {
    return { ok: false, value: null, band: null, reason: 'missing' };
  }

  let band = null;
  let value = null;

  if (BAND_SERIES.has(key)) {
    band = parseBand(raw);
    if (!band) return { ok: false, value: null, band: null, reason: 'unparseable' };
    value = band.high; // score the upper edge of the band
  } else {
    value = toNumber(raw);
    if (value === null) {
      return { ok: false, value: null, band: null, reason: 'unparseable' };
    }
  }

  const bounds = SERIES_BOUNDS[key];
  if (bounds) {
    const probe = band ? [band.low, band.high] : [value];
    for (const p of probe) {
      if (p < bounds[0] || p > bounds[1]) {
        return {
          ok: false,
          value,
          band,
          reason: 'out_of_range',
          detail: `${p} outside [${bounds[0]}, ${bounds[1]}]`,
        };
      }
    }
  }

  // Freshness is a scoring gate, not just a display flag. A stale number is
  // not evidence about now.
  if (options.stale === true) {
    return { ok: false, value, band, reason: 'stale' };
  }

  return { ok: true, value, band, reason: null };
}

module.exports = { readValue, toNumber, parseBand, SERIES_BOUNDS, BAND_SERIES };
