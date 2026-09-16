/**
 * FuelPrices.gr Station-Level Price Scraper
 * Uses Playwright-Extra + Stealth plugin to bypass anti-bot challenges
 * and intercept raw JSON station & fuel price payloads.
 * Includes resilient fallback for government server outages.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const TARGET_URL = 'https://www.fuelprices.gr/CheckPrices';
const OUTPUT_FILE = path.join(__dirname, 'data', 'stations_latest.min.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Major geographic hubs across Greece for fallback scraping when ministry portal has downtime
const REGIONAL_HUBS = [
  { lat: 37.9838, lng: 23.7275, name: 'Attica / Athens' },
  { lat: 40.6401, lng: 22.9444, name: 'Thessaloniki' },
  { lat: 38.2466, lng: 21.7346, name: 'Patras' },
  { lat: 35.3387, lng: 25.1442, name: 'Heraklion' },
  { lat: 39.6390, lng: 22.4191, name: 'Larissa' },
  { lat: 39.6650, lng: 20.8537, name: 'Ioannina' }
];

function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rawLat = raw.latitude ?? raw.lat ?? raw.y ?? raw.lt ?? raw.LATITUDE ?? raw.LAT;
  const rawLng = raw.longitude ?? raw.lng ?? raw.lon ?? raw.x ?? raw.lg ?? raw.LONGITUDE ?? raw.LNG;
  const lat = parseFloat(String(rawLat || '').replace(',', '.'));
  const lng = parseFloat(String(rawLng || '').replace(',', '.'));

  const isValidCoord = !isNaN(lat) && !isNaN(lng) && lat >= 34.0 && lat <= 42.5 && lng >= 19.0 && lng <= 30.0;

  let rawPrice = raw.price ?? raw.timi ?? raw.val ?? raw.pr ?? raw.PRICE ?? raw.fuel_price;
  let price = null;
  if (rawPrice !== undefined && rawPrice !== null) {
    const cleanPrice = String(rawPrice).replace(' ', '').replace(',', '.').replace(/[^\d.]/g, '');
    const num = parseFloat(cleanPrice);
    if (!isNaN(num) && num > 0) {
      price = Number(num.toFixed(3));
    }
  }

  const id = String(raw.id ?? raw.station_id ?? raw.code ?? raw.prat_id ?? raw.STATION_ID ?? '').trim();
  const name = String(raw.name ?? raw.ow ?? raw.eponymia ?? raw.title ?? raw.owner ?? 'Πρατήριο Καυσίμων').trim();
  const brand = String(raw.brand ?? raw.br ?? raw.etaireia ?? raw.marka ?? 'Ανεξάρτητο').trim();
  const address = String(raw.address ?? raw.ad ?? raw.dieythynsi ?? raw.street ?? raw.mun ?? '').trim();
  const fuelType = String(raw.fuel_type ?? raw.fuel ?? raw.eidos ?? 'Unleaded 95').trim();
  const lastUpdated = String(raw.last_updated ?? raw.updated ?? raw.date ?? raw.dt ?? new Date().toISOString().split('T')[0]).split(' ')[0];

  return {
    id: id || `${lat.toFixed(4)}_${lng.toFixed(4)}`,
    name: name || brand || 'Πρατήριο Καυσίμων',
    brand: brand || 'Ανεξάρτητο',
    address: address || '',
    latitude: isValidCoord ? Number(lat.toFixed(6)) : null,
    longitude: isValidCoord ? Number(lng.toFixed(6)) : null,
    fuel_type: fuelType,
    price: price,
    last_updated: lastUpdated
  };
}

function findStationList(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) {
    const sample = obj.find((x) => x && typeof x === 'object');
    if (sample && (sample.lat || sample.latitude || sample.lt || sample.price || sample.pr || sample.name)) {
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

/**
 * Fetch raw XML feed from mobile mirror when ministry Tomcat returns 500
 */
