/**
 * Comprehensive Benchmark & Validation Test Suite for CoordinateMatcher
 * 
 * Tests:
 * 1. 250-station nationwide stress test with real Ministry distortions.
 * 2. Edge-case test matrix (highway km markers, brand aliases, corporate morphs, typos).
 * 3. Negative validation tests (ensures non-existent stations are rejected, 0 false positives).
 */

const path = require('path');
const fs = require('fs');
const {
  CoordinateMatcher,
  stripAccents,
  cleanCorporateTypes,
  brandSimilarity,
  extractStreetAndNumber,
  haversineM
} = require('./coordinate_matcher');

const STATIONS_PATH = path.join(__dirname, 'data', 'stations_latest.min.json');

console.log('================================================================');
console.log('       COORDINATE MATCHER COMPREHENSIVE VALIDATION SUITE        ');
console.log('================================================================\n');

const matcher = new CoordinateMatcher(STATIONS_PATH);
console.log(`[OK] Loaded ${matcher.stations.length} ground-truth stations into spatial index.\n`);

// ============================================================================
// PART 1: EDGE CASES & ISOLATED UNIT TESTS
// ============================================================================
console.log('--- TEST GROUP 1: Edge Cases & Semantic Resiliency ---');

const edgeCases = [
  {
    name: 'Brand Alias Translation (Greek to Latin: ΑΙΓΑΙΟ -> AEGEAN)',
    input: {
      brand: 'ΑΙΓΑΙΟ',
      owner: 'TROVAS PARKING',
      address: '3ης Σεπτεμβρίου 144, Αθήνα',
      prefecture: 'ΑΤΤΙΚΗΣ'
    },
    expectMatch: true,
    expectedBrand: 'ΑΙΓΑΙΟ (AEGEAN)'
  },
  {
    name: 'Highway Kilometer Marker Extraction (342,5 ΧΛΜ Ε.Ο.)',
    input: {
      brand: 'AEGEAN',
      owner: 'ΤΕΜΕΤΕΡΟΝ',
      address: '342,5 ΧΛΜ ΕΘΝΙΚΗΣ ΟΔΟΥ ΑΘ-ΘΕΣΣΑΛΟΝΙΚΗΣ ΠΡΟΣ ΑΘΗΝΑ',
      prefecture: 'ΛΑΡΙΣΗΣ'
    },
    expectMatch: true
  },
  {
    name: 'Corporate Suffix Shift (Ο.Ε. -> ΜΟΝΟΠΡΟΣΩΠΗ Ι.Κ.Ε.)',
    input: {
      brand: 'EKO',
      owner: 'ΦΙΛΙΠΠΟΥ ΙΩΑΝΝΗΣ ΜΟΝΟΠΡΟΣΩΠΗ Ι.Κ.Ε.',
      address: 'Λεωφ. Αλεξάνδρας 54',
      prefecture: 'ΑΤΤΙΚΗΣ'
    },
    expectMatch: true
  },
  {
    name: 'Prefix Stripping & Lowercase (λεωφοροσ κηφισιασ -> ΚΗΦΙΣΙΑΣ)',
    input: {
      brand: 'AVIN',
      owner: 'ΚΟΝΚΑΤ',
      address: 'λεωφοροσ κηφισιασ 221',
      prefecture: 'ΑΤΤΙΚΗΣ'
    },
    expectMatch: true
  },
  {
    name: 'Negative Control: Completely Bogus Station (Should Reject)',
    input: {
      brand: 'NONEXISTENT_OIL',
      owner: 'FAKE PERSON X99',
      address: 'ΑΝΥΠΑΡΚΤΗ ΟΔΟΣ 9999, ΠΟΥΘΕΝΑ',
      prefecture: 'ΑΤΤΙΚΗΣ'
    },
    expectMatch: false
  }
];

let edgeCasePassed = 0;
for (const ec of edgeCases) {
  const res = matcher.matchStation(ec.input, 0.65);
  const passed = res.matched === ec.expectMatch;
  if (passed) {
    edgeCasePassed++;
    console.log(`  [PASS] ${ec.name} -> score=${res.score.toFixed(2)}`);
  } else {
    console.error(`  [FAIL] ${ec.name} -> expected match=${ec.expectMatch}, got ${res.matched} (score=${res.score.toFixed(2)})`);
  }
}
console.log(`\nEdge cases summary: ${edgeCasePassed} / ${edgeCases.length} passed.\n`);

// ============================================================================
// PART 2: 250-STATION NATIONWIDE STRESS TEST
// ============================================================================
console.log('--- TEST GROUP 2: 250-Station Nationwide Stress Benchmark ---');
console.log('Sampling 250 random stations across Greece with simulated Ministry distortions...');

