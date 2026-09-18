/**
 * FuelGR Google Reviews Enrichment Scraper
 *
 * Reads stations_latest.min.json, queries Google Maps for each station's
 * rating + review count, and outputs reviews.min.json (keyed by station id).
 *
 * Features:
 *  - Incremental: skips stations already in reviews.min.json
 *  - Supports both raw schema (name, brand, address) and compact schema (n, b, a)
 *  - Dual-mode extraction: direct place detail (div.F7nice) + search results feed (div.Nv2PK)
 *  - Isolation: cleans page between queries to prevent SPA state bleed
 *  - Dynamic wait: uses selector-based waiting instead of heavy fixed timeouts
 *  - Time budget: stops cleanly before GitHub Actions job timeouts (e.g. 150m)
 *  - Anti-bot safety: human jitter delays, CAPTCHA detection, single browser context
 *
 * Usage:
 *   node reviews_scraper.js [--limit N] [--concurrency N] [--max-time-min N] [--delay-min N] [--delay-max N] [--input path]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const isCI         = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const LIMIT        = parseInt(getArg('--limit', isCI ? '0' : '0'), 10);
const CONCURRENCY  = parseInt(getArg('--concurrency', '1'), 10);
const DELAY_MIN    = parseInt(getArg('--delay-min', '3000'), 10);
const DELAY_MAX    = parseInt(getArg('--delay-max', '6000'), 10);
const MAX_TIME_MIN = parseInt(getArg('--max-time-min', isCI ? '150' : '0'), 10);
const SHARD        = parseInt(getArg('--shard', '0'), 10);
const TOTAL_SHARDS = parseInt(getArg('--total-shards', '1'), 10);
const INPUT_FILE   = getArg('--input', path.join(__dirname, 'data', 'stations_latest.min.json'));
const defaultOutput = TOTAL_SHARDS > 1
  ? path.join(__dirname, 'data', `reviews_shard_${SHARD}.json`)
  : path.join(__dirname, 'data', 'reviews.min.json');
const OUTPUT_FILE  = getArg('--output', defaultOutput);

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

async function loadExisting() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const local = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      if (local && Object.keys(local).length > 0) return local;
    } catch {}
  }
  try {
    const res = await fetch('https://github.com/athanasso/fuelGR-scraper/releases/latest/download/reviews.min.json', {
      headers: { 'User-Agent': 'fuelGR-scraper/1.0' }
    });
    if (res.ok) {
      const remote = await res.json();
      if (remote && typeof remote === 'object') {
        console.log(`[OK] Bootstrapped ${Object.keys(remote).length} existing reviews from latest release CDN.`);
        return remote;
      }
    }
  } catch (err) {
    console.log(`[i] Starting fresh reviews dataset (${err.message}).`);
  }
  return {};
}

function saveReviews(data) {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data), 'utf8');
}

// ── Google Maps scraping ───────────────────────────────────────────────────────
/**
 * Extracts rating and review count from a Google Maps business page.
 * Returns { rating: number|null, reviews: number|null, blocked?: boolean }.
 */