function fetchHttp(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Dalvik/2.1.0' }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchMirrorFallback() {
  console.log('[*] Activating fallback regional scraping to ensure continuous data feed...');
  const stations = [];

  for (const hub of REGIONAL_HUBS) {
    const url = `https://deixto.gr/fuel/get_data_v4.php?dev=android.4.0-b2da2cf97330ca3b&lat=${hub.lat}&long=${hub.lng}&f=1&b=0&d=30&p=0&dSig=google/coral/coral:14/UQ1A.240205.004/1709778835:userdebug/release-keys&iLoc=unknown&apkSig=UPJ2YQunu9eGXu8a/WOiVNAZlYA=`;
    try {
      const xml = await fetchHttp(url);
      const matches = xml.matchAll(/<gs id="([^"]+)"[^>]*>([\s\S]*?)<\/gs>/g);
      for (const m of matches) {
        const id = m[1];
        const body = m[2];
        const lt = (body.match(/<lt>([^<]+)<\/lt>/) || [])[1];
        const lg = (body.match(/<lg>([^<]+)<\/lg>/) || [])[1];
        const br = (body.match(/<br[^>]*>([^<]+)<\/br>/) || [])[1];
        const ad = (body.match(/<ad>([^<]+)<\/ad>/) || [])[1];
        const ow = (body.match(/<ow>([^<]+)<\/ow>/) || [])[1];
        const pr = (body.match(/pr="([^"]+)"/) || [])[1];
        const dt = (body.match(/dt="([^"]+)"/) || [])[1];

        if (lt && lg) {
          stations.push(
            normalizeStation({
              id,
              lt,
              lg,
              brand: br,
              address: ad,
              owner: ow,
              price: pr,
              date: dt,
              fuel_type: 'Unleaded 95'
            })
          );
        }
      }
    } catch (e) {
      console.warn(`Fallback fetch failed for ${hub.name}:`, e.message);
    }
  }

  return stations;
}

async function scrape() {
  console.log(`[${new Date().toISOString()}] Launching stealth Chromium browser...`);

  let browser;
  let allExtracted = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: 'el-GR',
      timezoneId: 'Europe/Athens',
      geolocation: { latitude: 37.9838, longitude: 23.7275 },
      permissions: ['geolocation'],
      deviceScaleFactor: 1
    });

    const page = await context.newPage();

    // Anti-Bot Masking
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {}, app: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['el-GR', 'el', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      const getParameterProto = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return 'Google Inc. (NVIDIA)';
        if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameterProto.apply(this, [param]);
      };
    });

    const rawPayloads = [];

    page.on('response', async (res) => {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (
        (url.includes('GetStations') || url.includes('GetPrices') || url.includes('CheckPrices') || url.includes('map') || ct.includes('json')) &&
        res.status() === 200
      ) {
        try {
          const text = await res.text();
          if (text.startsWith('{') || text.startsWith('[')) {
            console.log(`[+] Intercepted candidate JSON payload from: ${url}`);
            rawPayloads.push({ url, json: JSON.parse(text) });
          }
        } catch {}
      }
    });

    console.log(`Navigating to ${TARGET_URL}...`);
    const resp = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
      console.warn('Navigation error:', e.message);
      return null;
    });

    if (resp && resp.status() === 500) {
      console.warn('[!] Government Tomcat portal returned HTTP 500 (internal server malfunction).');
    }

    await page.waitForTimeout(3000);

    // If form controls are visible, trigger search
    const searchButton = page.locator('input[type="submit"], button[type="submit"], button:has-text("Αναζήτηση")').first();
    if (await searchButton.isVisible().catch(() => false)) {
      await searchButton.click().catch(() => {});
      await page.waitForTimeout(4000);
    }

    for (const p of rawPayloads) {
      const list = findStationList(p.json);
      if (list.length > 0) {
        allExtracted = allExtracted.concat(list.map(normalizeStation).filter(Boolean));
      }
    }
  } catch (err) {
    console.warn('Playwright run encountered an error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // Fallback: If ministry portal returned 500 and 0 stations were intercepted
  if (allExtracted.length === 0) {
    console.warn('[!] 0 stations intercepted from ministry portal. Activating regional fallback feed...');
    const fallbackStations = await fetchMirrorFallback();
    allExtracted = allExtracted.concat(fallbackStations);
  }

  // Deduplicate
  const uniqueMap = new Map();
  for (const s of allExtracted) {
    if (s && s.latitude && s.longitude) {
      const key = `${s.id}_${s.latitude}_${s.longitude}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, s);
      }
    }
  }

  const finalStations = Array.from(uniqueMap.values());
  console.log(`Total valid, deduplicated stations available: ${finalStations.length}`);

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (finalStations.length > 0) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalStations), 'utf-8');
    console.log(`[✓] Saved ${finalStations.length} stations (${fs.statSync(OUTPUT_FILE).size} bytes) -> ${OUTPUT_FILE}`);
  } else if (fs.existsSync(OUTPUT_FILE)) {
    console.warn('[!] No stations retrieved and previous file exists. Preserving previous cache.');
  }
}

scrape()
  .then(() => {
    console.log('Scraper finished successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
