# fuelGR Scraper & Daily Dataset Pipeline

Automated nationwide fuel price scraper and Google Reviews enrichment pipeline for Greece. Sourced from official Ministry of Development daily bulletins (fuelprices.gr) and the public web API.

Publishes minified JSON and zstandard-compressed (`.zst`) datasets directly to **GitHub Releases**, optimized for low-bandwidth consumption by mobile applications.

---

## Direct API & Download Links

Mobile applications can consume the latest datasets directly via GitHub Release CDN:

| Dataset | CDN Link | Format | Description |
|---|---|---|---|
| **Stations (Minified)** | [`stations_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json) | JSON | 4,700+ stations with live prices, 7d deltas, 14d sparklines, and embedded Google ratings (`mr`, `mc`) |
| **Stations (Zstandard)** | [`stations_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json.zst) | Zstandard | High-compression master dataset (~175 KB) |
| **Google Reviews** | [`reviews.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/reviews.min.json) | JSON | Station Google Maps ratings and review counts keyed by station ID |
| **Google Reviews (Zstandard)** | [`reviews.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/reviews.min.json.zst) | Zstandard | Compressed reviews dataset (~22 KB) |
| **Price Ledger** | [`price_ledger.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/price_ledger.min.json) | JSON | Historical per-station daily prices accumulated over time |
| **Price Ledger (Zstandard)** | [`price_ledger.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/price_ledger.min.json.zst) | Zstandard | Compressed rolling price ledger (~44 KB) |
| **Prefectures (Minified)** | [`prefectures_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json) | JSON | 51 Greek prefectures daily fuel averages |
| **Prefectures (Zstandard)** | [`prefectures_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json.zst) | Zstandard | High-compression regional averages (~1.4 KB) |

---

## Automated Workflows

The repository uses two separated GitHub Actions workflows for maximum reliability:

### 1. Daily Fuel Prices & Release Builder ([`update-database.yml`](.github/workflows/update-database.yml))
Runs daily at **14:00 EEST (11:00 UTC)**:
- **`scraper.py`**: Fetches and parses government PDF bulletins for regional averages (Unleaded 95, 100, Diesel, LPG).
- **`scraper.js`**: Queries 4,700+ stations nationwide via `fuelgr.gr/web/api/data.php` using mocked browser localStorage payload.
- **`package_dataset.py`**: Normalizes schema, accumulates daily ledger history, calculates 7-day price deltas & 14-day sparklines, embeds Google Reviews, and compresses with zstandard.
- **GitHub Releases**: Publishes release tagged by date (e.g. `2026-09-17`) marked as `--latest`.

### 2. Bi-Weekly Google Reviews Enrichment ([`scrape-reviews.yml`](.github/workflows/scrape-reviews.yml))
Runs every 2 weeks on the **1st and 15th of each month at 03:00 UTC** (also triggerable via `workflow_dispatch`):
- **`reviews_scraper.js`**: Stealth Playwright automation querying Greek Google Maps for station ratings and review counts.
- **Anti-Bot Protections**: Single browser context (`concurrency=1`), 6–12s randomized human delay, mouse scroll emulation, and automatic CAPTCHA backoff.
- **Urban Prioritization**: Queues Athens, Attica, Thessaloniki, and major prefectures first.
- **Release Update**: Uploads updated `reviews.min.json` and `stations_latest.min.json` to the latest GitHub Release.

---

## Local Development

### Requirements
- Node.js 20+
- Python 3.10+
- Playwright Chromium (for reviews scraper)

### Setup
```bash
pip install -r requirements.txt
npm install
npx playwright install --with-deps chromium
```

### Available Commands
```bash
# Run prefecture averages scraper
python scraper.py

# Run station price scraper
npm run scrape

# Run Google Reviews scraper (slow stealth mode)
npm run scrape:reviews

# Run Google Reviews scraper with custom limits
node reviews_scraper.js --limit 50 --concurrency 1 --delay-min 5000 --delay-max 10000

# Package and compress artifacts into dist/
python package_dataset.py
```
