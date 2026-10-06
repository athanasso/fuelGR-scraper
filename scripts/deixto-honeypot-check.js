#!/usr/bin/env node
'use strict';
const https = require('https');
const crypto = require('crypto');

function fetch(lat, lng, dev) {
  const url =
    `https://deixto.gr/fuel/get_data_v4.php?dev=${encodeURIComponent(dev)}&lat=${lat}&long=${lng}&f=1&b=0&d=30&p=3`;
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'Dalvik/2.1.0' }, timeout: 15000 }, (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      })
      .on('error', () => resolve(''));
  });
}

function summary(xml) {
  const ids = [...xml.matchAll(/<gs id="([^"]+)"/g)].map((m) => m[1]);
  const prices = [...xml.matchAll(/<ft[^>]*\bid="1"[^>]*\bpr="([^"]+)"/g)].map((m) =>
    parseFloat(m[1].replace(',', '.'))
  );
  return { count: ids.length, ids: ids.sort().join(','), prices: prices.slice(0, 5) };
}

(async () => {
  const lat = 37.9838;
  const lng = 23.7275;
  const dev1 = 'android.4.0-' + crypto.randomBytes(8).toString('hex');
  const dev2 = 'android.4.0-' + crypto.randomBytes(8).toString('hex');
  const fake = 'not-a-real-client-id';
  const [x1, x2, x3] = await Promise.all([fetch(lat, lng, dev1), fetch(lat, lng, dev2), fetch(lat, lng, fake)]);
  const s1 = summary(x1);
  const s2 = summary(x2);
  const s3 = summary(x3);
  console.log('dev1:', s1);
  console.log('dev2:', s2);
  console.log('fake:', s3);
  console.log('dev1 ids == dev2:', s1.ids === s2.ids);
})();
