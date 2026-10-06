/**
 * FuelGR Nationwide Station Price Scraper (deixto.gr only)
 *
 * API facts (verified):
 * - One fuel type per request (`f`); XML contains only that fuel.
 * - Radius `d` max useful value is 30 km (d>=40 returns empty).
 * - Valid fuels: 1=u95, 2=98/100, 4=diesel, 5=heating, 6=lpg, 8=cng.
 *
 * Strategy for full coverage without fuelgr.gr:
 * 1. Dense ~22 km hex mesh — ALL fuels nationwide (1,2,4,5,6,8).
 * 2. Concurrent mesh workers for speed.
 * 3. Exact-coordinate backfill for u95 + diesel (gate fuels) + plateau abort.
 * 4. Refresh backfill for known LPG/heating/CNG sellers from baseline (not every station).
 * 5. Coverage gates vs previous snapshot — refuse to write a thin dataset.
 *
 * Outputs: data/stations_latest.min.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const OUTPUT_FILE = path.join(__dirname, 'data', 'stations_latest.min.json');
const RELEASE_STATIONS_URL =
  'https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json';

const AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  timeout: 20000
});

const MIN_PRICE = 0.4;
const MAX_PRICE = 5.0;
const RADIUS_KM = 30; // deixto hard-caps; larger d returns empty
const MESH_SPACING_KM = 22;
const MESH_CONCURRENCY = 4;
const MESH_DELAY_MS = [80, 160]; // [min, max] between requests per worker
const BACKFILL_DELAY_MS = [100, 180];
/** Stop backfill after this many consecutive queries with zero gains */
const BACKFILL_PLATEAU = 80;
/** Hard cap for high-octane optional backfill */
const BACKFILL_OPTIONAL_MAX = 400;

/** Every fuel we publish — full nationwide mesh (replaces fuelgr.gr) */
const ALL_FUELS = [1, 4, 2, 6, 5, 8];
const FUEL_LABELS = {
  1: 'Pass u95',
  4: 'Pass diesel',
  2: 'Pass u98/u100',
  6: 'Pass LPG',
  5: 'Pass heating',
  8: 'Pass CNG'
};
/** Must hit coverage gates — full coord backfill */
const BACKFILL_REQUIRED = [1, 4];
/** Nice-to-have high-octane — capped + plateau abort */
const BACKFILL_OPTIONAL = [2];
/** Sparse retail fuels — only re-query stations that already sold them before */
const BACKFILL_KNOWN_SELLERS = [6, 5, 8];

const DEV_ID = 'android.4.0-' + crypto.randomBytes(8).toString('hex');
let requestsCount = 0;
let emptyResponses = 0;

/** Publish gates (vs previous snapshot when available) */
const GATE_MIN_STATIONS = 4300;
const GATE_MIN_U95_PCT = 95;
const GATE_MIN_DIESEL_PCT = 90;
const GATE_MIN_VS_PREV_PCT = 97; // must keep >=97% of previous station count

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter([min, max]) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function isPremiumDieselName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return (
    /v-?\s*power\s*diesel/.test(n) ||
    /super\s*diesel/.test(n) ||
    /diesel\s*super/.test(n) ||
    /ultimate\s*diesel/.test(n) ||
    /diesel\s*premium/.test(n) ||
    /premium\s*diesel/.test(n) ||
    /\bcrystal\b/.test(n) ||
    /diesel\s*best/.test(n) ||
    /d-?\s*force/.test(n) ||
    /avio/.test(n)
  );
}

function classifyHighOctaneName(name) {
  const n = String(name || '');
  const has98 = /\b98\b/.test(n);
  const has100 = /\b100\b/.test(n);
  if (has98 && !has100) return 'u98';
  if (has100 && !has98) return 'u100';
  if (has98 && has100) return 'both';
  return 'unknown';
}

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

        if (ftId === '4' && isPremiumDieselName(ftName)) {
          fuels.dp = { name: ftName, price: pr, date: ftDt };
        } else {
          fuels[ftId] = { name: ftName, price: pr, date: ftDt };
        }

        if (ftId === '2') {
          const octane = classifyHighOctaneName(ftName);
          if (octane === 'u98' || octane === 'both') {
            fuels.u98 = { name: ftName, price: pr, date: ftDt };
          }
          if (octane === 'u100' || octane === 'both' || octane === 'unknown') {
            fuels.u100 = { name: ftName, price: pr, date: ftDt };
          }
        }

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
    if (
      !isNaN(latNum) &&
      !isNaN(lngNum) &&
      latNum > 34.0 &&
      latNum < 42.0 &&
      lngNum > 19.0 &&
      lngNum < 29.0
    ) {
      stations.push({
        id,
        name: ow || br,
        owner: ow,
        brand: br,
        address: ad,
        prefecture: cnt,
        municipality: mun,
        district: dd,
        lat: Number(latNum.toFixed(6)),
        lng: Number(lngNum.toFixed(6)),
        fuel: primaryFuel,
        price: primaryPrice,
        fuels,
        last_updated: latestDate || new Date().toISOString().split('T')[0]
      });
    }
  }
  return stations;
}

