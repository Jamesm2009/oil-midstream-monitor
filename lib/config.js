// Config-driven node definitions
// This is the source of truth for all eight nodes.
// Adding a node here automatically creates a card on the dashboard.
//
// CHANGELOG (Sep 6, 2026):
// - Scoring now fails closed. A node whose critical inputs are missing,
//   corrupt or stale scores UNKNOWN, not green. Each thresholdInfo block
//   below names that node's critical inputs.
// - Stale data no longer scores. Previously computed for display only.
// - Values pass a plausibility gate (lib/values.js) before scoring.
// - N1: RED rule changed from "Petroline ≥98 AND ADCOP ≥100" to a
//   capacity-weighted combined utilisation across both lines.
// - N6: West African differential threshold SIGN CORRECTED. Saturation of
//   the Atlantic backup route shows as a widening discount, not a premium.
// - N6: west_africa_diff source changed from Argus to NNPC monthly OSPs.
// - N8: G7 carriage share now scores breakouts in both directions.
// - N7: warrisk_band is parsed as a range ("3-8"), not coerced to a number.
//
// CHANGELOG (Aug 29, 2026):
// - Switched N2 PortWatch data from straits.live relay to direct IMF PortWatch ArcGIS API
// - Added Panama Canal (chokepoint2) to N2
// - Added Hormuz tanker-specific count from PortWatch n_tanker
// - Added 'portwatch' stale cadence (10 days) for weekly Tuesday PortWatch updates
// - Removed 7 unfindable/non-scoring series:
//     N1: bypass_utilisation (redundant with automated Petroline/ADCOP)
//     N3: vlcc_period (12-month time charter — never sourced)
//     N4: chinese_spr (not publicly disclosed)
//     N4: fujairah_stocks (not found in any scan)
//     N5: singapore_margin (not found; PCS force majeure)
//     N7: dfc_status (never sourced)
//     N7: india_pool (never sourced)
// - Updated all manualSources and thresholdInfo panels

