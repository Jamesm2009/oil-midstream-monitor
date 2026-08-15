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

function getN4Status(data) {
  const spr = data.spr_level;
  const cushing = data.cushing;
  const sprHistory = data._history?.spr_level;
  const distillate = data.distillate_stocks;

  // SPR draw rate (K bbl/week average over last 4 weeks)
  const sprDrawRate = sprHistory ? calcDrawRate(sprHistory) : null;
  const sprDrawMb = sprDrawRate ? sprDrawRate / 1000 : null; // convert K bbl to M bbl

  // Cushing is already in M bbl
  const cushingMb = cushing;

  // SPR weeks to DOE contracted floor (~282M bbl = 282000 K bbl)
  const DOE_FLOOR = 282000; // K bbl
  const sprWeeksToFloor = (spr && sprDrawRate && sprDrawRate > 0)
    ? (spr - DOE_FLOOR) / sprDrawRate
    : null;

  if (sprDrawMb && sprDrawMb > 4) return 'red';
  if (cushingMb && cushingMb < 18) return 'red';
  if (sprDrawMb && sprDrawMb > 2.5) return 'amber';
  if (cushingMb && cushingMb < 22) return 'amber';
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
  // West African differential blowout signals backup route saturated
  if (westAfricaDiff && westAfricaDiff > 8) return 'red';
  if (westAfricaDiff && westAfricaDiff > 5) return 'amber';
  return 'green';
}

function getN1Status(data) {
  const bypass = data.bypass_utilisation;
  if (bypass && bypass > 5.0) return 'red';   // >90% of 5.5M ceiling
  if (bypass && bypass > 4.7) return 'amber';
  return 'green';
}

function getN2Status(data) {
  const hormuz = data.hormuz_transits;
  if (hormuz && hormuz < 15) return 'red';
  if (hormuz && hormuz < 30) return 'amber';
  return 'green';
}

function getN3Status(data) {
  const shadowShare = data.shadow_fleet_share;
  if (shadowShare && (shadowShare > 33 || shadowShare < 23)) return 'amber';
  return 'green';
}

function getN7Status(data) {
  const warrisk = data.warrisk_band;
  // warrisk_band may be a string like "3-8" or a number
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
  const g7Share = data.g7_carriage_share;
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
