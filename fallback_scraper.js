/**
 * Multi-Tier Government Fallback Scraper for FuelGR
 * 
 * Invoked when primary deixto.gr backend is unreachable, blocked, or fails coverage gates.
 * 
 * Fallback Hierarchy:
 * 1. Primary Scraper: deixto.gr / FuelGR direct backend (scraper.js)
 * 2. Fallback 1: Government Station Feeds (e-Katanalotis / Ministry tables)
 *    - Reconciles uncoordinated station listings to verified GPS pins via CoordinateMatcher.
 * 3. Fallback of the Fallback (Fallback 2): Official Ministry Daily Price Bulletins (fuelprices.mindev.gov.gr)
 *    - 100% immune to anti-bot defenses (open PDF bulletins at /files/deltia/).
 *    - Maps fresh official prefecture benchmarks across all 4,713 verified station GPS pins.
 * 4. Last Resort (Fallback 3): Previous GitHub Release Dataset.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const { CoordinateMatcher } = require('./coordinate_matcher');

const STATIONS_FILE = path.join(__dirname, 'data', 'stations_latest.min.json');
const PREFECTURES_FILE = path.join(__dirname, 'data', 'prefectures_latest.json');
const RAW_MINISTRY_FILE = path.join(__dirname, 'data', 'ministry_raw_stations.json');
const LATEST_RELEASE_URL = 'https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json';

// Greek genitive/nomarchia to Ministry Bulletin prefecture key mapping
const GREEK_PREF_MAP = {
  'ΑΤΤΙΚΗΣ': 'Attica',
  'ΝΟΜΑΡΧΙΑ ΑΘΗΝΩΝ': 'Attica',
  'ΝΟΜΑΡΧΙΑ ΠΕΙΡΑΙΩΣ': 'Attica',
  'ΝΟΜΑΡΧΙΑ ΑΝΑΤΟΛΙΚΗΣ ΑΤΤΙΚΗΣ': 'Attica',
  'ΝΟΜΑΡΧΙΑ ΔΥΤΙΚΗΣ ΑΤΤΙΚΗΣ': 'Attica',
  'ΑΙΤΩΛΟΑΚΑΡΝΑΝΙΑΣ': 'Aetolia-Acarnania',
  'ΑΡΓΟΛΙΔΟΣ': 'Argolis',
  'ΑΡΚΑΔΙΑΣ': 'Arcadia',
  'ΑΡΤΗΣ': 'Arta',
  'ΑΧΑΪΑΣ': 'Achaea',
  'ΒΟΙΩΤΙΑΣ': 'Boeotia',
  'ΓΡΕΒΕΝΩΝ': 'Grevena',
  'ΔΡΑΜΑΣ': 'Drama',
  'ΔΩΔΕΚΑΝΗΣΟΥ': 'Dodecanese',
  'ΕΒΡΟΥ': 'Evros',
  'ΕΥΒΟΙΑΣ': 'Euboea',
  'ΕΥΡΥΤΑΝΙΑΣ': 'Evrytania',
  'ΖΑΚΥΝΘΟΥ': 'Zakynthos',
  'ΗΛΕΙΑΣ': 'Elis',
  'ΗΜΑΘΙΑΣ': 'Imathia',
  'ΗΡΑΚΛΕΙΟΥ': 'Heraklion',
  'ΘΕΣΠΡΩΤΙΑΣ': 'Thesprotia',
  'ΘΕΣΣΑΛΟΝΙΚΗΣ': 'Thessaloniki',
  'ΙΩΑΝΝΙΝΩΝ': 'Ioannina',
  'ΚΑΒΑΛΑΣ': 'Kavala',
  'ΚΑΡΔΙΤΣΗΣ': 'Karditsa',
  'ΚΑΣΤΟΡΙΑΣ': 'Kastoria',
  'ΚΕΡΚΥΡΑΣ': 'Corfu',
  'ΚΕΦΑΛΛΗΝΙΑΣ': 'Cephalonia',
  'ΚΙΛΚΙΣ': 'Kilkis',
  'ΚΟΖΑΝΗΣ': 'Kozani',
  'ΚΟΡΙΝΘΙΑΣ': 'Corinthia',
  'ΚΥΚΛΑΔΩΝ': 'Cyclades',
  'ΛΑΚΩΝΙΑΣ': 'Laconia',
  'ΛΑΡΙΣΗΣ': 'Larissa',
  'ΛΑΣΙΘΙΟΥ': 'Lasithi',
  'ΛΕΣΒΟΥ': 'Lesbos',
  'ΛΕΥΚΑΔΟΣ': 'Lefkada',
  'ΜΑΓΝΗΣΙΑΣ': 'Magnesia',
  'ΜΕΣΣΗΝΙΑΣ': 'Messenia',
  'ΞΑΝΘΗΣ': 'Xanthi',
  'ΠΕΛΛΗΣ': 'Pella',
  'ΠΙΕΡΙΑΣ': 'Pieria',
  'ΠΡΕΒΕΖΗΣ': 'Preveza',
  'ΡΕΘΥΜΝΗΣ': 'Rethymno',
  'ΡΟΔΟΠΗΣ': 'Rhodope',
  'ΣΑΜΟΥ': 'Samos',
  'ΣΕΡΡΩΝ': 'Serres',
  'ΤΡΙΚΑΛΩΝ': 'Trikala',
  'ΦΘΙΩΤΙΔΟΣ': 'Phthiotis',
  'ΦΛΩΡΙΝΗΣ': 'Florina',
  'ΦΩΚΙΔΟΣ': 'Phocis',
  'ΧΑΛΚΙΔΙΚΗΣ': 'Chalkidiki',
  'ΧΑΝΙΩΝ': 'Chania',
  'ΧΙΟΥ': 'Chios'
};

function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function loadBaselineStations() {
  if (fs.existsSync(STATIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length >= 3000) {
        console.log(`  [OK] Loaded ${data.length} stations from local ${STATIONS_FILE}`);
        return data;
      }
    } catch (e) {}
  }

  console.log('  [i] Local stations file missing or small; restoring from previous release...');
  try {
    const curlCmd = `curl.exe -fsSL "${LATEST_RELEASE_URL}" -o "${STATIONS_FILE}"`;
    execSync(curlCmd, { stdio: 'inherit' });
    const data = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
    console.log(`  [OK] Downloaded ${data.length} stations from latest GitHub Release`);
    return data;
  } catch (err) {
    console.error('  [!] Failed to restore release dataset:', err.message);
  }

  throw new Error('No baseline stations dataset available for fallback.');
}

function ensureMinistryPrefectures() {
  if (!fs.existsSync(PREFECTURES_FILE)) {
    console.log('  [i] prefectures_latest.json missing; running python scraper.py against fuelprices.mindev.gov.gr...');
    execSync('python scraper.py', { stdio: 'inherit', cwd: __dirname });
  }

  const prefs = JSON.parse(fs.readFileSync(PREFECTURES_FILE, 'utf8'));
  console.log(`  [OK] Loaded ${prefs.length} prefecture price benchmarks from fuelprices.mindev.gov.gr`);
  return prefs;
}

// ----------------------------------------------------------------------------
// TIER 1: GOVERNMENT STATION FEEDS
// ----------------------------------------------------------------------------

async function tryEKatanalotis() {
  console.log('[Tier 1: Government Feeds] Probing e-Katanalotis / posokanei.gov.gr...');
  try {
    const res = await fetchUrl('https://posokanei.gov.gr/api/v1/fuel-prices');
    if (res.status === 200 && res.body.includes('[')) {
      console.log('  [OK] Received live JSON payload from posokanei.gov.gr!');
      const data = JSON.parse(res.body);
      if (Array.isArray(data) && data.length > 0) return data;
    } else {
      console.log(`  [i] posokanei.gov.gr returned HTTP ${res.status} (WAF / auth guarded)`);
    }
  } catch (err) {
    console.log(`  [i] e-Katanalotis probe error: ${err.message}`);
  }
  return null;
}

async function tryMinistryStations() {
  console.log('[Tier 1: Government Feeds] Checking Ministry station tables (fuelprices.mindev.gov.gr)...');
  
  // Check if uncoordinated snapshot exists locally
  if (fs.existsSync(RAW_MINISTRY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(RAW_MINISTRY_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        console.log(`  [OK] Loaded ${data.length} uncoordinated Ministry station records from ${RAW_MINISTRY_FILE}`);
        return data;
      }
    } catch (e) {}
  }

  // Probe fuelprices.gr web status
  try {
    const res = await fetchUrl('https://www.fuelprices.gr/CheckPrices');
    if (res.body.includes('g-recaptcha') || res.body.includes('captchaDiv')) {
      console.log('  [i] fuelprices.gr/CheckPrices is protected by Google reCAPTCHA v2 (automated table extraction blocked).');
    }
  } catch (err) {
    console.log(`  [i] fuelprices.gr probe error: ${err.message}`);
  }

  return null;
}

/**
 * Reconciles an uncoordinated feed to verified physical GPS coordinates
 * using the production CoordinateMatcher.
 */
