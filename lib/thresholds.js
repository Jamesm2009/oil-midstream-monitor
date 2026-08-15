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

function getN1Status(data) {
  // Use automated straits.live pipeline data if available
  const petroline = data.petroline_pct;
  const adcop = data.adcop_pct;
  const bypass = data.bypass_utilisation; // manual fallback

  if (petroline && petroline >= 98 && adcop && adcop >= 100) return 'red';
  if (petroline && petroline >= 90) return 'amber';
  if (bypass && bypass > 5.0) return 'red';
  if (bypass && bypass > 4.7) return 'amber';
  return 'green';
}

function getN2Status(data) {
  // Prefer PortWatch automated data, fall back to Windward manual
  const portwatch = data.hormuz_portwatch;
  const outbound = data.hormuz_outbound;
  const inbound = data.hormuz_inbound;
  const dark = data.hormuz_dark;
  const darkAis = data.hormuz_dark_ais;
  const babOut = data.bab_outbound;
  const babPw = data.bab_portwatch;
  const stranded = data.stranded_offshore;

  // PortWatch transit count (most authoritative)
  if (portwatch !== null && portwatch !== undefined) {
    if (portwatch <= 5) return 'red';
    if (portwatch <= 15) return 'red';
    if (portwatch <= 30) return 'amber';
  }

  // Windward outbound as secondary
  if (outbound && outbound < 15) return 'red';
  if (outbound && outbound < 30 && babOut && babOut < 5) return 'red';
  if (outbound && outbound < 30) return 'amber';
  if (outbound && inbound && inbound < outbound * 0.7) return 'amber';

  // Dark fleet signals
  if (dark && outbound && dark > outbound * 0.3) return 'amber';
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
  if (westAfricaDiff && westAfricaDiff > 8) return 'red';
  if (westAfricaDiff && westAfricaDiff > 5) return 'amber';
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
