#!/usr/bin/env node

// Backfill script — run once with API keys to seed Redis with historical data
// Usage: EIA_API_KEY=xxx FRED_API_KEY=xxx UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/backfill.js

// Load .env if present
try { require('dotenv').config(); } catch {}

const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const EIA_KEY = process.env.EIA_API_KEY;
const FRED_KEY = process.env.FRED_API_KEY;
const START = '2019-01-01';

// EIA weekly series to backfill
const EIA_WEEKLY = [
  { key: 'spr_level', node: 'n4', seriesId: 'PET.WCSSTUS1.W' },
  { key: 'cushing', node: 'n4', seriesId: 'PET.W_EPC0_SAX_YCUOK_MBBL.W' },
  { key: 'commercial_crude', node: 'n4', seriesId: 'PET.WCESTUS1.W' },
  { key: 'gasoline_stocks', node: 'n4', seriesId: 'PET.WGTSTUS1.W' },
  { key: 'distillate_stocks', node: 'n4', seriesId: 'PET.WDISTUS1.W' },
  { key: 'refinery_utilisation', node: 'n4', seriesId: 'PET.WPULEUS3.W' },
];

const EIA_MONTHLY = [
  { key: 'us_crude_exports', node: 'n6', seriesId: 'PET.MCREXUS2.M' },
];

// FRED daily series
const FRED_DAILY = [
  { key: 'wti', node: 'n5', seriesId: 'DCOILWTICO' },
  { key: 'brent', node: 'n5', seriesId: 'DCOILBRENTEU' },
  { key: 'yield_10y', node: 'n5', seriesId: 'DGS10' },
  { key: 'yield_30y', node: 'n5', seriesId: 'DGS30' },
];

// FRED series for crack spread calculation
const FRED_CRACK = [
  { key: 'gasoline_spot', seriesId: 'DGASNYH' },
  { key: 'ulsd_spot', seriesId: 'DDFUELNYH', fallback: 'DHOILNYH' },
];

async function fetchEIAFull(seriesId) {
  const url = `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${EIA_KEY}&start=${START}&sort[0][column]=period&sort[0][direction]=asc&length=5000`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EIA ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data?.response?.data) {
    return data.response.data.map(d => ({
      value: parseFloat(d.value),
      date: d.period,
      source: 'EIA',
    }));
  }
  return [];
}

async function fetchFREDFull(seriesId) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&observation_start=${START}&sort_order=asc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${res.status}`);
  const data = await res.json();
  if (data?.observations) {
    return data.observations
      .filter(o => o.value !== '.')
      .map(o => ({
        value: parseFloat(o.value),
        date: o.date,
        source: 'FRED',
      }));
  }
  return [];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Oil Supply Chain Monitor — Backfill ===\n');

  if (!EIA_KEY) { console.error('ERROR: EIA_API_KEY not set'); process.exit(1); }
  if (!FRED_KEY) { console.error('ERROR: FRED_API_KEY not set'); process.exit(1); }
  if (!process.env.UPSTASH_REDIS_REST_URL) { console.error('ERROR: Redis not configured'); process.exit(1); }

  let totalPoints = 0;

  // EIA Weekly
  console.log('--- EIA Weekly Series (N4) ---');
  for (const s of EIA_WEEKLY) {
    try {
      const points = await fetchEIAFull(s.seriesId);
      const redisKey = `series:${s.node}:${s.key}`;
      await redis.set(redisKey, points);
      console.log(`  ${s.key}: ${points.length} points (${points[0]?.date} → ${points[points.length-1]?.date})`);
      totalPoints += points.length;
      await delay(500); // rate limit courtesy
    } catch (err) {
      console.error(`  ${s.key}: FAILED — ${err.message}`);
    }
  }

  // EIA Monthly
  console.log('\n--- EIA Monthly Series (N6) ---');
  for (const s of EIA_MONTHLY) {
    try {
      const points = await fetchEIAFull(s.seriesId);
      const redisKey = `series:${s.node}:${s.key}`;
      await redis.set(redisKey, points);
      console.log(`  ${s.key}: ${points.length} points (${points[0]?.date} → ${points[points.length-1]?.date})`);
      totalPoints += points.length;
      await delay(500);
    } catch (err) {
      console.error(`  ${s.key}: FAILED — ${err.message}`);
    }
  }

  // FRED Daily
  console.log('\n--- FRED Daily Series (N5) ---');
  for (const s of FRED_DAILY) {
    try {
      const points = await fetchFREDFull(s.seriesId);
      const redisKey = `series:${s.node}:${s.key}`;
      await redis.set(redisKey, points);
      console.log(`  ${s.key}: ${points.length} points (${points[0]?.date} → ${points[points.length-1]?.date})`);
      totalPoints += points.length;
      await delay(500);
    } catch (err) {
      console.error(`  ${s.key}: FAILED — ${err.message}`);
    }
  }

  // Crack spreads
  console.log('\n--- Crack Spread Calculation ---');
  try {
    const wtiHistory = await fetchFREDFull('DCOILWTICO');
    const gasHistory = await fetchFREDFull('DGASNYH');
    let dieselHistory = await fetchFREDFull('DDFUELNYH');

    if (dieselHistory.length === 0) {
      console.log('  DDFUELNYH empty, trying DHOILNYH fallback...');
      dieselHistory = await fetchFREDFull('DHOILNYH');
    }

    // Build WTI lookup by date
    const wtiByDate = {};
    for (const p of wtiHistory) { wtiByDate[p.date] = p.value; }

    // Gasoline crack
    const gasCracks = [];
    for (const p of gasHistory) {
      const wti = wtiByDate[p.date];
      if (wti) {
        gasCracks.push({
          value: Math.round(((p.value * 42) - wti) * 100) / 100,
          date: p.date,
          source: 'calculated',
        });
      }
    }
    await redis.set('series:n5:gasoline_crack', gasCracks);
    console.log(`  gasoline_crack: ${gasCracks.length} points`);

    // Diesel crack
    const dieselCracks = [];
    for (const p of dieselHistory) {
      const wti = wtiByDate[p.date];
      if (wti) {
        dieselCracks.push({
          value: Math.round(((p.value * 42) - wti) * 100) / 100,
          date: p.date,
          source: 'calculated',
        });
      }
    }
    await redis.set('series:n5:diesel_crack', dieselCracks);
    console.log(`  diesel_crack: ${dieselCracks.length} points`);

    totalPoints += gasCracks.length + dieselCracks.length;
  } catch (err) {
    console.error(`  Crack spreads: FAILED — ${err.message}`);
  }

  // Manual seed data (if file exists)
  console.log('\n--- Manual Seed Data ---');
  const seedPath = path.join(__dirname, '..', 'data', 'manual-seed.json');
  if (fs.existsSync(seedPath)) {
    try {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      for (const [key, points] of Object.entries(seed)) {
        await redis.set(key, points);
        console.log(`  ${key}: ${points.length} points`);
        totalPoints += points.length;
      }
    } catch (err) {
      console.error(`  Seed load failed: ${err.message}`);
    }
  } else {
    console.log('  No manual-seed.json found — skip');
  }

  // Store node config
  const { NODES } = require('../lib/config');
  await redis.set('meta:config', { nodes: NODES });
  await redis.set('meta:last_cron', new Date().toISOString());

  console.log(`\n=== Done: ${totalPoints} total data points written ===`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
