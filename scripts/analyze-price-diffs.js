#!/usr/bin/env node
'use strict';
const fs = require('fs');

const local = JSON.parse(fs.readFileSync('data/stations_latest.min.json', 'utf8'));
const rel = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const relMap = new Map(rel.map((s) => [String(s.id), s]));

const u95deltas = [];
const bigDiffs = [];

for (const s of local) {
  const r = relMap.get(String(s.id));
  if (!r?.p?.u95) continue;
  const a = s.fuels?.['1']?.price;
  if (a == null) continue;
  const b = r.p.u95;
  const d = Math.abs(a - b);
  u95deltas.push(d);
  if (d >= 0.05) bigDiffs.push({ id: s.id, a, b, d, n: s.name, dt: s.last_updated, rdt: r.dt });
}

u95deltas.sort((x, y) => x - y);
const pct = (p) => u95deltas[Math.floor((p / 100) * (u95deltas.length - 1))];

console.log('Shared u95 pairs:', u95deltas.length);
console.log('u95 |delta| median:', pct(50).toFixed(3), 'p90:', pct(90).toFixed(3), 'p99:', pct(99).toFixed(3));
console.log('within 0.01:', u95deltas.filter((d) => d <= 0.01).length);
console.log('within 0.03:', u95deltas.filter((d) => d <= 0.03).length);
console.log('>= 0.05:', u95deltas.filter((d) => d >= 0.05).length);
console.log('>= 0.20:', u95deltas.filter((d) => d >= 0.2).length);
if (bigDiffs.length) {
  console.log('\nLarge u95 diffs (>=0.05):');
  for (const x of bigDiffs.slice(0, 15)) {
    console.log(`  ${x.id} local=${x.a} release=${x.b} d=${x.d.toFixed(3)} localDt=${x.dt} relDt=${x.rdt}`);
  }
}
