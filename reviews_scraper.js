/**
 * FuelGR Google Reviews Enrichment Scraper
 *
 * Reads stations_latest.min.json, queries Google Maps for each station's
 *  - Outputs rating + review count + Maps place link (mu / pid) keyed by station id
 *  - Incremental: skips stations already in reviews.min.json (unless stale / missing Maps link)
 *  - Refresh: re-fetches entries older than --refresh-days (default 14; -1 = all)
 *  - Supports both raw schema (name, brand, address) and compact schema (n, b, a)
 *  - Dual-mode extraction: direct place detail (div.F7nice) + search results feed (div.Nv2PK)
 *  - Isolation: cleans page between queries to prevent SPA state bleed
 *  - Fast path: no about:blank hop; blocks images/media/fonts; consent once
 *  - Dynamic wait: uses selector-based waiting instead of heavy fixed timeouts
 *  - Time budget: stops cleanly before GitHub Actions job timeouts (e.g. 150m)
 *  - Anti-bot safety: human jitter delays, CAPTCHA detection, single browser context
 *
 * Usage:
 *   node reviews_scraper.js [--limit N] [--concurrency N] [--max-time-min N]
 *     [--delay-min N] [--delay-max N] [--refresh-days N] [--input path]
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
const REFRESH_DAYS = parseInt(getArg('--refresh-days', '14'), 10); // -1 = force all, 0 = never
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

function stationShardKey(station) {
  const n = parseInt(String(station.id), 10);
  if (Number.isFinite(n)) return Math.abs(n);
  let h = 0;
  for (const c of String(station.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function prefPriority(station) {
  const PRIORITY_PREFS = [
    'ΑΘΗΝ', 'ΑΤΤΙΚ', 'ΠΕΙΡΑΙ', 'ΘΕΣΣΑΛΟΝΙΚ', 'ΗΡΑΚΛΕΙ', 'ΑΧΑΪ', 'ΛΑΡΙΣ'
  ];
  const pref = (station.prefecture || station.pref || '').toUpperCase();
  const idx = PRIORITY_PREFS.findIndex((p) => pref.includes(p));
  return idx !== -1 ? idx : 999;
}

function isStaleEntry(entry, nowSec) {
  // -1 = force refresh every existing entry
  if (REFRESH_DAYS < 0) return true;
  if (!(REFRESH_DAYS > 0)) return false;
  const ts = Number(entry?.ts) || 0;
  if (!ts) return true; // legacy rows without ts → refresh
  return nowSec - ts >= REFRESH_DAYS * 24 * 3600;
}

function hasValidMapsLink(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const mu = String(entry.mu || '');
  if (/[?&]cid=\d{6,}/.test(mu)) return true;
  if (/query_place_id=ChIJ[a-zA-Z0-9_-]{20,40}/.test(mu)) return true;
  const pid = String(entry.pid || '');
  if (/^cid:\d{6,}$/.test(pid)) return true;
  if (/^ChIJ[a-zA-Z0-9_-]{23,35}$/.test(pid)) return true;
  return false;
}

// ── Google Maps scraping ───────────────────────────────────────────────────────
function normalizeBrand(brand) {
  // "ΑΙΓΑΙΟ (AEGEAN)" -> prefer "AEGEAN" for Maps indexing
  const raw = (brand || '').trim();
  if (!raw) return { primary: '', alts: [] };
  const paren = raw.match(/\(([^)]+)\)/);
  const withoutParen = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const alts = [];
  if (paren) alts.push(paren[1].trim());
  if (withoutParen && withoutParen !== raw) alts.push(withoutParen);
  const primary = paren ? paren[1].trim() : withoutParen || raw;
  return { primary, alts: [...new Set([raw, withoutParen, ...alts].filter(Boolean))] };
}

function extractRatingFromPage() {
  let rating = null;
  let reviews = null;
  let title = '';
  let subtitle = '';
  let category = '';

  const heading = document.querySelector('div[role="main"] h1, h1.DUwDvf, h1');
  if (heading) title = (heading.textContent || '').trim();

  const addrEl = document.querySelector(
    'button[data-item-id="address"], div[data-item-id="address"], [data-item-id^="address"]'
  );
  if (addrEl) subtitle = (addrEl.textContent || '').trim();
  if (!subtitle) {
    const io = document.querySelector('div.Io6YTe');
    if (io) subtitle = (io.textContent || '').trim();
  }

  // Category chip under the title (e.g. «Πρατήριο καυσίμων» / «Κατάστημα υδραυλικών ειδών»)
  const catBtn = document.querySelector(
    'div[role="main"] button[jsaction*="category"], div[role="main"] button.DkEaL'
  );
  if (catBtn) category = (catBtn.textContent || '').trim();

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
      const m =
        (firstC.textContent || firstC.getAttribute('aria-label') || '').match(/\(([0-9.,]+)\)/) ||
        (firstC.textContent || '').match(/([0-9.,]+)/);
      if (m) {
        const count = parseInt(m[1].replace(/[.,]/g, ''), 10);
        if (!isNaN(count)) reviews = count;
      }
    }
  }

  if (rating === null) {
    for (const el of document.querySelectorAll(
      'div[role="main"] [aria-label*="star"], div[role="main"] [aria-label*="αστέρ"]'
    )) {
      const m = (el.getAttribute('aria-label') || '').match(/([1-5][.,][0-9])\s*(?:αστέρ|star)/i);
      if (m) {
        rating = parseFloat(m[1].replace(',', '.'));
        break;
      }
    }
  }

  return { rating, reviews, title, subtitle, category };
}

/** Legal-form / filler tokens that match almost any Greek ΕΕ listing (e.g. «Σια ΕΕ»). */
const NAME_STOPWORDS = new Set([
  'και', 'σια', 'κσι', 'αφοι', 'υιοι', 'υιος', 'οε', 'εε', 'αε', 'αβεε', 'αεε',
  'ικε', 'εταιρεια', 'ετερεια', 'μονοπροσωπη', 'μονοιπροσωπη', 'μονοπρωσοπη',
  'station', 'stations', 'fuels', 'fuel', 'gas', 'oil', 'petrol', 'πρατηριο',
  'καυσιμων', 'καυσιμα', 'βενζιναδικο'
]);

