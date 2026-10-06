#!/usr/bin/env node
/**
 * Spot-check: deixto.gr vs fuelgr.gr/web for same lat/lng/fuel.
 * Usage: node scripts/compare-deixto-fuelgr.js
 */
'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN = 0.4;
const MAX = 5.0;

function parseXml(xml) {
  if (!xml || !xml.includes('<gs id=')) return [];
  const out = [];
  for (const m of xml.matchAll(/<gs id="([^"]+)"([^>]*)>([\s\S]*?)<\/gs>/g)) {
    const id = m[1];
    const body = m[3];
    const fuels = {};
    for (const ft of body.matchAll(/<ft\s([^>]+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ft>/g)) {
      const ftId = (ft[1].match(/\bid="(\d+)"/) || [])[1];
      const pr = parseFloat(((ft[1].match(/\bpr="([^"]+)"/) || [])[1] || '').replace(',', '.'));
      const name = (ft[2] || '').trim();
      if (ftId && pr >= MIN && pr <= MAX) fuels[ftId] = { price: Number(pr.toFixed(3)), name };
    }
    out.push({ id, fuels });
  }
  return out;
}

function fetchDeixto(lat, lng, f) {
  const dev = 'android.4.0-' + crypto.randomBytes(8).toString('hex');
  const url =
    `https://deixto.gr/fuel/get_data_v4.php?dev=${dev}&lat=${lat}&long=${lng}&f=${f}&b=0&d=30&p=3`;
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'Dalvik/2.1.0' }, timeout: 15000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, xml: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', (e) => resolve({ status: 0, err: e.message, xml: '' }));
  });
}

function fetchFuelgr(lat, lng, f) {
  const ls = JSON.stringify({
    accept_cookies: 'true',
    eh: 'false',
    b: JSON.stringify(['7','1','16','6','10','20','13','12','8','15','11','5','22','2','17','14','18','9','3','4','19','23','21']),
    f: String(f),
    p: '3',
    consumption: '7',
    refuel: '30',
    q_litres: '40',
    zoom: 'false',
    download: 'true',
    logged_in: 'false',
    d_lat: String(lat),
    d_lng: String(lng),
    deviceId: 'web.' + crypto.randomUUID(),
    mobile_user: 'false',
    sort: '0'
  });
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="ls"\r\n\r\n${ls}\r\n--${boundary}--\r\n`;
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'fuelgr.gr',
        path: '/web/api/data.php',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
          Referer: 'https://fuelgr.gr/web/'
        },
        timeout: 15000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let xml = '';
          try {
            const n = raw.length;
            const f3 = Math.floor(n / 3);
            xml = Buffer.from(raw.slice(n - f3) + raw.slice(n - 2 * f3, n - f3) + raw.slice(0, n - 2 * f3), 'base64').toString('utf8');
          } catch {}
          resolve({ status: res.statusCode, html: raw.startsWith('<!'), xml });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, err: e.message, xml: '' }));
    req.write(body);
    req.end();
  });
}

function compareLists(a, b, fuelKey) {
  const mapA = new Map(a.map((s) => [s.id, s]));
  const mapB = new Map(b.map((s) => [s.id, s]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  let samePrice = 0;
  let diffPrice = 0;
  let onlyA = 0;
  let onlyB = 0;
  const diffs = [];
  for (const id of ids) {
    const sa = mapA.get(id);
    const sb = mapB.get(id);
    if (!sa) {
      onlyB++;
      continue;
    }
    if (!sb) {
      onlyA++;
      continue;
    }
    const pa = sa.fuels[fuelKey]?.price;
    const pb = sb.fuels[fuelKey]?.price;
    if (pa == null || pb == null) continue;
    if (Math.abs(pa - pb) < 0.0005) samePrice++;
    else {
      diffPrice++;
      if (diffs.length < 8) diffs.push({ id, deixto: pa, fuelgr: pb });
    }
  }
  return { samePrice, diffPrice, onlyA, onlyB, diffs, countA: a.length, countB: b.length };
}

const PROBES = [
  { name: 'Athens Syntagma', lat: 37.9838, lng: 23.7275, fuels: ['1', '4'] },
  { name: 'Thessaloniki', lat: 40.6401, lng: 22.9444, fuels: ['1'] },
  { name: 'Patras', lat: 38.2466, lng: 21.7346, fuels: ['1'] },
  { name: 'Heraklion', lat: 35.3387, lng: 25.1442, fuels: ['1'] }
];

async function main() {
  console.log('=== deixto.gr vs fuelgr.gr correlation probe ===\n');
  let fuelgrBlocked = 0;

  for (const probe of PROBES) {
    console.log(`--- ${probe.name} (${probe.lat}, ${probe.lng}) ---`);
    for (const f of probe.fuels) {
      const [d, w] = await Promise.all([
        fetchDeixto(probe.lat, probe.lng, f),
        fetchFuelgr(probe.lat, probe.lng, f)
      ]);
      const deixto = parseXml(d.xml);
      const fuelgr = w.html || !w.xml.includes('<gs') ? [] : parseXml(w.xml);
      if (fuelgr.length === 0 && (w.html || w.status === 403)) fuelgrBlocked++;

      const c = compareLists(deixto, fuelgr, f);
      console.log(
        `  fuel=${f}: deixto HTTP ${d.status} n=${c.countA} | fuelgr HTTP ${w.status} n=${c.countB}` +
          (fuelgr.length === 0 && w.html ? ' (HTML block)' : '')
      );
      console.log(
        `    overlap: same price=${c.samePrice} diff=${c.diffPrice} only-deixto=${c.onlyA} only-fuelgr=${c.onlyB}`
      );
      if (c.diffs.length) {
        for (const x of c.diffs) console.log(`    price diff id=${x.id} deixto=${x.deixto} fuelgr=${x.fuelgr}`);
      }
    }
  }

  const dataPath = path.join(__dirname, '..', 'data', 'stations_latest.min.json');
  if (fs.existsSync(dataPath)) {
    const local = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    console.log(`\n=== Local scraper output ===`);
    console.log(`  stations: ${local.length}`);
    const u95 = local.filter((s) => s.fuels && s.fuels['1']).length;
    const d = local.filter((s) => s.fuels && (s.fuels['4'] || s.fuels.dp)).length;
    console.log(`  u95: ${u95} diesel: ${d}`);
  } else {
    console.log('\n(no local data/stations_latest.min.json — run scraper first)');
  }

  try {
    const release = await new Promise((resolve, reject) => {
      https.get(
        'https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json',
        { headers: { 'User-Agent': 'fuelgr-compare/1' }, timeout: 60000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
              reject(e);
            }
          });
        }
      ).on('error', reject);
    });
    console.log(`\n=== Latest GitHub release (packaged) ===`);
    console.log(`  stations: ${release.length}`);
    const withP = release.filter((s) => s.p && s.p.u95).length;
    console.log(`  with u95 in p: ${withP}`);
  } catch (e) {
    console.log('\n(could not fetch latest release:', e.message, ')');
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
