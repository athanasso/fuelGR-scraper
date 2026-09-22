/**
 * merge_reviews.js
 * Merges shard artifacts (reviews_shard_*.json) and existing reviews into data/reviews.min.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'data', 'reviews.min.json');

async function main() {
  const merged = {};

  // 1. Existing local reviews.min.json if present
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      Object.assign(merged, existing);
      console.log(`Loaded ${Object.keys(merged).length} baseline reviews from local file.`);
    } catch {}
  } else {
    // Or fetch from latest release CDN
    try {
      const res = await fetch('https://github.com/athanasso/fuelGR-scraper/releases/latest/download/reviews.min.json');
      if (res.ok) {
        const remote = await res.json();
        Object.assign(merged, remote);
        console.log(`Bootstrapped ${Object.keys(remote).length} reviews from latest release.`);
      }
    } catch (e) {
      console.log(`Starting fresh merge (${e.message}).`);
    }
  }

  // 2. Discover all shard files in shards/ or data/
  function findJsonFiles(dir) {
    let files = [];
    if (!fs.existsSync(dir)) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        files = files.concat(findJsonFiles(full));
      } else if (ent.name.includes('reviews_shard') && ent.name.endsWith('.json')) {
        files.push(full);
      }
    }
    return files;
  }

  const searchDirs = [
    path.join(__dirname, 'shards'),
    path.join(__dirname, 'data')
  ];

  let shardCount = 0;
  let newEntries = 0;

  for (const dir of searchDirs) {
    const shardFiles = findJsonFiles(dir);
    for (const file of shardFiles) {
      shardCount++;
      try {
        const shardData = JSON.parse(fs.readFileSync(file, 'utf8'));
        const keys = Object.keys(shardData);
        for (const k of keys) {
          const incoming = shardData[k];
          if (!incoming || typeof incoming.rating !== 'number' || !(Number(incoming.reviews) > 0)) {
            continue; // never merge star-with-zero-reviews
          }
          if (!merged[k] || (incoming.ts && (!merged[k].ts || incoming.ts > merged[k].ts))) {
            merged[k] = incoming;
            newEntries++;
          }
        }
        console.log(`Merged shard: ${file} (${keys.length} entries).`);
      } catch (err) {
        console.warn(`Could not read shard ${file}: ${err.message}`);
      }
    }
  }

  // Drop any lingering zero-review / invalid rows from baseline
  let purged = 0;
  for (const [k, v] of Object.entries(merged)) {
    if (!v || typeof v.rating !== 'number' || !(Number(v.reviews) > 0)) {
      delete merged[k];
      purged++;
    }
  }
  if (purged > 0) console.log(`Purged ${purged} invalid review entries from merge.`);

  // Same Maps cid on 2+ stations = wrong neighbour match — strip links so they re-scrape
  const byCid = {};
  for (const [id, r] of Object.entries(merged)) {
    const mu = String(r.mu || '');
    const pid = String(r.pid || '');
    const m = mu.match(/[?&]cid=(\d+)/) || pid.match(/^cid:(\d+)$/);
    if (!m) continue;
    (byCid[m[1]] = byCid[m[1]] || []).push(id);
  }
  let dupLinks = 0;
  for (const ids of Object.values(byCid)) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      delete merged[id].mu;
      delete merged[id].pid;
      dupLinks++;
    }
  }
  if (dupLinks > 0) {
    console.log(`Cleared Maps links on ${dupLinks} stations sharing a duplicate cid (will re-scrape).`);
  }

  // Known wrong businesses (plumbing shop etc.) — drop entire entry
  const BAD_CIDS = new Set(['13564747657397881582']);
  let badPurged = 0;
  for (const [id, r] of Object.entries(merged)) {
    const mu = String(r.mu || '');
    const pid = String(r.pid || '');
    const m = mu.match(/[?&]cid=(\d+)/) || pid.match(/^cid:(\d+)$/);
    if (m && BAD_CIDS.has(m[1])) {
      delete merged[id];
      badPurged++;
    }
  }
  if (badPurged > 0) console.log(`Purged ${badPurged} poisoned Maps cid entries.`);

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged), 'utf8');
  console.log(`\nSuccessfully merged ${shardCount} shards! Total stations with reviews: ${Object.keys(merged).length}.`);
}

main().catch(err => {
  console.error('Fatal merge error:', err);
  process.exit(1);
});
