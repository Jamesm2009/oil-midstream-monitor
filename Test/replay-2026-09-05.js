#!/usr/bin/env node
// Replays the exact values from the 2026-09-05 printed report through the new
// scorer, to show what changes and what does not.

const { calculateNodeStatus } = require('../lib/thresholds');

const REPORT = {
  n1: { values: { petroline_pct: 95.0, adcop_pct: 100.0 } },
  n2: { values: { hormuz_portwatch: 6, hormuz_tanker: 2, hormuz_dark_ais: 76, stranded_offshore: 426, bab_portwatch: 29 } },
  n3: { values: { floating_storage_world: 107600, floating_storage_mideast: 27600, shadow_fleet_share: 54.0 } },
  n4: {
    values: { spr_level: 286600, cushing: 22500, commercial_crude: 424500, distillate_stocks: 104200, refinery_utilisation: 98.0 },
    histories: { spr_level: [{ value: 300000 }, { value: 295000 }, { value: 291000 }, { value: 286600 }] },
  },
  n5: { values: { wti: 91.48, brent: 96.02, gasoline_crack: 43.05, diesel_crack: 106.93 } },
  n6: {
    values: {
      us_crude_production: 13900, us_crude_exports: 0, us_crude_exports_wk: 4500,
      us_oil_rig_count: 452, brazil_exports: 8.5, guyana_production: 910,
      west_africa_diff: 94.49,
    },
    stale: { us_oil_rig_count: true },
  },
  n7: { values: { insurance_multiple: 40, vlcc_premium_high: 10000000, clubs_withdrawn: 6, warrisk_band: 10000000 } },
  n8: { values: { vessels_high_risk: 104, carriers_rerouting: 8, g7_carriage_share: 42.0 } },
};

const PRINTED = { n1: 'amber', n2: 'red', n3: 'amber', n4: 'red', n5: 'red', n6: 'green', n7: 'red', n8: 'red' };

let changed = 0;
for (const [id, ctx] of Object.entries(REPORT)) {
  const r = calculateNodeStatus(id, ctx);
  const flag = r.status === PRINTED[id] ? '   ' : ' ! ';
  if (r.status !== PRINTED[id]) changed++;
  console.log(`${flag}${id}  printed=${PRINTED[id].padEnd(7)} now=${r.status}`);
  for (const reason of r.reasons) console.log(`        · ${reason}`);
  for (const rej of r.rejected) {
    console.log(`        ✗ ${rej.key}: ${rej.reason}${rej.detail ? ` (${rej.detail})` : ''}`);
  }
  if (Object.keys(r.detail).length) console.log(`        ${JSON.stringify(r.detail)}`);
  console.log('');
}
console.log(`${changed} of 8 nodes change status.`);