function fetchDeixto(lat, lng, fuelType = 1) {
  return new Promise((resolve) => {
    const url =
      `https://deixto.gr/fuel/get_data_v4.php?` +
      `dev=${DEV_ID}&lat=${lat.toFixed(4)}&long=${lng.toFixed(4)}` +
      `&f=${fuelType}&b=0&d=${RADIUS_KM}&p=3`;

    https
      .get(
        url,
        {
          agent: AGENT,
          headers: {
            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; Pixel Build/UQ1A.240205.004)',
            Accept: '*/*',
            Connection: 'keep-alive'
          },
          timeout: 15000
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode || 0, xml: Buffer.concat(chunks).toString('utf8') });
          });
        }
      )
      .on('error', () => resolve({ status: 0, xml: '' }))
      .on('timeout', function () {
        this.destroy();
        resolve({ status: 0, xml: '' });
      });
  });
}

async function queryCoordinates(lat, lng, fuelType = 1) {
  requestsCount++;
  const res = await fetchDeixto(lat, lng, fuelType);
  if (res.status === 200 && res.xml && res.xml.includes('<gs id=')) {
    return parseXmlStations(res.xml);
  }
  emptyResponses++;
  return [];
}

function mergeStation(base, incoming) {
  if (!base) return incoming;
  const merged = { ...base };
  if (!merged.fuels) merged.fuels = {};
  if (incoming.fuels) {
    for (const [k, v] of Object.entries(incoming.fuels)) {
      if (!merged.fuels[k] || (v.date && v.date >= (merged.fuels[k].date || ''))) {
        merged.fuels[k] = v;
      }
    }
  }
  if (incoming.price && (!merged.price || incoming.last_updated >= (merged.last_updated || ''))) {
    merged.price = incoming.price;
    merged.fuel = incoming.fuel;
  }
  if (incoming.last_updated && incoming.last_updated > (merged.last_updated || '')) {
    merged.last_updated = incoming.last_updated;
  }
  if (!merged.address && incoming.address) merged.address = incoming.address;
  if (incoming.brand && incoming.brand !== 'Ανεξάρτητο') merged.brand = incoming.brand;
  if (incoming.name && incoming.name !== 'Πρατήριο Καυσίμων') merged.name = incoming.name;
  if (incoming.prefecture) merged.prefecture = incoming.prefecture;
  if (incoming.municipality) merged.municipality = incoming.municipality;
  return merged;
}

function stationCoords(s) {
  const lat = Number(s.lat ?? s.latitude);
  const lng = Number(s.lng ?? s.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 34 || lat > 42 || lng < 19 || lng > 29) return null;
  return { lat, lng };
}

function hasFuel(s, fuelId) {
  const key = String(fuelId);
  if (!s?.fuels) return false;
  if (s.fuels[key]) return true;
  if (fuelId === 4 && s.fuels.dp) return true;
  if (fuelId === 2 && (s.fuels.u98 || s.fuels.u100)) return true;
  return false;
}

/**
 * Dense hex mesh. Spacing ~22 km so 30 km radius circles overlap.
 * Extra island hubs cover sea gaps the bbox grid skips.
 */
function buildDenseMesh() {
  const points = [];
  const seen = new Set();
  const add = (lat, lng) => {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push([lat, lng]);
  };

  const latMin = 34.85;
  const latMax = 41.75;
  const lngMin = 19.35;
  const lngMax = 28.25;
  const dLat = MESH_SPACING_KM / 111.0;
  const midLat = 38.0;
  const dLng = MESH_SPACING_KM / (111.0 * Math.cos((midLat * Math.PI) / 180));

  let row = 0;
  for (let lat = latMin; lat <= latMax; lat += dLat * 0.866) {
    const offset = row % 2 === 0 ? 0 : dLng / 2;
    for (let lng = lngMin + offset; lng <= lngMax; lng += dLng) {
      add(Number(lat.toFixed(4)), Number(lng.toFixed(4)));
    }
    row++;
  }

  // Island / edge hubs the hex might under-sample
  const hubs = [
    [35.5138, 24.0180], [35.3387, 25.1442], [35.1914, 25.7153], [35.0117, 25.7422],
    [36.4349, 28.2175], [36.8933, 27.2889], [37.4467, 25.3289], [36.3932, 25.4615],
    [39.6243, 19.9217], [38.8333, 20.7000], [38.1750, 20.4889], [37.7878, 20.8978],
    [39.1100, 26.5547], [38.3678, 26.1358], [39.9167, 25.2500], [37.4417, 24.9417],
    [40.8457, 25.8740], [41.1192, 25.4054], [41.3500, 26.5000], [40.1000, 23.7500],
    [35.8500, 27.1333], [36.1500, 27.9500], [37.7500, 26.9833]
  ];
  for (const [lat, lng] of hubs) add(lat, lng);

  return points;
}

