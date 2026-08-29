// Status calculation per node
// Each function returns 'green', 'amber', or 'red'
// Takes an object of latest values for that node's series

function getLatestValue(history) {
  if (!history || !Array.isArray(history) || history.length === 0) return null;
  return history[history.length - 1];
}

function calcDrawRate(history) {
  if (!history || history.length < 2) return null;
  const recent = history.slice(-4); // last 4 weeks
  if (recent.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < recent.length; i++) {
    deltas.push(recent[i - 1].value - recent[i].value); // positive = draw
  }
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

function calcProductionDelta(history) {
  // Compare latest 4-week average to prior 4-week average
  if (!history || history.length < 8) return null;
  const recent4 = history.slice(-4).map(h => h.value);
  const prior4 = history.slice(-8, -4).map(h => h.value);
  const recentAvg = recent4.reduce((a, b) => a + b, 0) / recent4.length;
  const priorAvg = prior4.reduce((a, b) => a + b, 0) / prior4.length;
  return recentAvg - priorAvg; // negative = declining
}

function getN1Status(data) {
  // Automated straits.live pipeline data
  const petroline = data.petroline_pct;
  const adcop = data.adcop_pct;

  if (petroline && petroline >= 98 && adcop && adcop >= 100) return 'red';
  if (petroline && petroline >= 90) return 'amber';
  return 'green';
}

function getN2Status(data) {
  // Automated sources: PortWatch (direct API) + AIS (straits.live)
  const portwatch = data.hormuz_portwatch;
  const darkAis = data.hormuz_dark_ais;
  const stranded = data.stranded_offshore;
  const babPw = data.bab_portwatch;

  // Hormuz transit count (most authoritative)
  if (portwatch !== null && portwatch !== undefined) {
    if (portwatch <= 15) return 'red';
    if (portwatch <= 30) return 'amber';
  }

  // Compound: Hormuz low AND Bab el-Mandeb low
  if (portwatch && portwatch <= 30 && babPw && babPw < 10) return 'red';

  // Dark fleet signals
  if (darkAis && darkAis > 60) return 'amber';

  // Stranded vessels
  if (stranded && stranded > 500) return 'amber';

  return 'green';
}

function getN3Status(data) {
  const worldStorage = data.floating_storage_world;
  const mideastStorage = data.floating_storage_mideast;
  const shadowShare = data.shadow_fleet_share;

  // Red: crisis-level fleet absorption or severe Gulf congestion
  if (worldStorage && worldStorage > 140000) return 'red';
  if (mideastStorage && mideastStorage > 30000) return 'red';

  // Amber: capacity being absorbed or Gulf congestion building
  if (worldStorage && worldStorage > 120000) return 'amber';
  if (mideastStorage && mideastStorage > 25000) return 'amber';
  if (shadowShare && (shadowShare > 33 || shadowShare < 23)) return 'amber';

  return 'green';
}

function getN4Status(data) {
  const spr = data.spr_level;
  const cushing = data.cushing;
  const sprHistory = data._history?.spr_level;
  const distillate = data.distillate_stocks;

  const sprDrawRate = sprHistory ? calcDrawRate(sprHistory) : null;
  const sprDrawMb = sprDrawRate ? sprDrawRate / 1000 : null;

  // Cushing is in K bbl — 18M bbl = 18000, 22M bbl = 22000
  const cushingKbbl = cushing;

  const DOE_FLOOR = 282000;
  const sprWeeksToFloor = (spr && sprDrawRate && sprDrawRate > 0)
    ? (spr - DOE_FLOOR) / sprDrawRate
    : null;

  if (sprDrawMb && sprDrawMb > 4) return 'red';
  if (cushingKbbl && cushingKbbl < 18000) return 'red';
  if (sprDrawMb && sprDrawMb > 2.5) return 'amber';
  if (cushingKbbl && cushingKbbl < 22000) return 'amber';
  if (sprWeeksToFloor !== null && sprWeeksToFloor < 12) return 'amber';
  return 'green';
}

function getN5Status(data) {
  const dieselCrack = data.diesel_crack;
  const gasolineCrack = data.gasoline_crack;
  const wti = data.wti;
  const brent = data.brent;
  const wtiBrentSpread = (wti && brent) ? Math.abs(wti - brent) : null;

  if (dieselCrack && dieselCrack > 40) return 'red';
  if (dieselCrack && dieselCrack > 30) return 'amber';
  if (gasolineCrack && gasolineCrack > 25) return 'amber';
  if (wtiBrentSpread && wtiBrentSpread > 12) return 'amber';
  return 'green';
}

function getN6Status(data) {
  const westAfricaDiff = data.west_africa_diff;
  const rigCount = data.us_oil_rig_count;
  const productionHistory = data._history?.us_crude_production;
  const productionDelta = productionHistory ? calcProductionDelta(productionHistory) : null;

  // West African differentials — backup route saturation
  if (westAfricaDiff && westAfricaDiff > 8) return 'red';

  // Rig count collapse — production base eroding while exports elevated
  if (rigCount && rigCount < 350) return 'red';

  if (westAfricaDiff && westAfricaDiff > 5) return 'amber';
  if (rigCount && rigCount < 400) return 'amber';

  // Production declining significantly (>200K bbl/d drop in 4-week average)
  if (productionDelta && productionDelta < -200) return 'amber';

  return 'green';
}

function getN7Status(data) {
  // Prefer automated insurance multiple from straits.live
  const multiple = data.insurance_multiple;
  const clubs = data.clubs_withdrawn;
  const warrisk = data.warrisk_band;

  if (multiple && multiple >= 20) return 'red';
  if (multiple && multiple >= 10) return 'amber';
  if (clubs && clubs >= 4) return 'red';
  if (clubs && clubs >= 2) return 'amber';

  // Fallback to manual war-risk band
  if (typeof warrisk === 'string' && warrisk.includes('-')) {
    const upper = parseFloat(warrisk.split('-')[1]);
    if (upper > 5) return 'red';
    if (upper > 3) return 'amber';
  }
  if (typeof warrisk === 'number') {
    if (warrisk > 5) return 'red';
    if (warrisk > 3) return 'amber';
  }
  return 'green';
}

function getN8Status(data) {
  const highRisk = data.vessels_high_risk;
  const rerouting = data.carriers_rerouting;
  const g7Share = data.g7_carriage_share;

  if (rerouting && rerouting >= 7) return 'red';
  if (rerouting && rerouting >= 4) return 'amber';
  if (highRisk && highRisk > 80) return 'red';
  if (highRisk && highRisk > 40) return 'amber';
  if (g7Share && g7Share > 35) return 'red';
  if (g7Share && g7Share > 30) return 'amber';
  return 'green';
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

function calculateNodeStatus(nodeId, data) {
  const fn = STATUS_FUNCTIONS[nodeId];
  if (!fn) return 'green';
  try {
    return fn(data);
  } catch {
    return 'green';
  }
}

module.exports = { calculateNodeStatus };