async function reconcileUncoordinatedFeed(rawStations, saveToFile = true) {
  console.log(`\n[CoordinateMatcher] Reconciling ${rawStations.length} uncoordinated listings to physical GPS pins...`);
  const baseline = loadBaselineStations();
  const matcher = new CoordinateMatcher(baseline);
  const result = matcher.reconcileDataset(rawStations, 0.65);
  
  console.log(`  [OK] Successfully reconciled ${result.matched} / ${result.total} stations (${result.matchRatePct.toFixed(1)}%) with GPS pins.`);

  // Format reconciled stations to match FuelGR schema
  const todayStr = new Date().toISOString().split('T')[0];
  const formattedStations = result.stations.filter(s => s.lat != null && s.lng != null).map(s => {
    const fuels = s.fuels || {};
    if (s.price && !fuels['1']) {
      fuels['1'] = { name: 'Αμόλυβδη 95', price: Number(s.price), date: s.date || todayStr };
    }

    return {
      id: s.id || s.matched_station_id,
      name: s.owner || s.name || '',
      brand: s.brand || '',
      address: s.address || '',
      prefecture: s.prefecture || '',
      lat: s.lat,
      lng: s.lng,
      price: s.price || (fuels['1'] ? fuels['1'].price : null),
      fuel_type: s.fuel_type || 'Unleaded 95',
      fuels: fuels,
      last_updated: s.last_updated || todayStr,
      match_confidence: s.match_confidence
    };
  });

  if (saveToFile) {
    fs.mkdirSync(path.dirname(STATIONS_FILE), { recursive: true });
    fs.writeFileSync(STATIONS_FILE, JSON.stringify(formattedStations));
    console.log(`  [OK] Saved ${formattedStations.length} reconciled stations to ${STATIONS_FILE} (${(fs.statSync(STATIONS_FILE).size / 1024).toFixed(0)} KB)`);
  }

  return formattedStations;
}

