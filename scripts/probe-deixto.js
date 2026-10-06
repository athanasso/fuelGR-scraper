#!/usr/bin/env node
'use strict';
const https = require('https');
const crypto = require('crypto');

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'Dalvik/2.1.0' }, timeout: 20000 }, (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') })
        );
      })
      .on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

function fuelTypes(body) {
  return [...new Set([...body.matchAll(/<ft[^>]*\bid="(\d+)"/g)].map((m) => m[1]))].sort();
}

function stationCount(body) {
  return (body.match(/<gs id=/g) || []).length;
}

(async () => {
  const dev = 'android.4.0-' + crypto.randomBytes(8).toString('hex');
  const lat = 37.9838;
  const lng = 23.7275;
  console.log('dev', dev);

  console.log('\n=== fuel type param f ===');
  for (const f of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const url = `https://deixto.gr/fuel/get_data_v4.php?dev=${dev}&lat=${lat}&long=${lng}&f=${f}&b=0&d=30&p=3`;
    const { status, body } = await get(url);
    console.log(
      `f=${f} HTTP ${status} stations=${stationCount(body)} fuelTypes=[${fuelTypes(body)}] bytes=${body.length}`
    );
  }

  console.log('\n=== radius d (fuel=1) ===');
  for (const d of [5, 10, 15, 20, 30, 40, 50, 80, 100]) {
    const url = `https://deixto.gr/fuel/get_data_v4.php?dev=${dev}&lat=${lat}&long=${lng}&f=1&b=0&d=${d}&p=3`;
    const { status, body } = await get(url);
    console.log(`d=${d} HTTP ${status} stations=${stationCount(body)}`);
  }

  // Does a single station XML ever contain multiple fuel types when f=1?
  console.log('\n=== sample station fuel mix (f=1 Athens) ===');
  const url = `https://deixto.gr/fuel/get_data_v4.php?dev=${dev}&lat=${lat}&long=${lng}&f=1&b=0&d=30&p=3`;
  const { body } = await get(url);
  const first = body.match(/<gs id="[^"]+"[^>]*>[\s\S]*?<\/gs>/);
  if (first) {
    const types = fuelTypes(first[0]);
    const names = [...first[0].matchAll(/<ft[^>]*\bid="(\d+)"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ft>/g)].map(
      (m) => `${m[1]}:${m[2].trim().slice(0, 40)}`
    );
    console.log('first station fuel types', types);
    console.log('names', names);
  }

  // Rural point that mesh might miss
  console.log('\n=== sparse rural probes (f=1 d=30) ===');
  const rural = [
    [35.2, 26.1, 'east Crete'],
    [39.5, 20.3, 'west Epirus'],
    [41.35, 26.5, 'Evros'],
    [36.85, 27.3, 'Kos'],
    [38.4, 26.1, 'Chios']
  ];
  for (const [la, lo, name] of rural) {
    const u = `https://deixto.gr/fuel/get_data_v4.php?dev=${dev}&lat=${la}&long=${lo}&f=1&b=0&d=30&p=3`;
    const { status, body: b } = await get(u);
    console.log(`${name}: HTTP ${status} stations=${stationCount(b)}`);
  }
})();
