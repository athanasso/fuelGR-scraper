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
  maxSockets: 8,
  timeout: 20000
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
 * Fuel type IDs the app displays.
 * Web API returns ONLY the selected fuel (`f`) per call.
 * We discover stations with Unleaded 95 nationwide first, then enrich
 * other fuels on a denser subset — otherwise rate-limits kick in after
 * ~100 calls and we only cover ~20 locations (≈150 stations).
 */
const DISCOVERY_FUEL = 1; // Unleaded 95
const ENRICH_FUELS = [2, 4, 5, 6]; // u100, diesel, heating, lpg

/** Rotating web device id — refreshed on empty streaks / periodically. */
let sessionDeviceId = 'web.' + crypto.randomUUID();
let requestsSinceDeviceRotate = 0;
const DEVICE_ROTATE_EVERY = 100;

const FETCH_STATS = {
  ok: 0,
  emptyBody: 0,
  emptyStations: 0,
  badDecode: 0,
  retried: 0,
  deviceRotates: 0
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rotateDeviceId(reason) {
  sessionDeviceId = 'web.' + crypto.randomUUID();
  requestsSinceDeviceRotate = 0;
  FETCH_STATS.deviceRotates++;
  console.warn(`\n[i] Rotated deviceId (${reason}): ${sessionDeviceId}`);
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
    deviceId: sessionDeviceId,
    mobile_user: 'false',
    sort: '0'
  });
}

function looksLikeStationXml(xml) {
  return typeof xml === 'string' && (xml.includes('<gss') || xml.includes('<?xml') || xml.includes('<gs '));
}

/**
 * Wire body is base64(XML) with thirds rotated (C+B+A).
 * Server uses PHP-style str_split(ceil(n/3)) — remainder lands on the last
 * original part(s). Browser JS uses floor(n/3) which only matches when
 * n % 3 !== 2. Try both and keep the decode that yields station XML.
 */
function unscrambleFloor(raw) {
  const n = raw.length;
  const f = Math.floor(n / 3);
  const reassembled = raw.slice(n - f) + raw.slice(n - 2 * f, n - f) + raw.slice(0, n - 2 * f);
  return Buffer.from(reassembled, 'base64').toString('utf8');
}

function unscrambleCeil(raw) {
  const n = raw.length;
  const chunk = Math.ceil(n / 3);
  const cLen = n - 2 * chunk;
  if (cLen < 1) return '';
  const C = raw.slice(0, cLen);
  const B = raw.slice(cLen, cLen + chunk);
  const A = raw.slice(cLen + chunk);
  return Buffer.from(A + B + C, 'base64').toString('utf8');
}

function unscrambleResponse(raw) {
  if (!raw || raw.length < 4) return '';
  try {
    const mod = raw.length % 3;
    // Prefer the split that matches this length class, then fall back.
    const primary = mod === 2 ? unscrambleCeil(raw) : unscrambleFloor(raw);
    if (looksLikeStationXml(primary)) return primary;
    const secondary = mod === 2 ? unscrambleFloor(raw) : unscrambleCeil(raw);
    if (looksLikeStationXml(secondary)) return secondary;
    return '';
  } catch {
    return '';
  }
}

/**
 * Generate scan points.
 * mode:
 *  - 'discovery': every geo cell with Unleaded 95 only (nationwide coverage first)
 *  - 'enrich': other fuels on urban clusters + regional capitals only
 */