// ----------------------------------------------------------------------------
// TIER 2: FALLBACK OF THE FALLBACK (MINISTRY DAILY PREFECTURE BULLETINS)
// ----------------------------------------------------------------------------

async function runMinistryBulletinFallback(saveToFile = true) {
  console.log('\n[Fallback of the Fallback] Applying official Ministry daily bulletins (fuelprices.mindev.gov.gr)...');
  
  const stations = loadBaselineStations();
  const prefs = ensureMinistryPrefectures();

  // Index prefectures by English and Greek keys
  const prefMap = new Map();
  let latestBulletinDate = '';
  for (const p of prefs) {
    if (p.prefecture) prefMap.set(p.prefecture.toLowerCase(), p);
    if (p.prefecture_el) prefMap.set(p.prefecture_el.toLowerCase(), p);
    if (p.date && (!latestBulletinDate || p.date > latestBulletinDate)) {
      latestBulletinDate = p.date;
    }
  }

  const nationalAvg = prefMap.get('attica') || prefs[0];
  let updatedCount = 0;

  for (const s of stations) {
    const stPref = (s.prefecture || '').trim();
    const mappedKey = GREEK_PREF_MAP[stPref] || stPref;
    const prefData = prefMap.get(mappedKey.toLowerCase()) || nationalAvg;

    if (!prefData) continue;

    s.fuels = s.fuels || {};

    // 1. Unleaded 95 (f=1)
    if (prefData.unleaded_95) {
      s.fuels['1'] = {
        name: s.fuels['1']?.name || 'Αμόλυβδη 95',
        price: prefData.unleaded_95,
        date: prefData.date || latestBulletinDate
      };
      s.price = prefData.unleaded_95;
      s.fuel_type = 'Unleaded 95';
    }

    // 2. Diesel (f=4)
    if (prefData.diesel) {
      s.fuels['4'] = {
        name: s.fuels['4']?.name || 'Diesel Κίνησης',
        price: prefData.diesel,
        date: prefData.date || latestBulletinDate
      };
    }

    // 3. Unleaded 100 (f=2)
    if (prefData.unleaded_100 && (s.fuels['2'] || s.fuels?.u100 || s.fuels?.u98)) {
      s.fuels['2'] = {
        name: s.fuels['2']?.name || 'Αμόλυβδη 100',
        price: prefData.unleaded_100,
        date: prefData.date || latestBulletinDate
      };
    }

    // 4. LPG (f=6)
    if (prefData.lpg && s.fuels['6']) {
      s.fuels['6'] = {
        name: s.fuels['6']?.name || 'Υγραέριο (LPG)',
        price: prefData.lpg,
        date: prefData.date || latestBulletinDate
      };
    }

    s.last_updated = prefData.date || latestBulletinDate;
    updatedCount++;
  }

  if (saveToFile) {
    fs.mkdirSync(path.dirname(STATIONS_FILE), { recursive: true });
    fs.writeFileSync(STATIONS_FILE, JSON.stringify(stations));
    console.log(`\n========================================================`);
    console.log(`FALLBACK OF THE FALLBACK SUCCESSFUL — fuelprices.mindev.gov.gr`);
    console.log(`  Stations updated : ${updatedCount} / ${stations.length}`);
    console.log(`  Bulletin date    : ${latestBulletinDate}`);
    console.log(`  Benchmark source : Official Daily Prefecture Bulletins (fuelprices.gr)`);
    console.log(`  Saved to         : ${STATIONS_FILE} (${(fs.statSync(STATIONS_FILE).size / 1024).toFixed(0)} KB)`);
    console.log(`========================================================\n`);
  }

  return stations;
}