async function fetchGoogleReviews(page, station) {
  const brand = (station.brand || station.b || '').trim();
  const name = (station.name || station.n || '').trim();
  const address = (station.address || station.a || '').trim();
  const mun = (station.municipality || station.mun || '').trim();

  // Search query prioritized for best Google Maps resolution:
  // e.g. "SHELL ΑΘΗΝΑΣ 43 ΒΟΥΛΙΑΓΜΕΝΗ Greece" or "EKO ΠΑΛΑΙΟΧΩΡΑ ΧΑΝΙΑ Greece"
  const queryParts = [brand, address || name, mun, 'Greece'].filter(Boolean);
  const query = encodeURIComponent(queryParts.join(' '));
  const url = `https://www.google.com/maps/search/${query}`;

  try {
    // Reset state before navigation to prevent Single Page App DOM leaking from previous place
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Check if Google blocked this IP with a CAPTCHA
    if (page.url().includes('google.com/sorry') || page.url().includes('captcha')) {
      console.warn('\n[!] Google rate-limit or CAPTCHA detected on current runner IP.');
      return { rating: null, reviews: null, blocked: true };
    }

    // Bypass Google Consent screen if present
    try {
      const consentBtn = await page.$('button:has-text("Αποδοχή όλων"), button:has-text("Accept all"), form[action*="consent"] button');
      if (consentBtn) {
        await consentBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Dynamic wait for place detail header or search result feed
    await page.waitForSelector('div.F7nice, div.Nv2PK, [role="article"]', { timeout: 3500 }).catch(() => {});

    // If search results list (div.Nv2PK) appeared, click the first place card
    if (!page.url().includes('/place/')) {
      const firstCard = await page.$('div.Nv2PK a.hfpxzc, div.Nv2PK [role="article"], [role="feed"] [role="article"]');
      if (firstCard) {
        await firstCard.click();
        await page.waitForSelector('div.F7nice, div[role="main"]', { timeout: 2500 }).catch(() => {});
      }
    }

    // Extract rating and reviews
    const result = await page.evaluate(() => {
      let rating = null;
      let reviews = null;

      // 1. Direct place header (div.F7nice)
      const f7 = document.querySelector('div.F7nice');
      if (f7) {
        const txt = f7.textContent || '';
        const rMatch = txt.match(/([1-5][.,][0-9])/);
        if (rMatch) rating = parseFloat(rMatch[1].replace(',', '.'));
        const cMatch = txt.match(/\(([0-9.,]+)\)/) || txt.match(/([0-9.,]+)\s*(?:αξιολογ|review|κριτικ)/i);
        if (cMatch) {
          const count = parseInt(cMatch[1].replace(/[.,]/g, ''), 10);
          if (!isNaN(count)) reviews = count;
        }
      }

      // 2. Feed cards if detail panel didn't open
      if (rating === null) {
        const firstR = document.querySelector('span.MW4etd, span.ceNzKf');
        if (firstR) {
          const m = (firstR.textContent || firstR.getAttribute('aria-label') || '').match(/([1-5][.,][0-9])/);
          if (m) rating = parseFloat(m[1].replace(',', '.'));
        }
      }
      if (reviews === null) {
        const firstC = document.querySelector('span.UY7F9');
        if (firstC) {
          const m = (firstC.textContent || firstC.getAttribute('aria-label') || '').match(/\(([0-9.,]+)\)/) || (firstC.textContent || '').match(/([0-9.,]+)/);
          if (m) {
            const count = parseInt(m[1].replace(/[.,]/g, ''), 10);
            if (!isNaN(count)) reviews = count;
          }
        }
      }

      // 3. Fallback to place header text if div.F7nice had different class
      if (rating === null) {
        for (const el of document.querySelectorAll('div[role="main"] [aria-label*="star"], div[role="main"] [aria-label*="αστέρ"]')) {
          const m = (el.getAttribute('aria-label') || '').match(/([1-5][.,][0-9])\s*(?:αστέρ|star)/i);
          if (m) {
            rating = parseFloat(m[1].replace(',', '.'));
            break;
          }
        }
      }

      return { rating, reviews };
    });

    return result;
  } catch (err) {
    return { rating: null, reviews: null };
  }
}

// ── Worker ─────────────────────────────────────────────────────────────────────
async function workerLoop(browser, queue, results, done, startTime, maxDurationMs) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'el-GR',
    timezoneId: 'Europe/Athens',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  while (true) {
    if (queue.length === 0) break;

    // Check time budget before starting next station
    if (maxDurationMs > 0 && Date.now() - startTime >= maxDurationMs) {
      console.log(`\n[i] Time budget reached. Gracefully wrapping up current batch...`);
      queue.length = 0;
      break;
    }

    const station = queue.shift();
    const id = String(station.id);
    const brand = station.brand || station.b || '';
    const name = station.name || station.n || station.address || station.a || '';

    process.stdout.write(`[${done.count + 1}] ${brand ? brand + ' ' : ''}${name} (${id})... `);

    const result = await fetchGoogleReviews(page, station);
    if (result.blocked) {
      queue.length = 0; // stop remaining requests gracefully
      break;
    }

    if (result.rating !== null) {
      results[id] = {
        rating: result.rating,
        reviews: result.reviews || 0,
        ts: Math.floor(Date.now() / 1000)
      };
      console.log(`★${result.rating} (${result.reviews || 0})`);
    } else {
      console.log('n/a');
    }

    done.count++;

    // Save incrementally every 10 stations
    if (done.count % 10 === 0) saveReviews(results);

    await jitter(DELAY_MIN, DELAY_MAX);
  }

  await context.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }
  const stations = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Loaded ${stations.length} stations.`);

  const results = await loadExisting();
  const alreadyDone = Object.keys(results).length;
  console.log(`${alreadyDone} stations already reviewed — skipping.`);

  let queue = stations.filter(s => !results[String(s.id)]);

  // Shard work across parallel matrix runners (supports 1-indexed 1..N or 0-indexed 0..N-1)
  if (TOTAL_SHARDS > 1) {
    const targetMod = (SHARD >= 1 && SHARD <= TOTAL_SHARDS) ? SHARD - 1 : SHARD;
    queue = queue.filter((_, idx) => idx % TOTAL_SHARDS === targetMod);
    console.log(`[Shard ${SHARD}/${TOTAL_SHARDS}] Assigned ${queue.length} stations.`);
  }

  // Prioritize major urban centers: Athens/Attica, Piraeus, Thessaloniki, Patras, Heraklion
  const PRIORITY_PREFS = [
    'ΑΘΗΝ', 'ΑΤΤΙΚ', 'ΠΕΙΡΑΙ', 'ΘΕΣΣΑΛΟΝΙΚ', 'ΗΡΑΚΛΕΙ', 'ΑΧΑΪ', 'ΛΑΡΙΣ'
  ];
  queue.sort((a, b) => {
    const prefA = (a.prefecture || a.pref || '').toUpperCase();
    const prefB = (b.prefecture || b.pref || '').toUpperCase();
    const idxA = PRIORITY_PREFS.findIndex(p => prefA.includes(p));
    const idxB = PRIORITY_PREFS.findIndex(p => prefB.includes(p));
    const scoreA = idxA !== -1 ? idxA : 999;
    const scoreB = idxB !== -1 ? idxB : 999;
    return scoreA - scoreB;
  });

  if (LIMIT > 0 && queue.length > LIMIT) {
    console.log(`Applying limit: ${LIMIT} of ${queue.length} pending stations.`);
    queue = queue.slice(0, LIMIT);
  }

  if (MAX_TIME_MIN > 0) {
    console.log(`Time budget configured: ${MAX_TIME_MIN} minutes.`);
  }

  console.log(`Queuing ${queue.length} stations with concurrency=${CONCURRENCY}, delay=${DELAY_MIN}-${DELAY_MAX}ms.`);
  if (queue.length === 0) {
    console.log('All stations already enriched!');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const done = { count: 0 };
  const startTime = Date.now();
  const maxDurationMs = MAX_TIME_MIN > 0 ? MAX_TIME_MIN * 60 * 1000 : 0;

  // Handle Ctrl+C / SIGINT cleanly
  let exiting = false;
  const onExit = async () => {
    if (exiting) return;
    exiting = true;
    console.log('\n[i] Gracefully saving progress and shutting down...');
    saveReviews(results);
    try { await browser.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  const workers = Array.from({ length: CONCURRENCY }, () =>
    workerLoop(browser, queue, results, done, startTime, maxDurationMs)
  );

  await Promise.all(workers);
  await browser.close();

  saveReviews(results);
  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n[DONE] Enriched ${done.count} stations in ${elapsedMin} min. Total reviews stored: ${Object.keys(results).length}.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
