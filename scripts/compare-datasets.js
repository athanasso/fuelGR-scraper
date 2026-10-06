#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function load(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function priceMap(stations, isPackaged) {
  const m = new Map();
  for (const s of stations) {
    const id = String(s.id);
    if (isPackaged && s.p) {
      m.set(id, {
        u95: s.p.u95,
        d: s.p.d,
        dp: s.p.dp,
        lat: s.lat,
        lng: s.lng,
        n: s.n
      });
    } else if (s.fuels) {
      m.set(id, {
        u95: s.fuels['1']?.price,
        d: s.fuels['4']?.price,
        dp: s.fuels.dp?.price,
        lat: s.lat,
        lng: s.lng,
        n: s.name || s.n
      });
    }
  }
  return m;
}

function compare(labelA, a, labelB, b) {
  const ids = new Set([...a.keys(), ...b.keys()]);
  let onlyA = 0,
    onlyB = 0,
    u95Match = 0,
    u95Diff = 0,
    dMatch = 0,
    dDiff = 0,
    u95Missing = 0;
  const samples = [];
  for (const id of ids) {
    const sa = a.get(id);
    const sb = b.get(id);
    if (!sa) {
      onlyB++;
      continue;
    }
    if (!sb) {
      onlyA++;
      continue;
    }
    if (sa.u95 != null && sb.u95 != null) {
      if (Math.abs(sa.u95 - sb.u95) < 0.001) u95Match++;
      else {
        u95Diff++;
        if (samples.length < 10) samples.push({ id, a: sa.u95, b: sb.u95, n: sa.n || sb.n });
      }
    } else if (sa.u95 != null || sb.u95 != null) u95Missing++;

    const da = sa.d ?? sa.dp;
    const db = sb.d ?? sb.dp;
    if (da != null && db != null) {
      if (Math.abs(da - db) < 0.001) dMatch++;
      else dDiff++;
    }
  }
  console.log(`\n=== ${labelA} vs ${labelB} ===`);
  console.log(`  ids A=${a.size} B=${b.size} shared=${a.size - onlyA}`);
  console.log(`  only in A: ${onlyA}  only in B: ${onlyB}`);
  console.log(`  u95: match=${u95Match} diff=${u95Diff} one-sided=${u95Missing}`);
  console.log(`  diesel(any): match=${dMatch} diff=${dDiff}`);
  if (samples.length) {
    console.log('  u95 price diffs (sample):');
    for (const s of samples) console.log(`    ${s.id} ${s.n?.slice(0, 40)} A=${s.a} B=${s.b}`);
  }
}

const localPath = path.join(__dirname, '..', 'data', 'stations_latest.min.json');
const sep30 = process.argv[2];
const oct1 = process.argv[3];

if (!fs.existsSync(localPath)) {
  console.error('Missing local data/stations_latest.min.json');
  process.exit(1);
}

const local = load(localPath);
const localMap = priceMap(local, false);
console.log('Local deixto scrape:', local.length, 'stations');

if (sep30 && fs.existsSync(sep30)) {
  compare('local-deixto', localMap, 'release-2026-09-30', priceMap(load(sep30), true));
}
if (oct1 && fs.existsSync(oct1)) {
  compare('local-deixto', localMap, 'release-2026-10-01', priceMap(load(oct1), true));
}
