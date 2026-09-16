/**
 * FuelPrices.gr Station-Level Price Scraper
 * Uses Playwright-Extra + Stealth plugin to bypass anti-bot challenges
 * and intercept raw JSON station & fuel price payloads.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Register stealth plugin
chromium.use(stealth);

const TARGET_URL = 'https://www.fuelprices.gr/CheckPrices';
const OUTPUT_FILE = path.join(__dirname, 'data', 'stations_latest.min.json');

// Realistic desktop user-agent
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Normalizes varied station record representations into strict schema
 */
function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Coordinate parsing (supports latitude/lat/y/LAT/lat_wgs84)
  const rawLat = raw.latitude ?? raw.lat ?? raw.y ?? raw.LATITUDE ?? raw.LAT ?? raw.lat_wgs84;
  const rawLng = raw.longitude ?? raw.lng ?? raw.lon ?? raw.x ?? raw.LONGITUDE ?? raw.LNG ?? raw.lng_wgs84;
  const lat = parseFloat(String(rawLat || '').replace(',', '.'));
  const lng = parseFloat(String(rawLng || '').replace(',', '.'));

  // Coordinate sanity check (Greece bounds: ~34°N-42°N, ~19°E-30°E)
  const isValidCoord = !isNaN(lat) && !isNaN(lng) && lat >= 34.0 && lat <= 42.5 && lng >= 19.0 && lng <= 30.0;

  // Price parsing
  let rawPrice = raw.price ?? raw.timi ?? raw.val ?? raw.PRICE ?? raw.fuel_price ?? raw.fuelPrice;
  let price = null;
  if (rawPrice !== undefined && rawPrice !== null) {
    const cleanPrice = String(rawPrice).replace(' ', '').replace(',', '.').replace(/[^\d.]/g, '');
    const num = parseFloat(cleanPrice);
    if (!isNaN(num) && num > 0) {
      price = Number(num.toFixed(3));
    }
  }

  // Station ID
  const id = String(
    raw.id ?? raw.station_id ?? raw.code ?? raw.prat_id ?? raw.pratirio_id ?? raw.STATION_ID ?? ''
  ).trim();

  // Station Name / Title
  const name = String(
    raw.name ?? raw.eponymia ?? raw.title ?? raw.owner ?? raw.NAME ?? raw.PRATIRIO ?? ''
  ).trim();

  // Brand / Trade Mark
  const brand = String(
    raw.brand ?? raw.etaireia ?? raw.marka ?? raw.company ?? raw.BRAND ?? raw.COMPANY ?? ''
  ).trim();

  // Address
  const address = String(
    raw.address ?? raw.dieythynsi ?? raw.street ?? raw.perioxi ?? raw.ADDRESS ?? ''
  ).trim();

  // Fuel Type
  const fuelType = String(
    raw.fuel_type ?? raw.fuel ?? raw.eidos ?? raw.kausimo ?? raw.FUEL_TYPE ?? 'Unleaded 95'
  ).trim();

  // Timestamp
  const lastUpdated =
    raw.last_updated ??
    raw.updated ??
    raw.date ??
    raw.imerominia ??
    raw.DATE ??
    new Date().toISOString().split('T')[0];

  return {
    id: id || `${lat.toFixed(4)}_${lng.toFixed(4)}`,
    name: name || brand || 'Πρατήριο Καυσίμων',
    brand: brand || 'Ανεξάρτητο',
    address: address || '',
    latitude: isValidCoord ? Number(lat.toFixed(6)) : null,
    longitude: isValidCoord ? Number(lng.toFixed(6)) : null,
    fuel_type: fuelType,
    price: price,
    last_updated: String(lastUpdated)
  };
}

/**
 * Searches a nested response object or array for potential station lists
 */
function findStationList(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) {
    // Check if elements look like station records
    const sample = obj.find((x) => x && typeof x === 'object');
    if (
      sample &&
      (sample.lat || sample.latitude || sample.x || sample.price || sample.timi || sample.prat_id || sample.name)
    ) {
      return obj;
    }
  }

  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (Array.isArray(val) && val.length > 0) {
        const found = findStationList(val);
        if (found.length > 0) return found;
      } else if (typeof val === 'object' && val !== null) {
        const found = findStationList(val);
        if (found.length > 0) return found;
      }
    }
  }

  return [];
}