function generateScanGrid(mode = 'discovery') {
  const points = new Map();
  const fuelTypes =
    mode === 'enrich' ? ENRICH_FUELS : [DISCOVERY_FUEL];

  const addPoint = (lat, lng, types = fuelTypes) => {
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

  const addLandGrid = () => {
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
  };

  const addUrbanClusters = () => {
    for (let lat = 37.8; lat <= 38.25; lat += 0.04) {
      for (let lng = 23.5; lng <= 24.05; lng += 0.04) addPoint(lat, lng);
    }
    for (let lat = 40.5; lat <= 40.75; lat += 0.04) {
      for (let lng = 22.8; lng <= 23.15; lng += 0.04) addPoint(lat, lng);
    }
    for (let lat = 38.18; lat <= 38.3; lat += 0.04) {
      for (let lng = 21.68; lng <= 21.8; lng += 0.04) addPoint(lat, lng);
    }
    for (let lat = 39.3; lat <= 39.68; lat += 0.06) {
      for (let lng = 22.35; lng <= 23.0; lng += 0.06) addPoint(lat, lng);
    }
    for (let lat = 35.26; lat <= 35.36; lat += 0.04) {
      for (let lng = 25.08; lng <= 25.18; lng += 0.04) addPoint(lat, lng);
    }
    for (let lat = 35.48; lat <= 35.54; lat += 0.04) {
      for (let lng = 23.98; lng <= 24.06; lng += 0.04) addPoint(lat, lng);
    }
    for (let lat = 36.38; lat <= 36.46; lat += 0.04) {
      for (let lng = 28.18; lng <= 28.24; lng += 0.04) addPoint(lat, lng);
    }
  };

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

  if (mode === 'discovery') {
    addLandGrid();
    addUrbanClusters();
    for (const [cLat, cLng] of REGIONAL_CENTERS) addPoint(cLat, cLng);
  } else {
    // Enrichment: denser areas only — fewer calls, still covers most multi-fuel stations
    addUrbanClusters();
    for (const [cLat, cLng] of REGIONAL_CENTERS) addPoint(cLat, cLng);
  }

  return Array.from(points.values());
}

/**
 * POST to web API with mocked localStorage payload (multipart FormData like the browser).
 */
function fetchRaw(lat, lng, fuelType = 1) {
  return new Promise((resolve) => {
    const ls = buildLocalStoragePayload(lat, lng, fuelType);
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="ls"\r\n\r\n` +
      `${ls}\r\n` +
      `--${boundary}--\r\n`;

    const req = https.request(
      {
        hostname: API_HOST,
        path: API_PATH,
        method: 'POST',
        agent: AGENT,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Language': 'el-GR,el;q=0.9,en-US;q=0.8,en;q=0.7',
          Origin: 'https://fuelgr.gr',
          Referer: 'https://fuelgr.gr/web/'
        },
        timeout: 15000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            raw: Buffer.concat(chunks).toString('utf8')
          });
        });
        res.on('error', () => resolve({ status: 0, raw: '' }));
      }
    );
    req.on('error', () => resolve({ status: 0, raw: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, raw: '' });
    });
    req.write(body);
    req.end();
  });
}

async function fetchCoordinates(lat, lng, fuelType = 1, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      FETCH_STATS.retried++;
      await sleep(600 * i + Math.floor(Math.random() * 300));
    }

    if (requestsSinceDeviceRotate >= DEVICE_ROTATE_EVERY) {
      rotateDeviceId(`every ${DEVICE_ROTATE_EVERY} requests`);
    }

    const { status, raw } = await fetchRaw(lat, lng, fuelType);
    requestsSinceDeviceRotate++;

    if (!raw || raw.length < 4) {
      FETCH_STATS.emptyBody++;
      continue;
    }
    const xml = unscrambleResponse(raw);
    if (!looksLikeStationXml(xml)) {
      FETCH_STATS.badDecode++;
      if (FETCH_STATS.badDecode <= 3) {
        console.warn(
          `\n[warn] bad decode status=${status} rawLen=${raw.length} mod3=${raw.length % 3} head=${raw.slice(0, 48)}`
        );
      }
      continue;
    }

    // Valid XML with 0 stations = real empty cell (sea / no coverage). Do not retry.
    if (!xml.includes('<gs id=')) {
      FETCH_STATS.emptyStations++;
      return '';
    }

    FETCH_STATS.ok++;
    return xml;
  }
  return '';
}

/** Fail fast if the API is blocked / returning unusable bodies. */
async function preflightProbe() {
  console.log('Preflight probe (Athens Unleaded 95)...');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const xml = await fetchCoordinates(37.9838, 23.7275, 1, 2);
    const n = parseXmlStations(xml).length;
    if (n > 0) {
      console.log(`Preflight OK: ${n} stations near Athens.`);
      return true;
    }
    console.warn(`Preflight attempt ${attempt}/5 failed; backing off...`);
    rotateDeviceId('preflight miss');
    await sleep(2000 * attempt);
  }
  return false;
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
  if (!merged.address && incoming.address) merged.address = incoming.address;
  if (incoming.brand && incoming.brand !== 'Ανεξάρτητο') merged.brand = incoming.brand;
  if (incoming.name && incoming.name !== 'Πρατήριο Καυσίμων') merged.name = incoming.name;
  return merged;
}

/**
 * For stations missing standard fuels, POST at their exact lat/lng.
 * Nearby responses often fill several neighbours, so we skip already-filled.
 */
async function backfillMissingFuels(stationsMap, fuelIds, label = 'Backfill') {
  for (const fuelId of fuelIds) {
    rotateDeviceId(`start ${label} fuel=${fuelId}`);
    const pending = [...stationsMap.values()].filter((s) => !(s.fuels && s.fuels[String(fuelId)]));
    console.log(
      `Phase 3 ${label} fuel=${fuelId}: ${pending.length} stations missing (will skip as neighbours fill).`
    );
    let queried = 0;
    let gained = 0;
    for (let i = 0; i < pending.length; i++) {
      const s = pending[i];
      // Filled by an earlier nearby query
      if (stationsMap.get(s.id)?.fuels?.[String(fuelId)]) continue;

      const lat = Number(s.lat);
      const lng = Number(s.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      queried++;
      try {
        const xml = await fetchCoordinates(lat, lng, fuelId, 2);
        if (xml) {
          for (const hit of parseXmlStations(xml)) {
            if (!stationsMap.has(hit.id)) continue;
            const before = stationsMap.get(hit.id);
            const had = Boolean(before.fuels && before.fuels[String(fuelId)]);
            stationsMap.set(hit.id, mergeStation(before, hit));
            if (!had && stationsMap.get(hit.id).fuels?.[String(fuelId)]) gained++;
          }
        }
      } catch {
        // skip point
      }

      if (queried % 25 === 0 || i + 1 === pending.length) {
        const still = [...stationsMap.values()].filter(
          (x) => !(x.fuels && x.fuels[String(fuelId)])
        ).length;
        process.stdout.write(
          `\r[${label} f=${fuelId}] queried=${queried} gained=+${gained} stillMissing=${still}   `
        );
      }
      await sleep(45 + Math.floor(Math.random() * 40));
    }
    if (pending.length) console.log('');
  }
}

/**
 * Worker pool — backs off and rotates deviceId when the API returns empty envelopes.
 */
async function processGridConcurrently(grid, concurrency = 5, label = 'Scan') {
  const uniqueStations = new Map();
  let completed = 0;
  let cursor = 0;
  let emptyStreak = 0;
  // Serialize rotate+backoff so workers don't stack 2.5–4s sleeps together
  let backoffChain = Promise.resolve();

  function onEmptyResult() {
    emptyStreak++;
    if (emptyStreak % 25 !== 0) return Promise.resolve();
    const streak = emptyStreak;
    const job = backoffChain.then(async () => {
      rotateDeviceId(`empty streak ${streak}`);
      await sleep(2500 + Math.floor(Math.random() * 1500));
    });
    backoffChain = job.catch(() => {});
    return job;
  }

  async function worker() {
    while (cursor < grid.length) {
      const idx = cursor++;
      const point = grid[idx];
      let added = 0;
      try {
        const xml = await fetchCoordinates(point.lat, point.lng, point.fuelType);
        if (xml) {
          const list = parseXmlStations(xml);
          for (const s of list) {
            if (!uniqueStations.has(s.id)) {
              uniqueStations.set(s.id, s);
              added++;
            } else {
              uniqueStations.set(s.id, mergeStation(uniqueStations.get(s.id), s));
            }
          }
        }
      } catch {
        // skip failed point
      }

      if (added === 0) {
        await onEmptyResult();
        // Polite pause after empties (sea cells / throttle)
        await sleep(40 + Math.floor(Math.random() * 60));
      } else {
        emptyStreak = 0;
        // Healthy hit — minimal pause
        await sleep(Math.floor(Math.random() * 35));
      }

      completed++;
      if (completed % 25 === 0 || completed === grid.length) {
        process.stdout.write(
          `\r[${label}] ${completed}/${grid.length} (${Math.round(
            (completed / grid.length) * 100
          )}%) -> ${uniqueStations.size} stations`
        );
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  console.log(`\n[${label}] done.`);
  return uniqueStations;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting Greek Nationwide Gas Stations Scraper...`);
  console.log(`API: https://${API_HOST}${API_PATH} (web localStorage payload)`);
  console.log(`Session deviceId: ${sessionDeviceId}`);

  const probeOk = await preflightProbe();
  if (!probeOk) {
    console.error(
      '[!] Preflight failed: fuelgr.gr/web/api/data.php returned no usable station XML. Likely IP throttle/block.'
    );
    process.exit(1);
  }

  // Phase 1: nationwide Unleaded 95 discovery (maximize geo coverage before rate limits)
  const discoveryGrid = generateScanGrid('discovery');
  console.log(`Phase 1 discovery grid: ${discoveryGrid.length} points (fuel=${DISCOVERY_FUEL}).`);
  const stationsMap = await processGridConcurrently(discoveryGrid, 5, 'Discovery');
  console.log(`Phase 1 extracted ${stationsMap.size} unique stations.`);

  // Phase 2: other fuels on urban/regional points only
  rotateDeviceId('start enrich phase');
  const enrichGrid = generateScanGrid('enrich');
  console.log(`Phase 2 enrich grid: ${enrichGrid.length} points (fuels=${ENRICH_FUELS.join(',')}).`);
  const enrichMap = await processGridConcurrently(enrichGrid, 4, 'Enrich');
  for (const [id, s] of enrichMap) {
    if (!stationsMap.has(id)) stationsMap.set(id, s);
    else stationsMap.set(id, mergeStation(stationsMap.get(id), s));
  }

  // Phase 3: enrich only hits urban/regional grids, so rural stations often miss
  // diesel (and sometimes u95). Re-query exact coords for standard fuels.
  // One nearby hit can fill several neighbours — skip already-filled as we go.
  await backfillMissingFuels(stationsMap, [1, 4], 'Backfill'); // u95 + diesel

  const stations = Array.from(stationsMap.values());
  console.log(`\nExtracted ${stations.length} valid unique gas stations.`);
  console.log(
    `Fetch stats: ok=${FETCH_STATS.ok} emptyBody=${FETCH_STATS.emptyBody} emptyStations=${FETCH_STATS.emptyStations} badDecode=${FETCH_STATS.badDecode} retried=${FETCH_STATS.retried} deviceRotates=${FETCH_STATS.deviceRotates}`
  );

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
