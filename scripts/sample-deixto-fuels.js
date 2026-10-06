#!/usr/bin/env node
'use strict';
const https = require('https');
const crypto = require('crypto');

function get(f) {
  const dev = 'android.4.0-' + crypto.randomBytes(4).toString('hex');
  const u = `https://deixto.gr/fuel/get_data_v4.php?dev=${dev}&lat=37.9838&long=23.7275&f=${f}&b=0&d=30&p=3`;
  return new Promise((r) => {
    https
      .get(u, { headers: { 'User-Agent': 'Dalvik/2.1.0' } }, (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => r(Buffer.concat(c).toString('utf8')));
      })
      .on('error', () => r(''));
  });
}

(async () => {
  for (const f of [2, 3, 5, 8]) {
    const b = await get(f);
    const n = (b.match(/<gs id=/g) || []).length;
    const names = [
      ...b.matchAll(
        /<ft[^>]*\bid="(\d+)"[^>]*\bpr="([^"]+)"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ft>/g
      )
    ]
      .slice(0, 6)
      .map((m) => `${m[1]}@${m[2]} ${m[3].trim().slice(0, 45)}`);
    console.log(`f=${f} stations=${n}`);
    console.log(names.join('\n') || '(none)');
    console.log('---');
  }
})();
