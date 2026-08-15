// Config-driven node definitions
// This is the source of truth for all eight nodes.
// Adding a node here automatically creates a card on the dashboard.

const NODES = [
  {
    id: 'n1',
    name: 'Gulf Production & Bypass',
    category: 'physical',
    summary: 'Bypass pipeline utilisation vs capacity, Fujairah/Yanbu split',
    keyMetric: 'Bypass utilisation as % of capacity',
    phase: 2,
    series: [
      { key: 'bypass_utilisation', label: 'Bypass utilisation', unit: 'M bbl/d', manual: true, cadence: 'monthly' },
      { key: 'gulf_exports', label: 'Gulf crude exports', unit: 'M bbl/d', manual: true, cadence: 'monthly' },
      { key: 'fujairah_yanbu_split', label: 'Fujairah vs Yanbu split', unit: '%', manual: true, cadence: 'assessment' },
    ],
  },
  {
    id: 'n2',
    name: 'Chokepoint Transit',
    category: 'physical',
    summary: 'Hormuz, Bab el-Mandeb, Suez, Panama, Cape routing',
    keyMetric: 'Hormuz daily transits',
    phase: 2,
    series: [
      { key: 'hormuz_outbound', label: 'Hormuz outbound transits', unit: '/day', manual: true, cadence: 'assessment' },
      { key: 'hormuz_inbound', label: 'Hormuz inbound transits', unit: '/day', manual: true, cadence: 'assessment' },
      { key: 'bab_el_mandeb', label: 'Bab el-Mandeb status', unit: 'text', manual: true, cadence: 'weekly' },
      { key: 'suez_transits', label: 'Suez monthly transits', unit: '/month', manual: true, cadence: 'monthly' },
    ],
  },
  {
    id: 'n3',
    name: 'Tanker Availability',
    category: 'physical',
    summary: 'Freight rates, spot-period gap, shadow fleet share',
    keyMetric: 'Spot-period gap',
    phase: 2,
    series: [
      { key: 'vlcc_spot', label: 'VLCC spot rate (TD3C)', unit: '$/day', manual: true, cadence: 'weekly' },
      { key: 'vlcc_period', label: '12-month time charter', unit: '$/day', manual: true, cadence: 'weekly' },
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
    series: [
      { key: 'spr_level', label: 'US SPR level', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WCSSTUS1.W' },
      { key: 'cushing', label: 'Cushing OK crude stocks', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.W_EPC0_SAX_YCUOK_MBBL.W' },
      { key: 'commercial_crude', label: 'US commercial crude stocks', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WCESTUS1.W' },
      { key: 'gasoline_stocks', label: 'US gasoline inventories', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WGTSTUS1.W' },
      { key: 'distillate_stocks', label: 'US distillate inventories', unit: 'K bbl', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WDISTUS1.W' },
      { key: 'refinery_utilisation', label: 'Refinery utilisation', unit: '%', manual: false, cadence: 'weekly', source: 'EIA', eiaId: 'PET.WPULEUS3.W' },
      { key: 'chinese_spr', label: 'Chinese strategic reserves', unit: 'M bbl', manual: true, cadence: 'quarterly' },
      { key: 'fujairah_stocks', label: 'Fujairah commercial stocks', unit: 'M bbl', manual: true, cadence: 'weekly' },
    ],
  },
  {
    id: 'n5',
    name: 'Refining & Products',
    category: 'physical',
    summary: 'WTI-Brent spread, crack spreads, product tightness',
    keyMetric: 'Diesel crack spread',
    phase: 1,
    series: [
      { key: 'wti', label: 'WTI spot price', unit: '$/bbl', manual: false, cadence: 'daily', source: 'FRED', fredId: 'DCOILWTICO' },
      { key: 'brent', label: 'Brent spot price', unit: '$/bbl', manual: false, cadence: 'daily', source: 'FRED', fredId: 'DCOILBRENTEU' },
      { key: 'gasoline_crack', label: 'Gasoline crack spread', unit: '$/bbl', manual: false, cadence: 'daily', source: 'calculated' },
      { key: 'diesel_crack', label: 'Diesel crack spread', unit: '$/bbl', manual: false, cadence: 'daily', source: 'calculated' },
      { key: 'yield_10y', label: '10Y Treasury yield', unit: '%', manual: false, cadence: 'daily', source: 'FRED', fredId: 'DGS10' },
      { key: 'yield_30y', label: '30Y Treasury yield', unit: '%', manual: false, cadence: 'daily', source: 'FRED', fredId: 'DGS30' },
      { key: 'singapore_margin', label: 'Singapore refining margin', unit: '$/bbl', manual: true, cadence: 'weekly' },
    ],
  },
  {
    id: 'n6',
    name: 'Alternative Supply Routes',
    category: 'physical',
    summary: 'US crude exports, Atlantic basin substitution',
    keyMetric: 'US crude exports',
    phase: 1,
    series: [
      { key: 'us_crude_exports', label: 'US crude exports', unit: 'K bbl/d', manual: false, cadence: 'monthly', source: 'EIA', eiaId: 'PET.MCREXUS2.M' },
      { key: 'brazil_exports', label: 'Brazil crude exports', unit: 'M bbl/d', manual: true, cadence: 'quarterly' },
      { key: 'guyana_production', label: 'Guyana production', unit: 'K bbl/d', manual: true, cadence: 'quarterly' },
      { key: 'west_africa_diff', label: 'West African differentials', unit: '$/bbl', manual: true, cadence: 'weekly' },
    ],
  },
  {
    id: 'n7',
    name: 'Insurance & Risk Premium',
    category: 'permission',
    summary: 'War-risk premium, JWC listed areas, reinsurer status',
    keyMetric: 'War-risk premium as % of hull value',
    phase: 3,
    series: [
      { key: 'warrisk_band', label: 'War-risk premium band', unit: '% hull', manual: true, cadence: 'weekly' },
      { key: 'jwc_areas', label: 'JWC listed areas', unit: 'text', manual: true, cadence: 'as_changed' },
      { key: 'dfc_status', label: 'DFC reinsurer status', unit: 'text', manual: true, cadence: 'as_changed' },
      { key: 'india_pool', label: 'India sovereign pool status', unit: 'text', manual: true, cadence: 'as_changed' },
    ],
  },
  {
    id: 'n8',
    name: 'Sanctions Architecture',
    category: 'permission',
    summary: 'Price cap, shadow fleet designations, OFAC waivers',
    keyMetric: 'OFAC waiver cadence',
    phase: 2,
    series: [
      { key: 'price_cap', label: 'G7 price cap level', unit: '$/bbl', manual: true, cadence: 'as_changed' },
      { key: 'shadow_designations', label: 'Shadow fleet designations', unit: 'cumulative', manual: true, cadence: 'monthly' },
      { key: 'ofac_waivers', label: 'OFAC waivers issued', unit: 'count', manual: true, cadence: 'monthly' },
      { key: 'g7_carriage_share', label: 'G7-linked carriage share', unit: '%', manual: true, cadence: 'monthly' },
    ],
  },
];

// FRED series needed for crack spread calculations (not stored directly as node series)
const FRED_INPUTS = {
  gasoline_spot: { fredId: 'DGASNYH', label: 'Gasoline spot (NY Harbor)', unit: '$/gal', fallback: null },
  ulsd_spot: { fredId: 'DDFUELNYH', label: 'ULSD spot (NY Harbor)', unit: '$/gal', fallback: 'DHOILNYH' },
};

// Stale thresholds (days) — how old data can be before flagging
const STALE_THRESHOLDS = {
  daily: 5,
  weekly: 14,
  monthly: 45,
  quarterly: 120,
  assessment: 21,
  as_changed: 60,
};

module.exports = { NODES, FRED_INPUTS, STALE_THRESHOLDS };