// Deterministic sampling
const validStations = matcher.stations.filter(s => s._lat != null && s._lng != null);

// Pseudo-random deterministic shuffle
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rand = seededRandom(1337);

const sampleSize = 250;
const shuffled = [...validStations].sort(() => rand() - 0.5);
const testSet = shuffled.slice(0, sampleSize);

let totalMatched = 0;
let exactPins = 0; // < 25 meters
let falsePositives = 0;
const errorDistances = [];
const startTime = Date.now();

for (let i = 0; i < testSet.length; i++) {
  const orig = testSet[i];
  
  // Apply realistic Ministry distortions across full or minified schema:
  // 1. Legal form alteration (50% of the time)
  let testOwner = orig.name || orig.owner || orig.n || '';
  if (i % 2 === 0) {
    testOwner = testOwner.replace(/Ο\.?Ε\.?|Ε\.?Π\.?Ε\.?|Ι\.?Κ\.?Ε\.?|Α\.?Ε\.?/gi, '').trim() + ' Ι.Κ.Ε.';
  }
  
  // 2. Address case & prefix variation
  let testAddr = orig.address || orig.a || '';
  if (i % 3 === 0) {
    testAddr = testAddr.toLowerCase();
  }
  if (i % 5 === 0 && !testAddr.startsWith('ΟΔΟΣ')) {
    testAddr = 'ΟΔΟΣ ' + testAddr;
  }

  // 3. Brand variation (e.g. English <-> Greek)
  let testBrand = orig.brand || orig.b || '';
  if (testBrand.includes('AEGEAN')) testBrand = 'ΑΙΓΑΙΟ';
  else if (testBrand.includes('EKO')) testBrand = 'ΕΚΟ';
  else if (testBrand.includes('SHELL')) testBrand = 'ΚΟΡΑΛ';

  const simulatedMinistryRow = {
    brand: testBrand,
    owner: testOwner,
    address: testAddr,
    prefecture: orig.prefecture || orig.pref || '',
    price: 2.19
  };

  const matchRes = matcher.matchStation(simulatedMinistryRow, 0.65);

  if (matchRes.matched) {
    totalMatched++;
    const dist = haversineM(orig._lat, orig._lng, matchRes.lat, matchRes.lng);
    errorDistances.push(dist);

    if (dist < 25.0) {
      exactPins++;
    } else {
      falsePositives++;
      if (falsePositives <= 3) {
        console.log(`  [Divergence] ID=${orig.id} True: "${orig.address || orig.a}" (${orig._lat}, ${orig._lng})`);
        console.log(`               Matched: ID=${matchRes.station.id} "${matchRes.station.address || matchRes.station.a}" (${matchRes.lat}, ${matchRes.lng}) Dist: ${Math.round(dist)}m Score: ${matchRes.score}`);
      }
    }
  }
}

const elapsedMs = Date.now() - startTime;
const throughput = Math.round((testSet.length / (elapsedMs / 1000)));

errorDistances.sort((a, b) => a - b);
const medianDist = errorDistances.length ? errorDistances[Math.floor(errorDistances.length / 2)] : 0;
const p90Dist = errorDistances.length ? errorDistances[Math.floor(errorDistances.length * 0.90)] : 0;
const p99Dist = errorDistances.length ? errorDistances[Math.floor(errorDistances.length * 0.99)] : 0;

console.log('\n================================================================');
console.log('                     BENCHMARK SUMMARY RESULTS                  ');
console.log('================================================================');
console.log(`Total stations evaluated      : ${testSet.length}`);
console.log(`Total successfully reconciled : ${totalMatched} / ${testSet.length} (${((100 * totalMatched) / testSet.length).toFixed(1)}%)`);
console.log(`Exact GPS Pin Match (< 25m)   : ${exactPins} / ${testSet.length} (${((100 * exactPins) / testSet.length).toFixed(1)}%)`);
console.log(`False Positive Divergence     : ${falsePositives} / ${testSet.length} (${((100 * falsePositives) / testSet.length).toFixed(1)}%)`);
console.log(`Median GPS deviation          : ${medianDist.toFixed(1)} meters`);
console.log(`90th percentile deviation     : ${p90Dist.toFixed(1)} meters`);
console.log(`99th percentile deviation     : ${p99Dist.toFixed(1)} meters`);
console.log(`Processing speed              : ${throughput} stations/second (${elapsedMs} ms total)`);
console.log('================================================================\n');

if (edgeCasePassed === edgeCases.length && (exactPins / testSet.length) >= 0.95) {
  console.log('[SUCCESS] Benchmark passed with >= 95% accuracy and 100% edge case handling!');
  process.exit(0);
} else {
  console.error('[FAILURE] Accuracy threshold not met.');
  process.exit(1);
}
