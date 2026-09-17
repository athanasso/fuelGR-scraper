/**
 * FuelGR Google Reviews Enrichment Scraper
 *
 * Reads stations_latest.min.json, queries Google Maps for each station's
 * rating + review count, and outputs reviews.min.json (keyed by station id).
 *
 * Features:
 *  - Incremental: skips stations already in reviews.min.json
 *  - Concurrency: 3 browser contexts in parallel (safe against bot detection)
 *  - Rate-limited: 1.5-3s jitter delay between requests per context
 *  - Graceful: exits cleanly on SIGINT, saves partial progress
 *
 * Usage:
 *   node reviews_scraper.js [--limit N] [--concurrency N] [--input path]
 *
 * Output: data/reviews.min.json
 *   { "<station_id>": { "rating": 4.2, "reviews": 87, "ts": 1234567890 }, ... }
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
const isCI        = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const LIMIT       = parseInt(getArg('--limit', isCI ? '50' : '0'), 10);
const CONCURRENCY = parseInt(getArg('--concurrency', '3'), 10);
const INPUT_FILE  = getArg('--input', path.join(__dirname, 'data', 'stations_latest.min.json'));
const OUTPUT_FILE = path.join(__dirname, 'data', 'reviews.min.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

async function loadExisting() {
  // 1. Local file if already exists
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const local = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      if (local && Object.keys(local).length > 0) return local;
    } catch {}
  }
  // 2. Fetch remote CDN asset from latest release (incremental bootstrap in CI)
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
 * Returns { rating: number|null, reviews: number|null }.
 */
async function fetchGoogleReviews(page, stationName, address) {
  const query = encodeURIComponent(`${stationName} ${address} fuel station Greece`);
  const url = `https://www.google.com/maps/search/${query}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Check if Google blocked this IP with a CAPTCHA / unusual traffic page
    if (page.url().includes('google.com/sorry') || page.url().includes('captcha')) {
      console.warn('\n[!] Google rate-limit or CAPTCHA detected on current runner IP.');
      return { rating: null, reviews: null, blocked: true };
    }

    // Bypass Google Consent screen if present
    try {
      const consentBtn = await page.$('button:has-text("Αποδοχή όλων"), button:has-text("Accept all")');
      if (consentBtn) {
        await consentBtn.click();
        await page.waitForTimeout(2000);
      } else {
        const formBtn = await page.$('form[action*="consent"] button');
        if (formBtn) {
          await formBtn.click();
          await page.waitForTimeout(2000);
        }
      }
    } catch (e) {}

    // If search shows a list, click the first result
    const firstResult = await page.$('[role="article"]');
    if (firstResult) {
      await firstResult.click();
      await page.waitForTimeout(2000);
    }

    // Try multiple selectors for rating (Google changes them frequently)
    const ratingSelectors = [
      'span[aria-label*="stars"]',
      'div[role="img"][aria-label*="stars"]',
      'span.ceNzKf',
      'div.fontDisplayLarge',
      'div.F7nice span[aria-hidden="true"]',
      'span[jstcache] span[aria-label*="star"]'
    ];

    let rating = null;
    let reviews = null;

    for (const sel of ratingSelectors) {
      const el = await page.$(sel);
      if (el) {
        const ariaLabel = await el.getAttribute('aria-label') || '';
        const text = await el.innerText().catch(() => '');
        // "4.2 stars" or just "4.2"
        const rMatch = (ariaLabel + ' ' + text).match(/(\d+\.\d+|\d+)\s*star/i)
          || (ariaLabel + ' ' + text).match(/^(\d+[\.,]\d+)/);
        if (rMatch) {
          rating = parseFloat(rMatch[1].replace(',', '.'));
          break;
        }
      }
    }

    // Review count selectors
    const reviewSelectors = [
      'span[aria-label*="reviews"]',
      'button[jsaction*="reviewChart"]',
      'span.UY7F9',
      'div.F7nice span:last-child',
      'a[data-item-id="reviews"]',
      'span:has-text("κριτικ")',
      'span:has-text("review")'
    ];

    for (const sel of reviewSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.innerText().catch(() => '');
        const ariaLabel = await el.getAttribute('aria-label') || '';
        const rMatch = (text + ' ' + ariaLabel).match(/(\d[\d,\.]*)\s*(review|κριτικ|αξιολογ)/i);
        if (rMatch) {
          reviews = parseInt(rMatch[1].replace(/[,\.]/g, ''), 10);
          break;
        } else {
          // Sometimes it's just in parentheses like "(12)"
          const pMatch = (text + ' ' + ariaLabel).match(/\((\d[\d,\.]*)\)/);
          if (pMatch) {
            reviews = parseInt(pMatch[1].replace(/[,\.]/g, ''), 10);
            break;
          }
        }
      }
    }

    return { rating, reviews };
  } catch (err) {
    return { rating: null, reviews: null };
  }
}

// ── Worker ─────────────────────────────────────────────────────────────────────
async function workerLoop(browser, queue, results, done) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'el-GR',
    timezoneId: 'Europe/Athens',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  while (true) {
    if (queue.length === 0) break;
    const station = queue.shift();
    const { id, name, address } = station;

    process.stdout.write(`[${done.count + 1}] ${name} (${id})... `);

    const result = await fetchGoogleReviews(page, name, address || '');
    if (result.blocked) {
      queue.length = 0; // stop remaining requests gracefully
      break;
    }
    results[id] = { rating: result.rating, reviews: result.reviews, ts: Math.floor(Date.now() / 1000) };
    done.count++;

    const tag = result.rating ? `★${result.rating} (${result.reviews})` : 'n/a';
    console.log(tag);

    // Save incrementally every 10 stations
    if (done.count % 10 === 0) saveReviews(results);

    await jitter(1500, 3000);
  }

  await context.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load stations
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }
  const stations = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Loaded ${stations.length} stations.`);

  // Load existing reviews (incremental)
  const results = await loadExisting();
  const alreadyDone = Object.keys(results).length;
  console.log(`${alreadyDone} stations already reviewed — skipping.`);

  // Build work queue (skip already-scraped)
  let queue = stations.filter(s => !results[s.id]);
  if (LIMIT > 0) queue = queue.slice(0, LIMIT);
  console.log(`Queuing ${queue.length} stations with concurrency=${CONCURRENCY}.\n`);

  if (queue.length === 0) {
    console.log('Nothing to do.');
    saveReviews(results);
    return;
  }

  const done = { count: 0 };
  const total = queue.length;

  // Graceful shutdown on Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\nInterrupted — saving progress...');
    saveReviews(results);
    console.log(`Saved ${Object.keys(results).length} entries to ${OUTPUT_FILE}`);
    process.exit(0);
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });

  // Launch N parallel workers sharing the queue
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
    workerLoop(browser, queue, results, done)
  );

  await Promise.all(workers);
  await browser.close();

  saveReviews(results);
  console.log(`\nDone. ${done.count}/${total} new stations enriched.`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
