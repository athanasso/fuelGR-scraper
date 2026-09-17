/**
 * FuelGR Nationwide Station Price Scraper
 *
 * Uses the public web API (fuelgr.gr/web/api/data.php) with a mocked
 * localStorage payload — the same path the browser client uses.
 * Avoids deixto.gr/fuel/get_data_v4.php, which serves honeypot data
 * to unrecognized Android clients.
 *
 * Outputs: data/stations_latest.min.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const OUTPUT_FILE = path.join(__dirname, 'data', 'stations_latest.min.json');

const AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  timeout: 15000
});

const API_HOST = 'fuelgr.gr';
const API_PATH = '/web/api/data.php';

/** Brand IDs from fuelgr.gr/web company checkboxes (all selected). */
const ALL_BRAND_IDS = [
  '7', '1', '16', '6', '10', '20', '13', '12', '8', '15', '11', '5', '22',
  '2', '17', '14', '18', '9', '3', '4', '19', '23', '21'
];

/** Sane EUR/L bounds for liquid fuels (filters obvious garbage rows). */
const MIN_PRICE = 0.4;
const MAX_PRICE = 5.0;

/**
 * Fuel type IDs to request per grid point.
 * Web API returns ONLY the selected fuel type (`f`) per call, so we must
 * scan each type separately and merge by station id. Matches app keys:
 * 1=u95, 2=u100, 4=d, 5=dh, 6=lpg
 */
const SCAN_FUEL_TYPES = [1, 2, 4, 5, 6];

function uuid() {
  return crypto.randomUUID();
}

/**
 * Build the `ls` payload: JSON.stringify(localStorage) as the web app does.
 * Keys documented on fuelgr.gr/web privacy / cookie management UI.
 */
function buildLocalStoragePayload(lat, lng, fuelType) {
  return JSON.stringify({
    accept_cookies: 'true',
    eh: 'false',
    b: JSON.stringify(ALL_BRAND_IDS),
    f: String(fuelType),
    p: '3',
    consumption: '7',
    refuel: '30',
    q_litres: '40',
    zoom: 'false',
    download: 'true',
    logged_in: 'false',
    d_lat: String(lat),
    d_lng: String(lng),
    deviceId: 'web.' + uuid(),
    mobile_user: 'false',
    sort: '0'
  });
}

/**
 * Web API returns body as base64 with thirds rotated:
 *   [part1][part2][part3] -> decode(part3 + part2 + part1)
 * Matches browser: decodeURIComponent(escape(atob(reassembled)))
 */