const URBAN_HUBS = [
  [37.9838, 23.7275], [38.0500, 23.8000], [37.9400, 23.6500], [38.1000, 23.5500],
  [40.6401, 22.9444], [40.5500, 23.0000], [38.2466, 21.7346], [35.3387, 25.1442],
  [39.6390, 22.4191], [39.3622, 22.9422], [39.6650, 20.8537], [37.0389, 22.1142],
  [35.5138, 24.0180], [38.4633, 23.5976], [41.0849, 23.5476], [40.9396, 24.4129],
  [36.4349, 28.2175], [40.2709, 22.5061], [38.9000, 22.4333], [37.9405, 22.9322]
];

async function fetchJson(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'fuelGR-scraper/2.0' }, timeout: 60000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

function normalizeBaselineStation(s) {
  // Accept raw scraper schema or packaged master schema
  if (s.fuels && s.lat != null) return s;
  if (s.p && (s.lat != null || s.latitude != null)) {
    const fuels = {};
    const p = s.p || {};
    if (p.u95) fuels['1'] = { price: p.u95, name: 'Unleaded 95', date: s.dt || '' };
    if (p.u98) fuels.u98 = { price: p.u98, name: 'Unleaded 98', date: s.dt || '' };
    if (p.u100) fuels.u100 = { price: p.u100, name: 'Unleaded 100', date: s.dt || '' };
    if (p.d) fuels['4'] = { price: p.d, name: 'Diesel', date: s.dt || '' };
    if (p.dp) fuels.dp = { price: p.dp, name: 'Diesel Premium', date: s.dt || '' };
    if (p.dh) fuels['5'] = { price: p.dh, name: 'Heating', date: s.dt || '' };
    if (p.lpg) fuels['6'] = { price: p.lpg, name: 'LPG', date: s.dt || '' };
    if (p.cng) fuels['8'] = { price: p.cng, name: 'CNG', date: s.dt || '' };
    return {
      id: String(s.id),
      name: s.n || s.name || '',
      brand: s.b || s.brand || 'Ανεξάρτητο',
      address: s.a || s.address || '',
      prefecture: s.pref || s.prefecture || '',
      municipality: s.mun || s.municipality || '',
      lat: s.lat ?? s.latitude,
      lng: s.lng ?? s.longitude,
      fuels,
      price: p.u95 || null,
      fuel: 'Unleaded 95',
      last_updated: s.dt || ''
    };
  }
  return null;
}

async function loadBaseline(stationsMap) {
  let loaded = 0;
  /** stationId -> Set of fuel ids that baseline already had */
  const knownSellers = new Map();

  function noteSellers(s) {
    const id = String(s.id);
    const set = knownSellers.get(id) || new Set();
    for (const fid of BACKFILL_KNOWN_SELLERS) {
      if (hasFuel(s, fid)) set.add(fid);
    }
    if (set.size) knownSellers.set(id, set);
  }

  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      if (Array.isArray(existing)) {
        for (const raw of existing) {
          const s = normalizeBaselineStation(raw);
          if (s?.id) {
            stationsMap.set(String(s.id), s);
            noteSellers(s);
            loaded++;
          }
        }
      }
    } catch (e) {
      console.warn('Local baseline unreadable:', e.message);
    }
  }
  if (loaded === 0) {
    console.log('Fetching previous release stations as baseline...');
    const remote = await fetchJson(RELEASE_STATIONS_URL);
    if (Array.isArray(remote)) {
      for (const raw of remote) {
        const s = normalizeBaselineStation(raw);
        if (s?.id) {
          stationsMap.set(String(s.id), s);
          noteSellers(s);
          loaded++;
        }
      }
    }
  }
  console.log(
    `Baseline stations loaded: ${loaded} (known sparse sellers: ${knownSellers.size})`
  );
  return { loaded, knownSellers };
}