const NODES = [
  {
    id: 'n1',
    name: 'Gulf Production & Bypass',
    category: 'physical',
    summary: 'Bypass pipeline utilisation vs capacity, Fujairah/Yanbu split',
    keyMetric: 'Bypass utilisation as % of capacity',
    phase: 2,
    manualSources: [
      'AUTOMATED: straits.live → Petroline & ADCOP pipeline utilisation (daily)',
      'MANUAL: Kpler blog — Gulf seaborne crude exports (monthly recap, free)',
      'MANUAL: Windward AI / Vortexa — Fujairah vs Yanbu loading split (per assessment)',
    ],
    thresholdInfo: [
      'RED: Combined bypass utilisation ≥97% (no headroom across Petroline + ADCOP)',
      'AMBER: Combined bypass utilisation ≥90%',
      'AMBER: Petroline ≥99% or ADCOP at 100% individually',
      'Combined = capacity-weighted across both lines (5.0M + 1.5M bpd). The former "Petroline ≥98 AND ADCOP ≥100" rule scored amber when one line was full and the other nearly so.',
      'UNKNOWN: Petroline or ADCOP utilisation missing, corrupt or stale',
    ],
    series: [
      { key: 'petroline_pct', label: 'Petroline utilisation (5M bpd)', unit: '%', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'adcop_pct', label: 'ADCOP utilisation (1.5M bpd)', unit: '%', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'gulf_exports', label: 'Gulf crude exports', unit: 'M bbl/d', manual: true, cadence: 'monthly' },
      { key: 'fujairah_yanbu_split', label: 'Fujairah vs Yanbu split', unit: '%', manual: true, cadence: 'assessment' },
    ],
  },
  {
    id: 'n2',
    name: 'Chokepoint Transit',
    category: 'physical',
    summary: 'Hormuz, Bab el-Mandeb, Suez, Cape, Panama — automated IMF PortWatch + AIS',
    keyMetric: 'Hormuz PortWatch transits',
    phase: 1,
    manualSources: [
      'AUTOMATED: IMF PortWatch ArcGIS API — daily vessel counts for 5 chokepoints (updates Tuesdays 9 AM ET, ~7 day processing lag)',
      'AUTOMATED: PortWatch n_tanker field — Hormuz tanker-specific transits',
      'AUTOMATED: straits.live — AIS dark fleet count + stranded vessels (daily)',
      'NOTE: PortWatch data is AIS-derived estimates, not port authority counts. Weekly batch, not real-time.',
    ],
    thresholdInfo: [
      'RED: Hormuz PortWatch ≤15 transits/day',
      'RED: Hormuz ≤30 AND Bab el-Mandeb <10 (compound closure)',
      'AMBER: Hormuz PortWatch ≤30/day',
      'AMBER: AIS dark count >60',
      'AMBER: Stranded vessels >500',
      'NOTE: Panama is context (US export route to Asia), not a scoring trigger',
      'NOTE: Zero transits now scores. The former rules skipped the closure case, since 0 is falsy in JS.',
      'UNKNOWN: Hormuz PortWatch transits missing, corrupt or stale',
    ],
    series: [
      { key: 'hormuz_portwatch', label: 'Hormuz transits (PortWatch)', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'hormuz_tanker', label: 'Hormuz tanker transits', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'hormuz_dark_ais', label: 'Hormuz AIS dark count', unit: 'vessels', manual: false, cadence: 'daily', source: 'straits.live' },
      { key: 'stranded_offshore', label: 'Stranded vessels (offshore)', unit: 'vessels', manual: false, cadence: 'daily', source: 'straits.live' },
      { key: 'bab_portwatch', label: 'Bab el-Mandeb (PortWatch)', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'suez_portwatch', label: 'Suez (PortWatch)', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'cape_portwatch', label: 'Cape of Good Hope (PortWatch)', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
      { key: 'panama_portwatch', label: 'Panama Canal (PortWatch)', unit: '/day', manual: false, cadence: 'portwatch', source: 'IMF PortWatch' },
    ],
  },
  {
    id: 'n3',
    name: 'Tanker Availability',
    category: 'physical',
    summary: 'Floating storage, freight benchmarks, shadow fleet share',
    keyMetric: 'World floating storage',
    phase: 2,
    manualSources: [
      'MANUAL: MacroMicro (Vortexa data) — floating storage: world + Middle East (free chart, weekly) ← PRIMARY WEEKLY UPDATE',
      'MANUAL: Baltic Exchange (via trade press) — TD3C VLCC benchmark (weekly)',
      'MANUAL: KSE / CREA reports (PDF) — shadow fleet carriage share (monthly)',
      'NOTE: TD3C is currently a Yanbu-referenced synthetic since Feb 2026, not a Ras Tanura fixture. ~$5/bbl gap vs actual freight (see Fairway ETA "The Index That Doesn\'t Exist").',
    ],
    thresholdInfo: [
      'RED: World floating storage >140,000 K bbl (crisis-level fleet absorption)',
      'RED: Middle East floating storage >30,000 K bbl (severe Gulf congestion)',
      'AMBER: World floating storage >120,000 K bbl (capacity being absorbed)',
      'AMBER: Middle East floating storage >25,000 K bbl (Gulf congestion building)',
      'AMBER: Shadow fleet carriage share outside 23–33% band',
      'UNKNOWN: World or Middle East floating storage missing, corrupt or stale',
    ],
    series: [
      { key: 'floating_storage_world', label: 'World floating storage (Vortexa)', unit: 'K bbl', manual: true, cadence: 'weekly' },
      { key: 'floating_storage_mideast', label: 'Middle East floating storage', unit: 'K bbl', manual: true, cadence: 'weekly' },
      { key: 'vlcc_spot', label: 'TD3C benchmark (institutional)', unit: '$/day', manual: true, cadence: 'weekly' },
      { key: 'shadow_fleet_share', label: 'Shadow fleet carriage share', unit: '%', manual: true, cadence: 'monthly' },
    ],
  },
  {
    id: 'n4',
    name: 'Storage Buffers',
    category: 'physical',
    summary: 'SPR, Cushing, commercial stocks, product inventories, refinery utilisation',
    keyMetric: 'SPR level vs congressional floor',
    phase: 1,
    manualSources: [
      'AUTOMATED: EIA Weekly Petroleum Status Report — SPR, Cushing, commercial crude, gasoline, distillate stocks, refinery utilisation (weekly, Wed release)',
      'NOTE: All N4 series are fully automated. No manual updates required.',
      'NOTE: spr_level and commercial_crude currently hold only ~6 points. The draw rate is computed from the last 4, so it is thinly evidenced until backfill is re-run.',
    ],
    thresholdInfo: [
      'RED: SPR draw rate >4M bbl/week, or Cushing <18M bbl',
      'AMBER: SPR draw >2.5M/week, or Cushing <22M bbl',
      'AMBER: SPR weeks-to-floor <12 weeks (vs DOE contracted floor ~282M bbl)',
      'Draw rate = rolling average over last 4 weekly readings',
      'NOTE: Cushing at zero now scores RED. The former rule treated it as missing data.',
      'UNKNOWN: SPR level or Cushing stocks missing, corrupt or stale',
    ],
    series: [
      { key: 'spr_level', label: 'US SPR level', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WCSSTUS1.W' },
      { key: 'cushing', label: 'Cushing OK crude stocks', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.W_EPC0_SAX_YCUOK_MBBL.W' },
      { key: 'commercial_crude', label: 'US commercial crude stocks', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WCESTUS1.W' },
      { key: 'gasoline_stocks', label: 'US gasoline inventories', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WGTSTUS1.W' },
      { key: 'distillate_stocks', label: 'US distillate inventories', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WDISTUS1.W' },
      { key: 'refinery_utilisation', label: 'Refinery utilisation', unit: '%', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WPULEUS3.W' },
    ],
  },
  {
    id: 'n5',
    name: 'Refining & Products',
    category: 'physical',
    summary: 'WTI-Brent spread, crack spreads, product tightness',
    keyMetric: 'Diesel crack spread',
    phase: 1,
    manualSources: [
      'AUTOMATED: FRED → WTI + Brent spot prices (daily)',
      'AUTOMATED: Calculated → gasoline + diesel crack spreads from FRED inputs (daily)',
      'NOTE: All N5 series are fully automated. No manual updates required.',
      'NOTE: Diesel crack = (ULSD NY Harbor $/gal × 42) − WTI $/bbl. Fallback: heating oil DHOILNYH if ULSD stale.',
      'NOTE: Cracks reference WTI while the product legs are NY Harbor cargoes; Atlantic convention is Brent. Thresholds are calibrated on the WTI-based series, so changing the reference means recalibrating them.',
    ],
    thresholdInfo: [
      'RED: Diesel crack spread >$40/bbl',
      'AMBER: Diesel crack >$30/bbl',
      'AMBER: Gasoline crack >$25/bbl',
      'AMBER: WTI-Brent spread >$12/bbl',
      'UNKNOWN: Diesel crack, WTI or Brent missing, corrupt or stale',
    ],
    series: [
      { key: 'wti', label: 'WTI spot price', unit: '$/bbl', manual: false, cadence: 'daily', source: 'FRED', fredId: 'DCOILWTICO' },
      { key: 'brent', label: 'Brent spot price', unit: '$/bbl', manual: false, cadence: 'daily', source: 'FRED', fredId: 'DCOILBRENTEU' },
      { key: 'gasoline_crack', label: 'Gasoline crack spread', unit: '$/bbl', manual: false, cadence: 'daily', source: 'calculated' },
      { key: 'diesel_crack', label: 'Diesel crack spread', unit: '$/bbl', manual: false, cadence: 'daily', source: 'calculated' },
    ],
  },
  {
    id: 'n6',
    name: 'Alternative Supply Routes',
    category: 'physical',
    summary: 'US production & exports, rig count, Atlantic basin substitution',
    keyMetric: 'US crude production vs export capacity',
    phase: 1,
    manualSources: [
      'AUTOMATED: EIA → US crude production weekly, US crude exports weekly + monthly',
      'MANUAL: Baker Hughes → US oil rig count (weekly, Friday release)',
      'MANUAL: Petrobras quarterly / ANP → Brazil crude exports',
      'MANUAL: Hess quarterly / trade press → Guyana production',
      'MANUAL: NNPC monthly OSPs → Bonny Light / Qua Iboe differential to Dated Brent (free, via trade press). Monthly administered differential, same mechanism as Aramco OSPs.',
      'WARNING: west_africa_diff must be a DIFFERENTIAL to Dated Brent, not a landed or outright price. A landed-value figure was stored here through Sep 2026 and is now rejected by the plausibility gate.',
      'NOTE: EIA Table 21 Nigeria F.O.B. costs are mostly withheld since US imports of Nigerian crude collapsed. Not a usable automated source.',
    ],
    thresholdInfo: [
      'RED: West African differential ≤ −$3.00/bbl vs Dated Brent (Atlantic clearing point saturated)',
      'RED: US oil rig count <350 while exports elevated (production base eroding)',
      'AMBER: West African differential ≤ −$1.50/bbl vs Dated Brent',
      'AMBER: West African differential ≥ +$3.00/bbl (Atlantic tightness — opposite mechanism, informational)',
      'AMBER: US oil rig count <400 (substitution capacity declining)',
      'AMBER: US crude production declining >200K bbl/d from 4-week average',
      'SIGN: Backup-route saturation shows as a widening DISCOUNT, not a premium. When WAF crude loses its eastern outlet and clears into Europe, the grades get cheaper against Dated Brent. The former ">$8/bbl = RED" rule had this backwards and had never fired in either direction.',
      'CALIBRATION: Bonny Light OSP ran roughly +$0.50 to +$2.16 vs Dated Brent in normal periods; the May 2020 glut priced Nigerian grades at −$3.92 to −$3.95.',
      'UNKNOWN: West African differential or US oil rig count missing, corrupt or stale',
    ],
    series: [
      { key: 'us_crude_production', label: 'US crude production (weekly)', unit: 'K bbl/d', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WCRFPUS2.W' },
      { key: 'us_crude_exports', label: 'US crude exports (monthly)', unit: 'K bbl/d', manual: false, cadence: 'monthly', source: 'EIA', eiaId: 'PET.MCREXUS2.M' },
      { key: 'us_crude_exports_wk', label: 'US crude exports (weekly)', unit: 'K bbl/d', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WCREXUS2.W' },
      { key: 'us_oil_rig_count', label: 'US oil rig count (Baker Hughes)', unit: 'rigs', manual: true, cadence: 'weekly' },
      { key: 'brazil_exports', label: 'Brazil crude exports', unit: 'M bbl/d', manual: true, cadence: 'quarterly' },
      { key: 'guyana_production', label: 'Guyana production', unit: 'K bbl/d', manual: true, cadence: 'quarterly' },
      { key: 'west_africa_diff', label: 'West African differentials', unit: '$/bbl', manual: true, cadence: 'weekly' },
    ],
  },
  {
    id: 'n7',
    name: 'Insurance & Risk Premium',
    category: 'permission',
    summary: 'War-risk insurance multiple, VLCC premium, P&I club posture',
    keyMetric: 'War-risk insurance multiple',
    phase: 3,
    manualSources: [
      'AUTOMATED: straits.live → insurance multiple (vs peacetime), VLCC premium, P&I clubs withdrawn (weekly)',
      'MANUAL: War-risk premium band — detail behind automated multiple (weekly, from Lloyd\'s List / TradeWinds)',
      'STANDING: JWC listed areas — Persian Gulf + Gulf of Oman + Red Sea/Bab el-Mandeb (since Feb 2026). Update only on JWC bulletin.',
      'FORMAT: warrisk_band accepts a range such as "3-8" or a single number, entered through the dashboard form. Do not edit this series directly in Redis.',
    ],
    thresholdInfo: [
      'RED: Insurance multiple ≥20× peacetime, or ≥4 P&I clubs withdrawn',
      'AMBER: Insurance multiple ≥10×, or ≥2 clubs withdrawn',
      'Fallback: manual war-risk band upper >5% = red, >3% = amber',
      'NOTE: Scoring driven by automated straits.live feeds. Manual band provides context.',
      'NOTE: The band is parsed as a range and scored on its upper edge. A dollar figure written into this field is now rejected rather than compared against the percentage threshold.',
      'UNKNOWN: Insurance multiple or P&I clubs withdrawn missing, corrupt or stale',
    ],
    series: [
      { key: 'insurance_multiple', label: 'Insurance multiple (vs peacetime)', unit: 'x', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'vlcc_premium_high', label: 'VLCC premium (high)', unit: '$', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'clubs_withdrawn', label: 'P&I clubs withdrawn', unit: 'count', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'warrisk_band', label: 'War-risk premium band', unit: '% hull', manual: true, cadence: 'weekly' },
      { key: 'jwc_areas', label: 'JWC listed areas', unit: 'text', manual: true, cadence: 'as_changed' },
    ],
  },
  {
    id: 'n8',
    name: 'Sanctions Architecture',
    category: 'permission',
    summary: 'OFAC vessel risk, carrier posture, price cap, shadow fleet designations',
    keyMetric: 'Carriers rerouting + OFAC vessel matches',
    phase: 2,
    manualSources: [
      'AUTOMATED: straits.live → high-risk vessels (OFAC SDN matches), major carriers rerouting (daily/weekly)',
      'STANDING: G7 price cap — $60/bbl for Russian oil (unchanged). No Iran-specific cap exists. Update only on EU Council / OFAC action.',
      'MANUAL: UK/EU/US sanction lists → shadow fleet designations cumulative (monthly, from KSE)',
      'STANDING: OFAC waivers — event log. Latest: GL 50C (Aug 27, Venezuela); GL BB wind-down to Sept 8 (Iran). Update on Treasury announcement.',
      'MANUAL: KSE / CREA reports → G7-linked carriage share (monthly PDF)',
    ],
    thresholdInfo: [
      'RED: ≥7 major carriers rerouting',
      'RED: >80 high-risk vessels (OFAC SDN matches)',
      'RED: G7 carriage share >35% or <21% (decisive break from the 23–33% band)',
      'AMBER: ≥4 carriers rerouting, or >40 high-risk vessels',
      'AMBER: G7 carriage share outside the 23–33% band',
      'SYMMETRY: The tripwire is the share breaking out of its band in EITHER direction. The former rules only scored the upside.',
      'UNKNOWN: Carriers rerouting or high-risk vessel count missing, corrupt or stale',
    ],
    series: [
      { key: 'vessels_high_risk', label: 'High-risk vessels (OFAC match)', unit: 'count', manual: false, cadence: 'daily', source: 'straits.live' },
      { key: 'carriers_rerouting', label: 'Major carriers rerouting', unit: 'count', manual: false, cadence: 'weekly', source: 'straits.live' },
      { key: 'price_cap', label: 'G7 price cap level', unit: '$/bbl', manual: true, cadence: 'as_changed' },
      { key: 'shadow_designations', label: 'Shadow fleet designations', unit: 'cumulative', manual: true, cadence: 'monthly' },
      { key: 'ofac_waivers', label: 'OFAC waivers issued', unit: 'text', manual: true, cadence: 'as_changed' },
      { key: 'g7_carriage_share', label: 'G7-linked carriage share', unit: '%', manual: true, cadence: 'monthly' },
    ],
  },
];

// FRED series needed for crack spread calculations (not stored directly as node series)
const FRED_INPUTS = {
  gasoline_spot: { fredId: 'DGASNYH', label: 'Gasoline spot (NY Harbor)', unit: '$/gal', fallback: null },
  ulsd_spot: { fredId: 'DDFUELNYH', label: 'ULSD spot (NY Harbor)', unit: '$/gal', fallback: 'DHOILNYH' },
};

// Stale thresholds (days) — how old data can be before flagging.
// Staleness now gates scoring, not just display: a series older than its
// threshold is excluded from scoring and degrades its node to UNKNOWN if it
// is one of that node's critical inputs.
const STALE_THRESHOLDS = {
  daily: 5,
  portwatch: 10,   // PortWatch updates Tuesdays, ~7 day processing lag
  weekly: 14,
  monthly: 45,
  quarterly: 120,
  assessment: 21,
  as_changed: 60,
};

module.exports = { NODES, FRED_INPUTS, STALE_THRESHOLDS };