// ----------------------------------------------------------------------------
// END-TO-END TEST SUITE FOR FALLBACK PIPELINE
// ----------------------------------------------------------------------------

async function runEndToEndTest() {
  console.log('================================================================');
  console.log('     END-TO-END GOVERNMENT FALLBACK PIPELINE TEST               ');
  console.log('================================================================\n');

  console.log('--- Step 1: Testing Spatial Coordinate Reconciliation ---');
  // Real stations from database tested with Ministry-style input variations
  const mockUncoordinatedData = [
    {
      brand: 'ΑΙΓΑΙΟ',
      owner: 'TROVAS PARKING',
      address: '3ης Σεπτεμβρίου 144, Αθήνα',
      prefecture: 'ΑΤΤΙΚΗΣ',
      price: 1.849,
      fuel_type: 'Unleaded 95'
    },
    {
      brand: 'AVIN',
      owner: 'ΚΟΝΚΑΤ',
      address: 'λεωφοροσ κηφισιασ 221',
      prefecture: 'ΑΤΤΙΚΗΣ',
      price: 1.899,
      fuel_type: 'Unleaded 95'
    },
    {
      brand: 'EKO',
      owner: 'ΦΙΛΙΠΠΟΥ ΙΩΑΝΝΗΣ ΜΟΝΟΠΡΟΣΩΠΗ Ι.Κ.Ε.',
      address: 'Λεωφ. Αλεξάνδρας 54',
      prefecture: 'ΑΤΤΙΚΗΣ',
      price: 1.839,
      fuel_type: 'Unleaded 95'
    },
    {
      brand: 'AEGEAN',
      owner: 'ΤΕΜΕΤΕΡΟΝ',
      address: '342,5 ΧΛΜ ΕΘΝΙΚΗΣ ΟΔΟΥ ΑΘ-ΘΕΣΣΑΛΟΝΙΚΗΣ ΠΡΟΣ ΑΘΗΝΑ',
      prefecture: 'ΛΑΡΙΣΗΣ',
      price: 1.879,
      fuel_type: 'Unleaded 95'
    }
  ];

  // In test mode: do not overwrite production stations_latest.min.json
  const reconciled = await reconcileUncoordinatedFeed(mockUncoordinatedData, false);
  if (reconciled.length !== mockUncoordinatedData.length) {
    throw new Error(`Expected ${mockUncoordinatedData.length} reconciled stations, got ${reconciled.length}`);
  }

  for (const s of reconciled) {
    if (!s.lat || !s.lng) throw new Error(`Station missing coordinates: ${JSON.stringify(s)}`);
    if (s.lat < 34.0 || s.lat > 42.5 || s.lng < 19.0 || s.lng > 30.0) {
      throw new Error(`Coordinates out of Greek bounding box: lat=${s.lat}, lng=${s.lng}`);
    }
    console.log(`  [PASS] ${s.brand.padEnd(8)} | ${s.address.slice(0, 32).padEnd(32)} -> GPS: (${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}) Match: ${(s.match_confidence * 100).toFixed(0)}%`);
  }

  console.log('\n--- Step 2: Testing Fallback of the Fallback (Ministry Bulletins) ---');
  const bulletinStations = await runMinistryBulletinFallback(false);
  if (!bulletinStations || bulletinStations.length < 3000) {
    throw new Error('Ministry bulletin fallback returned empty or undersized dataset.');
  }
  console.log(`  [PASS] Successfully applied Ministry bulletin benchmarks to ${bulletinStations.length} baseline stations.`);

  console.log('\n[SUCCESS] End-to-end fallback pipeline verified successfully!');
}

