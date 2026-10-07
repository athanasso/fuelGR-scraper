/**
 * Production Spatial Coordinate Reconciliation Engine
 * 
 * Maps uncoordinated Greek gas station listings (from Ministry tables,
 * third-party feeds, or government portals) to verified GPS pins (lat, lng)
 * using multi-signal fuzzy matching, Greek diacritic stripping, and brand aliasing.
 * 
 * Supports both verbose JSON ({ name, brand, address, prefecture }) and
 * minified schema ({ n, b, a, pref, lat, lng }).
 */

const fs = require('fs');
const path = require('path');

// Normalizes Greek text: strips accents, handles final sigma, uppercase
function stripAccents(text) {
  if (!text) return '';
  let s = String(text).toUpperCase();
  const map = {
    'Ά': 'Α', 'Έ': 'Ε', 'Ή': 'Η', 'Ί': 'Ι', 'Ό': 'Ο', 'Ύ': 'Υ', 'Ώ': 'Ω',
    'Ϊ': 'Ι', 'Ϋ': 'Υ', 'ΐ': 'Ι', 'ΰ': 'Υ', 'ς': 'Σ'
  };
  s = s.replace(/[ΆΈΉΊΌΎΏΪΫΐΰς]/g, m => map[m] || m);
  // Strip special symbols, keep Greek, Latin letters, numbers, spaces
  s = s.replace(/[^A-ZΑ-Ω0-9\s]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Strips Greek legal and corporate company suffixes
function cleanCorporateTypes(text) {
  let s = stripAccents(text);
  const suffixes = [
    /\bΟ\s?Ε\b/g, /\bΕ\s?Ε\b/g, /\bΕ\s?Π\s?Ε\b/g, /\bΙ\s?Κ\s?Ε\b/g,
    /\bΑ\s?Ε\b/g, /\bΜΟΝ\s?ΕΠΕ\b/g, /\bΜΟΝΟΠΡΟΣΩΠΗ\b/g,
    /\bΚΑΙ\s+ΣΙΑ\b/g, /\b&amp;\b/g, /\bΣΙΑ\b/g
  ];
  for (const regex of suffixes) {
    s = s.replace(regex, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Greek and Latin brand equivalence classes
const BRAND_ALIASES = {
  'SHELL': ['SHELL', 'ΣΕΛ', 'CORAL', 'ΚΟΡΑΛ'],
  'EKO': ['EKO', 'ΕΚΟ', 'HELLENIC', 'ΕΛΛΗΝΙΚΑ ΚΑΥΣΙΜΑ'],
  'BP': ['BP', 'ΜΠΙ ΠΙ', 'ΜΠΙΠΙ', 'HELLENIC'],
  'AVIN': ['AVIN', 'ΑΒΙΝ', 'MOTOR OIL', 'ΜΟΤΟΡ ΟΙΛ'],
  'REVOIL': ['REVOIL', 'ΡΕΒΟΙΛ'],
  'AEGEAN': ['AEGEAN', 'ΑΙΓΑΙΟ', 'ΑΙΓΑΙΟΝ'],
  'ELIN': ['ELIN', 'ΕΛΙΝ', 'ΕΛΙΝΟΙΛ'],
  'CYCLON': ['CYCLON', 'ΣΥΚΛΟΝ'],
  'JETOIL': ['JETOIL', 'ΤΖΕΤ ΟΙΛ', 'ΤΖΕΤ'],
  'SILKOIL': ['SILKOIL', 'ΣΙΛΚ ΟΙΛ', 'ΣΙΛΚ'],
  'ETEKA': ['ETEKA', 'ΕΤΕΚΑ'],
  'ΑΝΕΞΑΡΤΗΤΟ': ['ΑΝΕΞΑΡΤΗΤΟ', 'INDEPENDENT', 'ΑΡΥΣ']
};

function brandSimilarity(b1, b2) {
  const nb1 = stripAccents(b1);
  const nb2 = stripAccents(b2);
  if (!nb1 || !nb2) return 0.5;
  if (nb1 === nb2) return 1.0;

  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    const in1 = aliases.some(a => nb1.includes(a));
    const in2 = aliases.some(a => nb2.includes(a));
    if (in1 && in2) return 1.0;
  }
  return stringSimilarity(nb1, nb2);
}

// Extract street tokens and numbers / km markers from Greek address
function extractStreetAndNumber(addr) {
  let norm = stripAccents(addr);
  // Strip highway / street prefixes
  norm = norm.replace(/\b(ΛΕΩΦΟΡΟΣ|ΛΕΩΦ|ΟΔΟΣ|ΕΘΝΙΚΗ\s+ΟΔΟΣ|ΕΘΝΙΚΗ|ΕΘΝ|Ε\s?Ο|ΕΠΑΡΧΙΑΚΗ|ΠΕΟ|ΝΕΟ)\b/g, ' ');

  // Extract kilometer marker or house number
  let number = null;
  const kmMatch = norm.match(/(\d+[\.,]?\d*)\s*(?:Ο\s*)?(?:ΧΛΜ|ΧΙΛ|KM)\b/i) || norm.match(/(?:ΧΛΜ|ΧΙΛ|KM)\s*(\d+[\.,]?\d*)/i);
  if (kmMatch) {
    number = 'KM' + kmMatch[1].replace(',', '.');
  } else {
    const numMatch = norm.match(/\b(\d+)\b/);
    if (numMatch) number = numMatch[1];
  }

  // Tokens of length >= 3
  const words = norm.split(/\s+/).filter(w => w.length >= 3 && !w.match(/^\d+$/));
  return { words: new Set(words), number };
}

// Ratcliff-Obershelp & Levenshtein hybrid similarity
function stringSimilarity(s1, s2) {
  if (!s1 || !s2) return 0.0;
  if (s1 === s2) return 1.0;
  const l1 = s1.length;
  const l2 = s2.length;
  const maxLen = Math.max(l1, l2);
  if (maxLen === 0) return 1.0;

  // Simple Bigram Dice Coefficient for speed and typo resilience
  if (l1 < 2 || l2 < 2) return s1 === s2 ? 1.0 : 0.0;
  const bigrams1 = new Set();
  for (let i = 0; i < l1 - 1; i++) bigrams1.add(s1.substring(i, i + 2));
  let intersection = 0;
  for (let i = 0; i < l2 - 1; i++) {
    const bg = s2.substring(i, i + 2);
    if (bigrams1.has(bg)) intersection++;
  }
  return (2.0 * intersection) / (l1 + l2 - 2);
}

// Great-circle distance between coordinates in meters
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000.0;
  const dLat = (lat2 - lat1) * Math.PI / 180.0;
  const dLon = (lon2 - lon1) * Math.PI / 180.0;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180.0) * Math.cos(lat2 * Math.PI / 180.0) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return R * c;
}

class CoordinateMatcher {
  constructor(baselineStationsOrPath) {
    if (typeof baselineStationsOrPath === 'string') {
      const raw = fs.readFileSync(baselineStationsOrPath, 'utf8');
      this.stations = JSON.parse(raw);
    } else if (Array.isArray(baselineStationsOrPath)) {
      this.stations = baselineStationsOrPath;
    } else {
      throw new Error('Invalid baseline stations source.');
    }

    this.indexByPrefecture = new Map();
    this.precomputeBaseline();
  }

  precomputeBaseline() {
    for (const s of this.stations) {
      const lat = s.lat != null ? Number(s.lat) : (s.latitude != null ? Number(s.latitude) : null);
      const lng = s.lng != null ? Number(s.lng) : (s.longitude != null ? Number(s.longitude) : null);
      s._lat = lat;
      s._lng = lng;

      const pref = stripAccents(s.prefecture || s.pref || 'UNKNOWN');
      if (!this.indexByPrefecture.has(pref)) {
        this.indexByPrefecture.set(pref, []);
      }

      const rawAddr = s.address || s.a || '';
      const rawName = s.name || s.owner || s.n || '';
      const rawBrand = s.brand || s.b || '';

      const { words, number } = extractStreetAndNumber(rawAddr);
      s._meta = {
        cleanName: cleanCorporateTypes(rawName),
        addrWords: words,
        number: number,
        normBrand: stripAccents(rawBrand)
      };

      this.indexByPrefecture.get(pref).push(s);
    }
  }

  matchStation(record, minConfidence = 0.65) {
    const pref = stripAccents(record.prefecture || record.pref || '');
    let candidates = this.indexByPrefecture.get(pref);
    if (!candidates || candidates.length === 0) {
      candidates = this.stations; // fallback nationwide
    }

    const recBrand = record.brand || record.b || '';
    const recOwner = cleanCorporateTypes(record.owner || record.name || record.n || '');
    const { words: recWords, number: recNumber } = extractStreetAndNumber(record.address || record.a || '');

    let bestStation = null;
    let bestScore = 0.0;
    let bestBreakdown = null;

    for (const cand of candidates) {
      if (cand._lat == null || cand._lng == null) continue;
      const meta = cand._meta;

      // 1. Brand Score (weight 0.30)
      const bScore = brandSimilarity(recBrand, meta.normBrand);

      // 2. Address & Number Score (weight 0.45)
      let commonCount = 0;
      for (const w of recWords) {
        if (meta.addrWords.has(w)) commonCount++;
      }
      const unionSize = new Set([...recWords, ...meta.addrWords]).size;
      const addrJaccard = unionSize > 0 ? (commonCount / unionSize) : 0.0;

      let numScore = 0.5; // neutral if neither has number
      if (recNumber && meta.number) {
        numScore = (recNumber === meta.number) ? 1.0 : 0.0;
      } else if (!recNumber && !meta.number) {
        numScore = 0.8;
      }
      const addrCombined = (addrJaccard * 0.70) + (numScore * 0.30);

      // 3. Owner Score (weight 0.25)
      let ownerScore = 0.5;
      if (recOwner && meta.cleanName) {
        ownerScore = stringSimilarity(recOwner, meta.cleanName);
      }

      const totalScore = (bScore * 0.30) + (addrCombined * 0.45) + (ownerScore * 0.25);

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestStation = cand;
        bestBreakdown = {
          brandScore: Math.round(bScore * 100) / 100,
          addrScore: Math.round(addrCombined * 100) / 100,
          ownerScore: Math.round(ownerScore * 100) / 100,
          totalScore: Math.round(totalScore * 1000) / 1000
        };
      }
    }

    if (!bestStation || bestScore < minConfidence) {
      // If prefecture search produced a weak result, fallback nationwide
      if (candidates !== this.stations) {
        return this.matchStation({ ...record, prefecture: '', pref: '' }, minConfidence);
      }
      return { matched: false, station: null, score: bestScore, breakdown: bestBreakdown };
    }

    return {
      matched: true,
      station: bestStation,
      score: bestScore,
      breakdown: bestBreakdown,
      lat: bestStation._lat,
      lng: bestStation._lng
    };
  }

  reconcileDataset(uncoordinatedList, minConfidence = 0.65) {
    let matchedCount = 0;
    const reconciled = uncoordinatedList.map(rec => {
      const res = this.matchStation(rec, minConfidence);
      if (res.matched) {
        matchedCount++;
        return {
          ...rec,
          id: rec.id || res.station.id,
          lat: res.lat,
          lng: res.lng,
          latitude: res.lat,
          longitude: res.lng,
          matched_station_id: res.station.id,
          match_confidence: res.score
        };
      }
      return { ...rec, lat: null, lng: null, match_confidence: res.score };
    });

    return {
      total: uncoordinatedList.length,
      matched: matchedCount,
      matchRatePct: (100 * matchedCount) / (uncoordinatedList.length || 1),
      stations: reconciled
    };
  }
}

module.exports = {
  CoordinateMatcher,
  stripAccents,
  cleanCorporateTypes,
  brandSimilarity,
  extractStreetAndNumber,
  stringSimilarity,
  haversineM
};
