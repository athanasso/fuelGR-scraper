/**
 * FuelPrices.gr / FuelGR Nationwide Station Price Scraper
 *
 * Scrapes all gas stations across Greece (~4,500+ stations) using a
 * comprehensive geospatial coordinate grid covering all 51 prefectures,
 * major urban areas, and islands.
 *
 * Outputs: data/stations_latest.min.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_FILE = path.join(__dirname, 'data', 'stations_latest.min.json');

const AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
  timeout: 10000
});

const API_BASE = 'https://deixto.gr/fuel/get_data_v4.php';
const API_PARAMS =
  'dev=android.4.0-b2da2cf97330ca3b&f=1&b=0&d=30&p=0&dSig=google/coral/coral:14/UQ1A.240205.004/1709778835:userdebug/release-keys&iLoc=unknown&apkSig=UPJ2YQunu9eGXu8a/WOiVNAZlYA=';

/**
 * Generate nationwide coordinate scan grid covering Greece:
 * - Base grid across Greek landmass & islands (~0.22 deg step)
 * - Dense urban sampling for high-density metropolitan areas (~0.04-0.05 deg step)
 *   (Athens/Attica, Thessaloniki, Patras, Larissa, Heraklion, Chania, Rhodes, etc.)
 */
function generateScanGrid() {
  const points = new Map();

  const addPoint = (lat, lng) => {
    const key = `${lat.toFixed(3)}_${lng.toFixed(3)}`;
    if (!points.has(key)) {
      points.set(key, { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) });
    }
  };

  // 1. Nationwide base grid (lat 34.8 to 41.8, lng 19.5 to 28.3)
  for (let lat = 34.8; lat <= 41.8; lat += 0.22) {
    for (let lng = 19.5; lng <= 28.3; lng += 0.25) {
      // Rough filter to avoid empty open Mediterranean / Ionian seas
      if (
        (lat >= 35.0 && lat <= 35.6 && lng >= 23.5 && lng <= 26.3) || // Crete
        (lat >= 35.8 && lat <= 36.6 && lng >= 27.5 && lng <= 28.3) || // Rhodes / Karpathos
        (lat >= 36.5 && lat <= 37.8 && lng >= 24.5 && lng <= 26.5) || // Cyclades
        (lat >= 36.4 && lat <= 38.5 && lng >= 21.0 && lng <= 23.5) || // Peloponnese
        (lat >= 37.5 && lat <= 39.0 && lng >= 23.0 && lng <= 24.5) || // Attica, Boeotia, Euboea
        (lat >= 38.0 && lat <= 40.0 && lng >= 20.5 && lng <= 22.5) || // Western Greece, Epirus, Thessaly
        (lat >= 37.5 && lat <= 40.0 && lng >= 25.5 && lng <= 27.0) || // Lesbos, Chios, Samos, Lemnos
        (lat >= 39.5 && lat <= 41.8 && lng >= 20.5 && lng <= 26.8) || // Macedonia, Thrace
        (lat >= 37.6 && lat <= 40.0 && lng >= 19.8 && lng <= 21.0)    // Ionian islands (Corfu, Kefalonia, Zante)
      ) {
        addPoint(lat, lng);
      }
    }
  }

  // 2. High-density urban clusters (API caps at 30 stations per 30km circle)
  // Attica (Athens & surrounding municipalities)
  for (let lat = 37.80; lat <= 38.25; lat += 0.04) {
    for (let lng = 23.50; lng <= 24.05; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  // Thessaloniki metropolitan area
  for (let lat = 40.50; lat <= 40.75; lat += 0.04) {
    for (let lng = 22.80; lng <= 23.15; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  // Patras
  for (let lat = 38.18; lat <= 38.30; lat += 0.04) {
    for (let lng = 21.68; lng <= 21.80; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  // Larissa / Volos
  for (let lat = 39.30; lat <= 39.68; lat += 0.06) {
    for (let lng = 22.35; lng <= 23.00; lng += 0.06) {
      addPoint(lat, lng);
    }
  }

  // Heraklion / Chania (Crete)
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

  // Rhodes city
  for (let lat = 36.38; lat <= 36.46; lat += 0.04) {
    for (let lng = 28.18; lng <= 28.24; lng += 0.04) {
      addPoint(lat, lng);
    }
  }

  return Array.from(points.values());
}

/**
 * Fetch raw XML feed from a single coordinate point
 */
function fetchCoordinates(lat, lng) {
  return new Promise((resolve) => {
    const url = `${API_BASE}?${API_PARAMS}&lat=${lat}&long=${lng}`;
    const req = https.get(
      url,
      {
        agent: AGENT,
        headers: {
          'User-Agent': 'Dalvik/2.1.0',
          'Accept-Encoding': 'gzip, deflate'
        },
        timeout: 9000
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', () => resolve(''));
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

/**
 * Parse stations from XML response
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

    // Extract fuels from <fts><ft ...><![CDATA[...]]></ft></fts>
    const fuels = {};
    const ftMatches = body.matchAll(/<ft id="(\d+)"[^>]*pr="([^"]+)"[^>]*dt="([^"]*)"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ft>/g);
    let primaryPrice = null;
    let primaryFuel = 'Unleaded 95';
    let latestDate = '';

    for (const ft of ftMatches) {
      const ftId = ft[1];
      const rawPr = parseFloat(ft[2].replace(',', '.'));
      const ftDt = (ft[3] || '').split(' ')[0];
      const ftName = (ft[4] || '').trim();

      if (!isNaN(rawPr) && rawPr > 0) {
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
    const isValidCoord = !isNaN(latNum) && !isNaN(lngNum) && latNum >= 34.0 && latNum <= 42.5 && lngNum >= 19.0 && lngNum <= 30.0;

    if (id && isValidCoord) {
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
        fuels: fuels,
        last_updated: latestDate || new Date().toISOString().split('T')[0]
      });
    }
  }

  return stations;
}

/**
 * Worker pool to process grid points concurrently
 */
async function processGridConcurrently(grid, concurrency = 20) {
  const uniqueStations = new Map();
  let completed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < grid.length) {
      const idx = cursor++;
      const point = grid[idx];
      try {
        const xml = await fetchCoordinates(point.lat, point.lng);
        const list = parseXmlStations(xml);
        for (const s of list) {
          if (!uniqueStations.has(s.id)) {
            uniqueStations.set(s.id, s);
          }
        }
      } catch {}
      completed++;
      if (completed % 100 === 0 || completed === grid.length) {
        process.stdout.write(
          `\r[Scan Progress] ${completed}/${grid.length} points (${Math.round((completed / grid.length) * 100)}%) -> ${uniqueStations.size} unique stations`
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

  const grid = generateScanGrid();
  console.log(`Generated geospatial scan grid: ${grid.length} coordinates across Greece.`);

  const stations = await processGridConcurrently(grid, 25);
  console.log(`\nExtracted ${stations.length} valid unique gas stations.`);

  if (stations.length < 1000) {
    console.error(`[!] Error: Expected 4000+ stations, but only found ${stations.length}. Check network.`);
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