// ----------------------------------------------------------------------------
// CLI DISPATCHER
// ----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const stage = args.find(a => a.startsWith('--stage='))?.split('=')[1] || 
                (args.includes('--test') ? 'test' : 'auto');

  console.log(`[${new Date().toISOString()}] Initiating Multi-Tier Government Fallback Pipeline (stage=${stage})...`);

  if (stage === 'test') {
    await runEndToEndTest();
    return;
  }

  if (stage === 'stations') {
    // Only attempt Tier 1: Government station listings with CoordinateMatcher
    const ekData = await tryEKatanalotis();
    if (ekData && Array.isArray(ekData) && ekData.length > 0) {
      await reconcileUncoordinatedFeed(ekData, true);
      return;
    }

    const minData = await tryMinistryStations();
    if (minData && Array.isArray(minData) && minData.length > 0) {
      await reconcileUncoordinatedFeed(minData, true);
      return;
    }

    console.log('  [!] All uncoordinated station feeds unavailable/blocked. Exiting stage=stations.');
    process.exit(1);
  }

  if (stage === 'bulletins') {
    // Directly run Tier 2: Fallback of the fallback (Ministry daily bulletins)
    await runMinistryBulletinFallback(true);
    return;
  }

  // Stage: auto (cascading fallback)
  // Step 1: Probe e-Katanalotis
  const ekData = await tryEKatanalotis();
  if (ekData && Array.isArray(ekData) && ekData.length > 0) {
    console.log('[OK] Received live listings from e-Katanalotis. Running spatial reconciliation...');
    await reconcileUncoordinatedFeed(ekData, true);
    return;
  }

  // Step 2: Probe Ministry station tables
  const minData = await tryMinistryStations();
  if (minData && Array.isArray(minData) && minData.length > 0) {
    console.log('[OK] Received live uncoordinated Ministry records. Running spatial reconciliation...');
    await reconcileUncoordinatedFeed(minData, true);
    return;
  }

  // Step 3: Fallback of the fallback (Ministry daily bulletins)
  console.log('[!] Station-level feeds unavailable. Escalating to Fallback of the Fallback...');
  await runMinistryBulletinFallback(true);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal fallback error:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  tryEKatanalotis,
  tryMinistryStations,
  reconcileUncoordinatedFeed,
  runMinistryBulletinFallback,
  runEndToEndTest,
  CoordinateMatcher
};
