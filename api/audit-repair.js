#!/usr/bin/env node
//
// api/audit-repair.js
//
// Walks every stored series, applies the values.js plausibility gate to every
// point, and reports what is corrupt. With --apply it moves bad points to a
// quarantine key and rewrites the series without them.
//
// It does NOT invent replacements. A series emptied by quarantine will score
// 'unknown' under the new thresholds, which is the correct state: we know the
// number is wrong and we do not yet know the right one.
//
// Usage:
//   node scripts/audit-repair.js                 # dry run, prints a report
//   node scripts/audit-repair.js --apply         # quarantine + rewrite
//   node scripts/audit-repair.js --key series:n6:west_africa_diff --apply
//
// Known targets as of the 2026-09-05 report:
//   series:n6:west_africa_diff   94.49    outright price in a differential field
//   series:n7:warrisk_band       10000000 VLCC dollar premium in a % field
//   series:n6:brazil_exports     8.5      ~4x implausible as M bbl/d
//   series:n6:us_crude_exports   0        EIA artifact or bad manual write

try { require('dotenv').config(); } catch {}

const { Redis } = require('@upstash/redis');
const { readValue, SERIES_BOUNDS } = require('../lib/values');
const { NODES } = require('../lib/config');

const APPLY = process.argv.includes('--apply');
const KEY_ARG = (() => {
  const i = process.argv.indexOf('--key');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function allSeriesKeys() {
  const keys = [];
  for (const node of NODES) {
    for (const s of node.series) {
      keys.push({ redisKey: `series:${node.id}:${s.key}`, seriesKey: s.key, node: node.id, unit: s.unit });
    }
  }
  return keys;
}

async function auditSeries(entry) {
  let history;
  try {
    history = await redis.get(entry.redisKey);
  } catch (err) {
    return { ...entry, error: `redis read failed: ${err.message}` };
  }

  if (!Array.isArray(history)) {
    return { ...entry, error: history === null ? 'no data' : 'stored value is not an array' };
  }

  const good = [];
  const bad = [];

  for (const point of history) {
    if (!point || typeof point !== 'object' || point.value === undefined) {
      bad.push({ point, reason: 'malformed point' });
      continue;
    }
    const res = readValue(entry.seriesKey, point.value);
    if (res.ok) {
      good.push(point);
    } else {
      bad.push({ point, reason: res.reason, detail: res.detail || null });
    }
  }

  return { ...entry, total: history.length, good, bad };
}

async function main() {
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    console.error('ERROR: Redis not configured');
    process.exit(1);
  }

  console.log(`=== Series audit ${APPLY ? '(APPLY — will write)' : '(dry run)'} ===\n`);

  const entries = allSeriesKeys().filter(e => !KEY_ARG || e.redisKey === KEY_ARG);
  if (entries.length === 0) {
    console.error(`No series matched ${KEY_ARG}`);
    process.exit(1);
  }

  let totalBad = 0;
  const emptied = [];

  for (const entry of entries) {
    const r = await auditSeries(entry);

    if (r.error) {
      console.log(`${r.redisKey}\n    SKIP — ${r.error}\n`);
      continue;
    }
    if (r.bad.length === 0) continue;

    totalBad += r.bad.length;
    const bounds = SERIES_BOUNDS[r.seriesKey];
    console.log(`${r.redisKey}  [unit: ${r.unit}${bounds ? `, bounds ${bounds[0]}..${bounds[1]}` : ''}]`);
    console.log(`    ${r.bad.length} of ${r.total} points rejected, ${r.good.length} retained`);
    for (const b of r.bad.slice(0, 5)) {
      const val = b.point && b.point.value !== undefined ? JSON.stringify(b.point.value) : '?';
      const date = b.point && b.point.date ? b.point.date : 'undated';
      console.log(`      ${date}  ${val}  → ${b.reason}${b.detail ? ` (${b.detail})` : ''}`);
    }
    if (r.bad.length > 5) console.log(`      ... and ${r.bad.length - 5} more`);

    if (r.good.length === 0) emptied.push(r.redisKey);

    if (APPLY) {
      const qKey = `quarantine:${r.redisKey}:${new Date().toISOString().split('T')[0]}`;
      await redis.set(qKey, r.bad);
      await redis.set(r.redisKey, r.good);
      console.log(`    APPLIED — quarantined to ${qKey}`);
    }
    console.log('');
  }

  console.log(`=== ${totalBad} bad points across ${entries.length} series ===`);

  if (emptied.length > 0) {
    console.log('\nSeries left with no usable points — these will score UNKNOWN:');
    for (const k of emptied) console.log(`  ${k}`);
    console.log('\nThat is the intended state. Do not backfill these with guesses.');
  }

  if (!APPLY && totalBad > 0) {
    console.log('\nRe-run with --apply to quarantine and rewrite.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