async function scrape() {
  console.log(`[${new Date().toISOString()}] Launching stealth Chromium browser...`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'el-GR',
    timezoneId: 'Europe/Athens',
    geolocation: { latitude: 37.9838, longitude: 23.7275 }, // Athens coords
    permissions: ['geolocation'],
    deviceScaleFactor: 1,
    hasTouch: false,
    extraHTTPHeaders: {
      'Accept-Language': 'el-GR,el;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    }
  });

  const page = await context.newPage();

  // Advanced Anti-Bot Masking
  await page.addInitScript(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Mock Chrome runtime
    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: {}
    };

    // Greek locale & desktop languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['el-GR', 'el', 'en-US', 'en']
    });

    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    // WebGL Vendor & Renderer spoofing
    const getParameterProto = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      // UNMASKED_VENDOR_WEBGL
      if (parameter === 37445) return 'Google Inc. (NVIDIA)';
      // UNMASKED_RENDERER_WEBGL
      if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameterProto.apply(this, [parameter]);
    };
  });

  const rawPayloads = [];

  // Listen for XHR / Fetch responses carrying station / map payload
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    const isTargetEndpoint =
      url.includes('GetStations') ||
      url.includes('GetPrices') ||
      url.includes('GetGeography') ||
      url.includes('checkprices') ||
      url.includes('search') ||
      url.includes('map') ||
      contentType.includes('application/json');

    if (isTargetEndpoint && response.status() === 200) {
      try {
        const text = await response.text();
        if (text && (text.startsWith('{') || text.startsWith('['))) {
          const json = JSON.parse(text);
          console.log(`[+] Intercepted candidate JSON payload from: ${url} (${text.length} bytes)`);
          rawPayloads.push({ url, json });
        }
      } catch (e) {
        // Ignored if response is not JSON or stream is closed
      }
    }
  });

  try {
    console.log(`Navigating to ${TARGET_URL}...`);
    const resp = await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log(`Page landed: ${page.url()} (Status: ${resp?.status()})`);

    // Check for bot verification challenge
    const botCheck = await page.locator('text=Δεν είμαι ρομπότ, text=reCAPTCHA, text=Cloudflare').first();
    if (await botCheck.isVisible().catch(() => false)) {
      console.warn('Bot detection challenge detected on page. Waiting for stealth bypass...');
      await page.waitForTimeout(5000);
    }

    // Wait for the form/select controls to load
    await page.waitForTimeout(3000);

    // Locate Prefecture (Νομός) dropdown if present
    const nomosSelect = page.locator('select[name*="nomos" i], select[name*="nom" i], select[id*="nom" i], select').first();
    if (await nomosSelect.isVisible().catch(() => false)) {
      console.log('Found prefecture selection dropdown. Selecting option...');
      const options = await nomosSelect.locator('option').all();
      if (options.length > 1) {
        // Pick first non-empty option (or All / Attica)
        const value = await options[1].getAttribute('value');
        if (value) {
          await nomosSelect.selectOption(value);
          console.log(`Selected dropdown value: ${value}`);
        }
      }
      await page.waitForTimeout(1000);
    }

    // Locate and click "Αναζήτηση" / Search button
    const searchButton = page.locator(
      'input[type="submit"], button[type="submit"], button:has-text("Αναζήτηση"), input[value*="Αναζήτηση" i], button:has-text("Search")'
    ).first();

    if (await searchButton.isVisible().catch(() => false)) {
      console.log('Found Search button. Triggering search submission...');
      await searchButton.click();
    } else {
      console.log('Search button not directly matched. Pressing Enter or waiting for auto-fetch...');
      await page.keyboard.press('Enter');
    }

    // Allow network requests to complete
    console.log('Waiting for map data XHR/Fetch payloads...');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);

    // Check if station data was stored in page DOM/window scope
    const windowData = await page.evaluate(() => {
      const candidates = ['stations', 'markers', 'mapData', 'gasStations', 'stationList', 'points'];
      for (const key of candidates) {
        if (window[key] && (Array.isArray(window[key]) || typeof window[key] === 'object')) {
          return { key, data: window[key] };
        }
      }
      return null;
    });

    if (windowData) {
      console.log(`[+] Found station data in window.${windowData.key}`);
      rawPayloads.push({ url: `window.${windowData.key}`, json: windowData.data });
    }

    // Process all captured payloads
    let allExtracted = [];

    for (const payload of rawPayloads) {
      const stationList = findStationList(payload.json);
      if (stationList.length > 0) {
        console.log(`Processing ${stationList.length} raw stations from ${payload.url}`);
        const normalized = stationList.map(normalizeStation).filter((s) => s !== null);
        allExtracted = allExtracted.concat(normalized);
      }
    }

    // Deduplicate by ID or coords
    const uniqueMap = new Map();
    for (const station of allExtracted) {
      const key = `${station.id}_${station.latitude}_${station.longitude}_${station.fuel_type}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, station);
      }
    }

    const finalStations = Array.from(uniqueMap.values());
    console.log(`Total valid, deduplicated stations extracted: ${finalStations.length}`);

    // Ensure target output directory exists
    const dir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write minified JSON
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalStations), 'utf-8');
    console.log(`Saved minified JSON payload (${fs.statSync(OUTPUT_FILE).size} bytes) -> ${OUTPUT_FILE}`);

    // Log a sample entry if data found
    if (finalStations.length > 0) {
      console.log('Sample station:', JSON.stringify(finalStations[0]));
    }
  } catch (err) {
    console.error('Error during scraping execution:', err);
    throw err;
  } finally {
    await browser.close();
    console.log('Browser session closed.');
  }
}

scrape()
  .then(() => {
    console.log('Scraper run finished successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Scraper fatal error:', err);
    process.exit(1);
  });