function tokens(s, { keepStopwords = false } = {}) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9\u0370-\u03ff]+/i)
    .filter((t) => t.length > 2 && (keepStopwords || !NAME_STOPWORDS.has(t)));
}

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function coordsFromMapsUrl(url) {
  const m = String(url || '').match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
}

function addressNumber(address) {
  const m = String(address || '').match(/\b(\d{1,4})\b/);
  return m ? m[1] : null;
}

/**
 * Build a stable single-place Maps deep link from the PLACE URL only.
 * Never scan full page HTML — it contains other nearby !1s0x… ids.
 */
function buildMapsDeepLink(pageUrl) {
  const href = String(pageUrl || '');
  if (!href.includes('/maps/place/') && !/[?&]cid=/.test(href) && !/place_id=/i.test(href)) {
    return { pid: null, mu: null };
  }

  // 1) !1s0x…:0x… in the place URL → cid=
  const feat = href.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i);
  if (feat) {
    try {
      const cid = BigInt(feat[2]).toString();
      return { pid: `cid:${cid}`, mu: `https://www.google.com/maps?cid=${cid}` };
    } catch {}
  }

  // 2) place_id / query_place_id in URL
  const qid = href.match(/[?&](?:query_)?place_id=(ChIJ[a-zA-Z0-9_-]{20,40})/i);
  if (qid) {
    return {
      pid: qid[1],
      mu: `https://www.google.com/maps/search/?api=1&query=station&query_place_id=${qid[1]}`
    };
  }

  // 3) cid= already in URL
  const cidParam = href.match(/[?&]cid=(\d{6,})/i);
  if (cidParam) {
    return { pid: `cid:${cidParam[1]}`, mu: `https://www.google.com/maps?cid=${cidParam[1]}` };
  }

  return { pid: null, mu: null };
}