async function runMeshPass(stationsMap, mesh, fuelId, label) {
  console.log(
    `\n[${label}] fuel=${fuelId} across ${mesh.length} points (concurrency=${MESH_CONCURRENCY})...`
  );
  let newHits = 0;
  let done = 0;
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= mesh.length) return;
      const [lat, lng] = mesh[i];
      const found = await queryCoordinates(lat, lng, fuelId);
      for (const s of found) {
        const id = String(s.id);
        if (!stationsMap.has(id)) {
          stationsMap.set(id, s);
          newHits++;
        } else {
          stationsMap.set(id, mergeStation(stationsMap.get(id), s));
        }
      }
      done++;
      if (done % 50 === 0 || done === mesh.length) {
        process.stdout.write(
          `\r  ${label}: ${done}/${mesh.length} (${Math.round((done / mesh.length) * 100)}%) ` +
            `stations=${stationsMap.size} req=${requestsCount}   `
        );
      }
      await sleep(jitter(MESH_DELAY_MS));
    }
  }

  await Promise.all(Array.from({ length: MESH_CONCURRENCY }, () => worker()));
  console.log(`\n  ${label} done (+${newHits} new).`);
}

/**
 * Exact-coord backfill.
 * - Plateau abort after N consecutive zero-gain queries.
 * - onlyIds: restrict to known sellers (sparse fuels).
 */
async function backfillMissingFuels(stationsMap, fuelIds, label = 'Backfill', opts = {}) {
  const plateau = opts.plateau ?? BACKFILL_PLATEAU;
  const maxQueries = opts.maxQueries ?? Infinity;
  const onlyIds = opts.onlyIds instanceof Set ? opts.onlyIds : null;

  for (const fuelId of fuelIds) {
    let pending = [...stationsMap.values()].filter((s) => !hasFuel(s, fuelId));
    if (onlyIds) pending = pending.filter((s) => onlyIds.has(String(s.id)));
    console.log(
      `\n[${label}] fuel=${fuelId}: ${pending.length} candidates` +
        (onlyIds ? ' (known sellers only)' : '') +
        (Number.isFinite(maxQueries) ? ` cap=${maxQueries}` : '') +
        ` plateau=${plateau}`
    );
    if (pending.length === 0) continue;

    let queried = 0;
    let gained = 0;
    let streakEmpty = 0;

    for (let i = 0; i < pending.length; i++) {
      if (queried >= maxQueries) {
        console.log(`\n  [${label} f=${fuelId}] hit query cap ${maxQueries} — stop.`);
        break;
      }
      const s = pending[i];
      if (hasFuel(stationsMap.get(String(s.id)), fuelId)) continue;
      const coords = stationCoords(s);
      if (!coords) continue;

      queried++;
      const beforeGained = gained;
      const found = await queryCoordinates(coords.lat, coords.lng, fuelId);
      for (const hit of found) {
        const id = String(hit.id);
        if (!stationsMap.has(id)) continue;
        const before = stationsMap.get(id);
        const had = hasFuel(before, fuelId);
        stationsMap.set(id, mergeStation(before, hit));
        if (!had && hasFuel(stationsMap.get(id), fuelId)) gained++;
      }

      if (gained === beforeGained) streakEmpty++;
      else streakEmpty = 0;

      if (queried % 25 === 0 || i + 1 === pending.length) {
        const still = pending.filter(
          (x) => !hasFuel(stationsMap.get(String(x.id)), fuelId)
        ).length;
        process.stdout.write(
          `\r  [${label} f=${fuelId}] queried=${queried} gained=+${gained} stillMissing=${still} streak0=${streakEmpty}   `
        );
      }

      if (streakEmpty >= plateau) {
        console.log(
          `\n  [${label} f=${fuelId}] plateau (${plateau} empty) — stop early (+${gained}).`
        );
        break;
      }
      await sleep(jitter(BACKFILL_DELAY_MS));
    }
    if (pending.length && streakEmpty < plateau && queried < maxQueries) console.log('');
  }
}

function coverageStats(stations) {
  const n = stations.length || 1;
  const u95 = stations.filter((s) => hasFuel(s, 1)).length;
  const diesel = stations.filter((s) => hasFuel(s, 4)).length;
  const hi = stations.filter((s) => hasFuel(s, 2) || s.fuels?.u98 || s.fuels?.u100).length;
  const lpg = stations.filter((s) => hasFuel(s, 6)).length;
  const dh = stations.filter((s) => hasFuel(s, 5)).length;
  const cng = stations.filter((s) => hasFuel(s, 8)).length;
  return {
    n: stations.length,
    u95,
    diesel,
    hi,
    lpg,
    dh,
    cng,
    u95Pct: (100 * u95) / n,
    dieselPct: (100 * diesel) / n
  };
}