function unscrambleResponse(raw) {
  if (!raw || raw.length < 4) return '';
  const len = raw.length;
  const third = Math.floor(len / 3);
  const part1 = raw.substring(0, len - third * 2);
  const part2 = raw.substring(len - third * 2, len - third);
  const part3 = raw.substring(len - third);
  const reassembled = part3 + part2 + part1;
  try {
    return Buffer.from(reassembled, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Generate nationwide coordinate scan grid covering Greece:
 * - Base grid across Greek landmass & islands
 * - Dense urban sampling for high-density metropolitan areas
 */
function generateScanGrid() {
  const points = new Map();

  /** Register lat/lng for every fuel type the app can display. */
  const addPoint = (lat, lng, fuelTypes = SCAN_FUEL_TYPES) => {
    const types = Array.isArray(fuelTypes) ? fuelTypes : [fuelTypes];
    for (const fuelType of types) {
      const key = `${lat.toFixed(3)}_${lng.toFixed(3)}_${fuelType}`;
      if (!points.has(key)) {
        points.set(key, {
          lat: Number(lat.toFixed(4)),
          lng: Number(lng.toFixed(4)),
          fuelType
        });
      }
    }
  };

  // 1. Nationwide base grid (lat 34.8 to 41.8, lng 19.5 to 28.3)
  for (let lat = 34.8; lat <= 41.8; lat += 0.22) {
    for (let lng = 19.5; lng <= 28.3; lng += 0.25) {
      if (
        (lat >= 35.0 && lat <= 35.6 && lng >= 23.5 && lng <= 26.3) ||
        (lat >= 35.8 && lat <= 36.6 && lng >= 27.5 && lng <= 28.3) ||
        (lat >= 36.5 && lat <= 37.8 && lng >= 24.5 && lng <= 26.5) ||
        (lat >= 36.4 && lat <= 38.5 && lng >= 21.0 && lng <= 23.5) ||
        (lat >= 37.5 && lat <= 39.0 && lng >= 23.0 && lng <= 24.5) ||
        (lat >= 38.0 && lat <= 40.0 && lng >= 20.5 && lng <= 22.5) ||
        (lat >= 37.5 && lat <= 40.0 && lng >= 25.5 && lng <= 27.0) ||
        (lat >= 39.5 && lat <= 41.8 && lng >= 20.5 && lng <= 26.8) ||
        (lat >= 37.6 && lat <= 40.0 && lng >= 19.8 && lng <= 21.0)
      ) {
        addPoint(lat, lng);
      }
    }
  }

  // 2. High-density urban clusters
  for (let lat = 37.8; lat <= 38.25; lat += 0.04) {
    for (let lng = 23.5; lng <= 24.05; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  for (let lat = 40.5; lat <= 40.75; lat += 0.04) {
    for (let lng = 22.8; lng <= 23.15; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  for (let lat = 38.18; lat <= 38.3; lat += 0.04) {
    for (let lng = 21.68; lng <= 21.8; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  for (let lat = 39.3; lat <= 39.68; lat += 0.06) {
    for (let lng = 22.35; lng <= 23.0; lng += 0.06) {
      addPoint(lat, lng);
    }
  }

  for (let lat = 35.26; lat <= 35.36; lat += 0.04) {
    for (let lng = 25.08; lng <= 25.18; lng += 0.04) {
      addPoint(lat, lng);
    }
  }
  for (let lat = 35.48; lat <= 35.54; lat += 0.04) {
    for (let lng = 23.98; lng <= 24.06; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  for (let lat = 36.38; lat <= 36.46; lat += 0.04) {
    for (let lng = 28.18; lng <= 28.24; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  // 3. Regional capitals (same multi-fuel scan as the base grid)
  const REGIONAL_CENTERS = [
    [37.9838, 23.7275], [40.6401, 22.9444], [38.2466, 21.7346], [35.3387, 25.1442],
    [39.6390, 22.4191], [39.3622, 22.9422], [39.6650, 20.8537], [37.0389, 22.1142],
    [35.5138, 24.0180], [39.5557, 21.7679], [38.6253, 21.4093], [38.4633, 23.5976],
    [41.0849, 23.5476], [40.9396, 24.4129], [39.3649, 21.9214], [36.4349, 28.2175],
    [40.2709, 22.5061], [38.9000, 22.4333], [40.5244, 22.2033], [40.3006, 21.7889],
    [40.4077, 21.6789], [37.9405, 22.9322], [40.8457, 25.8740], [41.1350, 24.8878],
    [41.1192, 25.4054], [41.1500, 24.1500], [37.5683, 22.8067], [37.6333, 22.7333],
    [37.6744, 21.4397], [37.5089, 22.3794], [39.6243, 19.9217], [35.3644, 24.4719],
    [37.0733, 22.4297], [38.2617, 22.0850], [39.1100, 26.5547], [38.3678, 26.1358],
    [37.7878, 20.8978], [38.1750, 20.4889], [38.8333, 20.7000], [35.1914, 25.7153],
    [35.0117, 25.7422], [39.5000, 20.2667], [38.9500, 20.7500], [39.1600, 20.9850],
    [40.7820, 21.4098], [40.5217, 21.2633], [40.0847, 21.4278], [40.9933, 22.8744],
    [40.8017, 22.0478], [40.7936, 22.4339], [38.4333, 22.8750], [38.3197, 23.3178],
    [38.3742, 21.4300], [38.5300, 22.3800], [38.9167, 21.7833], [37.7500, 26.9833],
    [36.8933, 27.2889], [37.4417, 24.9417], [36.3932, 25.4615], [37.4467, 25.3289],
    [37.1036, 25.3764], [37.0850, 25.1489], [39.9167, 25.2500], [35.8500, 27.1333]
  ];

  for (const [cLat, cLng] of REGIONAL_CENTERS) {
    addPoint(cLat, cLng);
  }

  return Array.from(points.values());
}

/**
 * POST to web API with mocked localStorage payload.
 */
function fetchCoordinates(lat, lng, fuelType = 1) {
  return new Promise((resolve) => {
    const body = 'ls=' + encodeURIComponent(buildLocalStoragePayload(lat, lng, fuelType));
    const req = https.request(
      {
        hostname: API_HOST,
        path: API_PATH,
        method: 'POST',
        agent: AGENT,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          Origin: 'https://fuelgr.gr',
          Referer: 'https://fuelgr.gr/web/'
        },
        timeout: 12000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(unscrambleResponse(raw));
        });
        res.on('error', () => resolve(''));
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
    req.write(body);
    req.end();
  });
}

/**
 * Parse stations from unscramled XML response.
 */
function parseXmlStations(xml) {
  if (!xml || !xml.includes('<gs id=')) return [];

  const stations = [];
  const matches = xml.matchAll(/<gs id="([^"]+)"([^>]*)>([\s\S]*?)<\/gs>/g);

  for (const m of matches) {
    const id = m[1];
    const attrs = m[2];
    const body = m[3];

    const cnt = (attrs.match(/cnt="([^"]*)"/) || [])[1] || '';
    const mun = (attrs.match(/mun="([^"]*)"/) || [])[1] || '';
    const dd = (attrs.match(/dd="([^"]*)"/) || [])[1] || '';

    const lt = (body.match(/<lt>([^<]+)<\/lt>/) || [])[1];
    const lg = (body.match(/<lg>([^<]+)<\/lg>/) || [])[1];
    const br = (body.match(/<br[^>]*>([^<]+)<\/br>/) || [])[1] || 'Ανεξάρτητο';
    const ad = (body.match(/<ad>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ad>/) || [])[1] || '';
    const ow = (body.match(/<ow>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ow>/) || [])[1] || '';

    const fuels = {};
    const ftMatches = body.matchAll(/<ft\s([^>]+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ft>/g);
    let primaryPrice = null;
    let primaryFuel = 'Unleaded 95';
    let latestDate = '';

    for (const ft of ftMatches) {
      const ftAttrs = ft[1];
      const ftId = (ftAttrs.match(/\bid="(\d+)"/) || [])[1];
      const rawPrStr = (ftAttrs.match(/\bpr="([^"]+)"/) || [])[1];
      const ftDt = ((ftAttrs.match(/\bdt="([^"]*)"/) || [])[1] || '').split(' ')[0];
      const ftName = (ft[2] || '').trim();
      const rawPr = parseFloat((rawPrStr || '').replace(',', '.'));

      if (ftId && !isNaN(rawPr) && rawPr >= MIN_PRICE && rawPr <= MAX_PRICE) {
        const pr = Number(rawPr.toFixed(3));
        fuels[ftId] = { name: ftName, price: pr, date: ftDt };

        if (!latestDate || ftDt > latestDate) latestDate = ftDt;

        if (ftId === '1' || ftName.includes('95')) {
          primaryPrice = pr;
          primaryFuel = 'Unleaded 95';
        } else if (!primaryPrice) {
          primaryPrice = pr;
          primaryFuel = ftName;
        }
      }
    }

    const latNum = parseFloat(lt);
    const lngNum = parseFloat(lg);
    const isValidCoord =
      !isNaN(latNum) &&
      !isNaN(lngNum) &&
      latNum >= 34.0 &&
      latNum <= 42.5 &&
      lngNum >= 19.0 &&
      lngNum <= 30.0;

    if (id && isValidCoord && Object.keys(fuels).length > 0) {
      stations.push({
        id: String(id),
        name: ow.trim() || br.trim() || 'Πρατήριο Καυσίμων',
        brand: br.trim() || 'Ανεξάρτητο',
        address: ad.trim(),
        prefecture: cnt.trim(),
        municipality: mun.trim(),
        district: dd.trim(),
        latitude: Number(latNum.toFixed(6)),
        longitude: Number(lngNum.toFixed(6)),
        fuel_type: primaryFuel,
        price: primaryPrice,
        fuels,
        last_updated: latestDate || new Date().toISOString().split('T')[0]
      });
    }
  }

  return stations;
}

function mergeStation(existing, incoming) {
  const merged = { ...existing, fuels: { ...existing.fuels } };
  for (const [fid, fobj] of Object.entries(incoming.fuels || {})) {
    if (!merged.fuels[fid] || (fobj.date && fobj.date >= (merged.fuels[fid].date || ''))) {
      merged.fuels[fid] = fobj;
    }
  }
  if (incoming.price != null && (merged.price == null || incoming.fuels['1'])) {
    if (incoming.fuels['1']) {
      merged.price = incoming.fuels['1'].price;
      merged.fuel_type = 'Unleaded 95';
    } else if (merged.price == null) {
      merged.price = incoming.price;
      merged.fuel_type = incoming.fuel_type;
    }
  }
  if (incoming.last_updated && incoming.last_updated > (merged.last_updated || '')) {
    merged.last_updated = incoming.last_updated;
  }
  // Prefer non-empty address / brand from whichever has them
  if (!merged.address && incoming.address) merged.address = incoming.address;
  if (incoming.brand && incoming.brand !== 'Ανεξάρτητο') merged.brand = incoming.brand;
  if (incoming.name && incoming.name !== 'Πρατήριο Καυσίμων') merged.name = incoming.name;
  return merged;
}

/**
 * Worker pool to process grid points concurrently.
 */
async function processGridConcurrently(grid, concurrency = 12) {
  const uniqueStations = new Map();
  let completed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < grid.length) {
      const idx = cursor++;
      const point = grid[idx];
      try {
        const xml = await fetchCoordinates(point.lat, point.lng, point.fuelType);
        const list = parseXmlStations(xml);
        for (const s of list) {
          if (!uniqueStations.has(s.id)) {
            uniqueStations.set(s.id, s);
          } else {
            uniqueStations.set(s.id, mergeStation(uniqueStations.get(s.id), s));
          }
        }
      } catch {
        // skip failed point
      }
      completed++;
      if (completed % 50 === 0 || completed === grid.length) {
        process.stdout.write(
          `\r[Scan Progress] ${completed}/${grid.length} points (${Math.round(
            (completed / grid.length) * 100
          )}%) -> ${uniqueStations.size} unique stations`
        );
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  console.log('\nScan completed.');

  return Array.from(uniqueStations.values());
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting Greek Nationwide Gas Stations Scraper...`);
  console.log(`API: https://${API_HOST}${API_PATH} (web localStorage payload)`);

  const grid = generateScanGrid();
  console.log(`Generated geospatial scan grid: ${grid.length} coordinates across Greece.`);

  const stations = await processGridConcurrently(grid, 12);
  console.log(`\nExtracted ${stations.length} valid unique gas stations.`);

  // Per-fuel coverage + price sanity (web API is single-fuel per request)
  const FUEL_LABELS = { 1: 'u95', 2: 'u100', 4: 'd', 5: 'dh', 6: 'lpg' };
  for (const fid of Object.keys(FUEL_LABELS)) {
    const prices = stations
      .map((s) => (s.fuels && s.fuels[fid] ? s.fuels[fid].price : null))
      .filter((p) => typeof p === 'number' && p >= MIN_PRICE && p <= MAX_PRICE)
      .sort((a, b) => a - b);
    if (prices.length === 0) {
      console.log(`Fuel ${FUEL_LABELS[fid]} (${fid}): 0 stations with price`);
    } else {
      const median = prices[Math.floor(prices.length / 2)];
      console.log(
        `Fuel ${FUEL_LABELS[fid]} (${fid}): n=${prices.length} min=${prices[0]} median=${median} max=${prices[prices.length - 1]}`
      );
    }
  }

  if (stations.length < 1000) {
    console.error(
      `[!] Error: Expected 4000+ stations, but only found ${stations.length}. Check network / API.`
    );
    process.exit(1);
  }

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(stations), 'utf-8');
  const sizeKb = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
  console.log(`[OK] Saved ${stations.length} stations (${sizeKb} KB) -> ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