/** Reject shops/pharmacies that share «Σια ΕΕ» / street tokens with fuel stations. */
function looksLikeFuelStation(title, subtitle = '', category = '') {
  const blob = `${title} ${subtitle} ${category}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Hard reject non-fuel categories / titles
  if (
    /υδραυλικ|plumbing|φαρμακ|pharmacy|super\s*market|σουπερ\s*μαρκετ|cafe|καφετερια|εστιατορ|restaurant|ξενοδοχ|hotel|κομμωτ|φροντιστηρ|φουρνο|αρτοποι/i.test(
      blob
    )
  ) {
    return false;
  }
  return true;
}

function titleMatchesStation(title, station, subtitle = '', category = '') {
  const name = station.name || station.n || '';
  const address = station.address || station.a || '';
  const brandRaw = station.brand || station.b || '';
  const { primary: brand } = normalizeBrand(brandRaw);

  if (!looksLikeFuelStation(title, subtitle, category)) return false;

  const nameToks = tokens(name);
  const addrToks = tokens(address);
  const brandToks = tokens(brand);
  const have = new Set(tokens(`${title} ${subtitle}`, { keepStopwords: true }));
  if (nameToks.length === 0 && addrToks.length === 0 && brandToks.length === 0) return false;

  const nameHits = nameToks.filter((t) => have.has(t)).length;
  const addrHits = addrToks.filter((t) => have.has(t)).length;
  const brandHits = brandToks.filter((t) => have.has(t)).length;
  const num = addressNumber(address);
  const numHit = num && `${title} ${subtitle}`.includes(num);

  // Distinctive trade name (stopwords already stripped — «Σια/και/ΕΕ» cannot fake a hit)
  if (nameHits >= 2) return true;
  if (nameHits >= 1 && nameToks.length === 1 && (numHit || brandHits >= 1 || addrHits >= 1)) return true;

  // Brand-only Maps titles (Aegean) need street number or 2+ address tokens
  if (brandHits >= 1 && numHit) return true;
  if (brandHits >= 1 && addrHits >= 2) return true;
  if (brandHits >= 1 && nameHits >= 1 && addrHits >= 1) return true;

  return false;
}

/**
 * Extracts rating and review count from a Google Maps business page.
 * Returns { rating: number|null, reviews: number|null, blocked?: boolean }.
 */
async function fetchGoogleReviews(page, station, state) {
  const brandRaw = (station.brand || station.b || '').trim();
  const name = (station.name || station.n || '').trim();
  const address = (station.address || station.a || '').trim();
  const mun = (station.municipality || station.mun || '').trim();
  const lat = Number(station.lat ?? station.latitude);
  const lng = Number(station.lng ?? station.longitude);
  const { primary: brand, alts: brandAlts } = normalizeBrand(brandRaw);

  const queries = [];
  const pushQ = (parts) => {
    const q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (q && !queries.includes(q)) queries.push(q);
  };

  // Prefer unique business identity over generic brand (avoids wrong nearby AEGEAN/SHELL)
  if (name && address) pushQ([name, address, 'πρατήριο']);
  if (brand && address) pushQ([brand, address, mun, 'πρατήριο καυσίμων']);
  if (name && mun) pushQ([name, mun, 'πρατήριο']);
  if (!isNaN(lat) && !isNaN(lng) && (name || brand)) {
    pushQ([name || brand, address || mun, `${lat},${lng}`]);
  }
  // Brand + street — Maps often titles the pin as "Aegean" not "ARGYOIL EE"
  if (brand && address) pushQ([brand, address]);
  for (const b of brandAlts.slice(0, 2)) {
    if (address) pushQ([b, address, mun || '', 'πρατήριο']);
  }
  if (name) pushQ([name, 'πρατήριο καυσίμων']);

  try {
    let sawWrongPlace = false;
    // Cap at 3 — best queries are first; extras rarely help and burn time/CAPTCHA budget
    for (let qi = 0; qi < Math.min(queries.length, 3); qi++) {
      const url = `https://www.google.com/maps/search/${encodeURIComponent(queries[qi])}`;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      if (page.url().includes('google.com/sorry') || page.url().includes('captcha')) {
        console.warn('\n[!] Google rate-limit or CAPTCHA detected on current runner IP.');
        return { rating: null, reviews: null, blocked: true };
      }

      if (!state.consentDone) {
        try {
          const consentBtn = await page.$(
            'button:has-text("Αποδοχή όλων"), button:has-text("Accept all"), form[action*="consent"] button'
          );
          if (consentBtn) {
            await consentBtn.click();
            await page.waitForTimeout(800);
            state.consentDone = true;
          }
        } catch {}
      }

      await page
        .waitForSelector('div.F7nice, div.Nv2PK, [role="article"]', { timeout: 2800 })
        .catch(() => {});

      if (!page.url().includes('/place/')) {
        // Prefer a result card whose title overlaps name/brand/address — never blind-click #1
        const targetName = [name, brand, address].filter(Boolean).join(' ');
        const streetNum = addressNumber(address);
        const clicked = await page.evaluate(
          ({ wantName, streetNum: num }) => {
            const cards = Array.from(
              document.querySelectorAll('div.Nv2PK a.hfpxzc, [role="feed"] a.hfpxzc')
            );
            const norm = (s) =>
              String(s || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '');
            const want = norm(wantName)
              .split(/[^a-z0-9\u0370-\u03ff]+/i)
              .filter((t) => t.length > 2);
            const score = (label) => {
              const nlabel = norm(label);
              const have = new Set(
                nlabel
                  .split(/[^a-z0-9\u0370-\u03ff]+/i)
                  .filter((t) => t.length > 2)
              );
              let s = want.filter((t) => have.has(t)).length;
              if (num && label.includes(num)) s += 3;
              // Prefer fuel-looking cards over random shops
              if (/πρατηρ|καυσιμ|βενζιν|gas|fuel|petrol|shell|bp|eko|avin|aegean|αιγαιο/i.test(nlabel)) {
                s += 4;
              }
              if (/υδραυλικ|plumbing|φαρμακ|cafe|καφε/i.test(nlabel)) s -= 5;
              return s;
            };
            let best = null;
            let bestScore = 0;
            for (const a of cards) {
              const label = a.getAttribute('aria-label') || a.textContent || '';
              const s = score(label);
              if (s > bestScore) {
                bestScore = s;
                best = a;
              }
            }
            if (best && bestScore > 0) {
              best.click();
              return true;
            }
            return false;
          },
          { wantName: targetName, streetNum }
        );

        if (clicked) {
          await page.waitForSelector('div.F7nice, div[role="main"]', { timeout: 2200 }).catch(() => {});
        }
      }

      const result = await page.evaluate(extractRatingFromPage);
      const matched = titleMatchesStation(
        result.title || '',
        station,
        result.subtitle || '',
        result.category || ''
      );
      // Clear non-fuel place (plumbing etc.) — try next query, flag for purge
      if (
        result.title &&
        result.category &&
        !looksLikeFuelStation(result.title, result.subtitle || '', result.category || '')
      ) {
        sawWrongPlace = true;
        if (qi < 2) await jitter(400, 900);
        continue;
      }
      // Accept only when we have a real review count and the place title looks right
      if (
        result.rating !== null &&
        result.reviews !== null &&
        result.reviews > 0 &&
        matched
      ) {
        // Wait for Maps SPA to settle on the /place/ URL (needed for !1s0x…:0x… / cid)
        try {
          await page
            .waitForFunction(
              () => /\/maps\/place\//.test(location.href) && /!1s0x/i.test(location.href),
              null,
              { timeout: 4000 }
            )
            .catch(() => {});
          await page.waitForTimeout(500);
        } catch {}

        const pageHref = page.url();
        // Reject wrong nearby pin: Maps @lat,lng must be near the fuelgr station
        if (!isNaN(lat) && !isNaN(lng)) {
          const pin = coordsFromMapsUrl(pageHref);
          if (pin) {
            const dist = haversineM(lat, lng, pin.lat, pin.lng);
            if (dist > 175) {
              // Title matched a neighbour — try next query
              if (qi < 2) await jitter(400, 900);
              continue;
            }
          }
        }

        // ONLY parse the place URL — never page HTML (other cids live in the sidebar)
        const link = buildMapsDeepLink(pageHref);
        if (!link.mu && !link.pid) {
          if (qi < 2) await jitter(400, 900);
          continue;
        }
        return { ...result, placeId: link.pid, mapsUrl: link.mu };
      }
      if (qi < 2) await jitter(400, 900);
    }

    return { rating: null, reviews: null, wrongPlace: sawWrongPlace };
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

  // Skip heavy assets — we only need DOM text for rating/count
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort();
    }
    return route.continue();
  });

  const state = { consentDone: false };

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

    const hadPrior = Boolean(results[id]);
    const result = await fetchGoogleReviews(page, station, state);
    if (result.blocked) {
      queue.length = 0; // stop remaining requests gracefully
      break;
    }

    if (result.rating !== null && result.reviews !== null && result.reviews > 0) {
      const prior = results[id] || {};
      const entry = {
        rating: result.rating,
        reviews: result.reviews,
        ts: Math.floor(Date.now() / 1000)
      };
      // Never inherit a prior Maps link — only keep what this pass confirmed
      if (result.placeId) entry.pid = result.placeId;
      if (result.mapsUrl) entry.mu = result.mapsUrl;
      else if (prior.mu && result.placeId === prior.pid) entry.mu = prior.mu;
      results[id] = entry;
      console.log(
        `${hadPrior ? '↻' : ''}★${result.rating} (${result.reviews})` +
          (entry.mu || entry.pid ? ' 🔗' : '')
      );
    } else if (result.wrongPlace && hadPrior) {
      // Matched a plumbing shop / cafe etc. — drop poisoned rating + link
      delete results[id];
      console.log('n/a (purged wrong place)');
    } else {
      // Keep prior rating on failed refresh — don't wipe good data
      console.log(hadPrior ? 'n/a (kept prior)' : 'n/a');
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
  // Drop bogus star-with-zero-reviews entries so they get re-scraped
  let purged = 0;
  for (const [id, r] of Object.entries(results)) {
    if (!r || typeof r.rating !== 'number' || !(Number(r.reviews) > 0)) {
      delete results[id];
      purged++;
    }
  }
  // Known poisoned Maps cids (e.g. plumbing shop matched via «Σια ΕΕ»)
  const BAD_CIDS = new Set(['13564747657397881582']);
  for (const [id, r] of Object.entries(results)) {
    const mu = String(r.mu || '');
    const pid = String(r.pid || '');
    const m = mu.match(/[?&]cid=(\d+)/) || pid.match(/^cid:(\d+)$/);
    if (m && BAD_CIDS.has(m[1])) {
      delete results[id];
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`Purged ${purged} invalid/poisoned review entries.`);
    saveReviews(results);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const missing = [];
  const stale = [];
  for (const s of stations) {
    const id = String(s.id);
    const existing = results[id];
    if (!existing) {
      missing.push(s);
    } else if (isStaleEntry(existing, nowSec) || !hasValidMapsLink(existing)) {
      // Re-fetch stale ratings, and backfill Maps place links when missing/invalid
      stale.push(s);
    }
  }

  // Oldest first among refreshes so long-neglected ratings move first
  stale.sort((a, b) => {
    const ta = Number(results[String(a.id)]?.ts) || 0;
    const tb = Number(results[String(b.id)]?.ts) || 0;
    return ta - tb;
  });

  missing.sort((a, b) => prefPriority(a) - prefPriority(b));

  console.log(
    `${Object.keys(results).length} stations have reviews` +
      (REFRESH_DAYS < 0
        ? ' (FORCE refresh all)'
        : REFRESH_DAYS > 0
          ? ` (refresh if older than ${REFRESH_DAYS}d)`
          : ' (refresh disabled)') +
      `. Missing: ${missing.length}, stale: ${stale.length}.`
  );

  // Fill gaps first, then refresh outdated ratings
  let queue = [...missing, ...stale];

  // Stable id-based sharding so the same station always lands on the same runner
  if (TOTAL_SHARDS > 1) {
    const targetMod = SHARD >= 1 && SHARD <= TOTAL_SHARDS ? SHARD - 1 : SHARD;
    queue = queue.filter((s) => stationShardKey(s) % TOTAL_SHARDS === targetMod);
    console.log(`[Shard ${SHARD}/${TOTAL_SHARDS}] Assigned ${queue.length} stations.`);
  }

  if (LIMIT > 0 && queue.length > LIMIT) {
    console.log(`Applying limit: ${LIMIT} of ${queue.length} pending stations.`);
    queue = queue.slice(0, LIMIT);
  }

  if (MAX_TIME_MIN > 0) {
    console.log(`Time budget configured: ${MAX_TIME_MIN} minutes.`);
  }

  console.log(`Queuing ${queue.length} stations with concurrency=${CONCURRENCY}, delay=${DELAY_MIN}-${DELAY_MAX}ms.`);
  if (queue.length === 0) {
    console.log('Nothing to fetch — all reviews present and fresh.');
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