function assertGates(stats, prevCount) {
  const errors = [];
  if (stats.n < GATE_MIN_STATIONS) {
    errors.push(`stations ${stats.n} < ${GATE_MIN_STATIONS}`);
  }
  if (stats.u95Pct < GATE_MIN_U95_PCT) {
    errors.push(`u95 ${stats.u95Pct.toFixed(1)}% < ${GATE_MIN_U95_PCT}%`);
  }
  if (stats.dieselPct < GATE_MIN_DIESEL_PCT) {
    errors.push(`diesel ${stats.dieselPct.toFixed(1)}% < ${GATE_MIN_DIESEL_PCT}%`);
  }
  if (prevCount > 0) {
    const keepPct = (100 * stats.n) / prevCount;
    if (keepPct < GATE_MIN_VS_PREV_PCT) {
      errors.push(
        `kept ${keepPct.toFixed(1)}% of previous (${stats.n}/${prevCount}) < ${GATE_MIN_VS_PREV_PCT}%`
      );
    }
  }
  return errors;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting deixto-only nationwide scraper...`);
  console.log(`Device: ${DEV_ID}`);
  console.log(
    `Radius=${RADIUS_KM}km meshSpacing=${MESH_SPACING_KM}km concurrency=${MESH_CONCURRENCY} (fuelgr.gr not used)`
  );

  const stationsMap = new Map();
  const { loaded: prevCount, knownSellers } = await loadBaseline(stationsMap);

  const mesh = buildDenseMesh();
  const meshReq = mesh.length * ALL_FUELS.length;
  const estMinutes = Math.ceil(meshReq / MESH_CONCURRENCY / 60) + 25;
  console.log(`Dense mesh points: ${mesh.length}`);
  console.log(
    `Est. mesh requests: ~${meshReq} for ALL fuels (~${estMinutes} min) + targeted backfill`
  );

  // 1) Nationwide mesh for EVERY fuel
  for (const fuelId of ALL_FUELS) {
    await runMeshPass(stationsMap, mesh, fuelId, FUEL_LABELS[fuelId] || `Pass f=${fuelId}`);
  }

  // Extra urban densify for sparse fuels
  for (const fuelId of [6, 5, 8]) {
    await runMeshPass(
      stationsMap,
      URBAN_HUBS,
      fuelId,
      `${FUEL_LABELS[fuelId]} densify (urban)`
    );
  }

  // 2) Backfill: gates fully; high-octane capped; sparse = known sellers only
  await backfillMissingFuels(stationsMap, BACKFILL_REQUIRED, 'Backfill-core');
  await backfillMissingFuels(stationsMap, BACKFILL_OPTIONAL, 'Backfill-optional', {
    maxQueries: BACKFILL_OPTIONAL_MAX,
    plateau: 40
  });

  for (const fuelId of BACKFILL_KNOWN_SELLERS) {
    const onlyIds = new Set(
      [...knownSellers.entries()].filter(([, set]) => set.has(fuelId)).map(([id]) => id)
    );
    await backfillMissingFuels(stationsMap, [fuelId], 'Backfill-known', {
      onlyIds,
      plateau: 50
    });
  }

  const stations = Array.from(stationsMap.values());
  const stats = coverageStats(stations);

  console.log(`\n========================================================`);
  console.log(`SCRAPE COMPLETE — ${requestsCount} HTTP requests (empty=${emptyResponses})`);
  console.log(`  Stations : ${stats.n}`);
  console.log(`  Unleaded95: ${stats.u95} (${stats.u95Pct.toFixed(1)}%)`);
  console.log(`  Diesel    : ${stats.diesel} (${stats.dieselPct.toFixed(1)}%)`);
  console.log(`  High-oct  : ${stats.hi}`);
  console.log(`  LPG       : ${stats.lpg}`);
  console.log(`  Heating   : ${stats.dh}`);
  console.log(`  CNG       : ${stats.cng}`);
  console.log(`========================================================`);

  const gateErrors = assertGates(stats, prevCount);
  if (gateErrors.length) {
    console.error('\n[!] Coverage gates FAILED — refusing to overwrite stations file:');
    for (const e of gateErrors) console.error('   -', e);
    console.error('Previous good snapshot left untouched.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(stations));
  console.log(
    `\n[OK] Saved ${stations.length} stations (${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(0)} KB) -> ${OUTPUT_FILE}`
  );
}

main().catch((err) => {
  console.error('Fatal scrape error:', err);
  process.exit(1);
});
