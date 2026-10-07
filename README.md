# fuelGR Scraper & Daily Dataset Pipeline

Automated nationwide fuel price scraper and Google Reviews enrichment pipeline for Greece. Sourced from deixto.gr mobile backend with automated dual fallback to the official Ministry of Development (fuelprices.mindev.gov.gr) and e-Katanalotis.

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
| **EV Chargers (Minified)** | [`chargers_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/chargers_latest.min.json) | JSON | 4,300+ Greek EV charging hubs with real-time OCPI status, connectors, tariffs, and operators |
| **EV Chargers (Zstandard)** | [`chargers_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/chargers_latest.min.json.zst) | Zstandard | Compressed EV dataset (~195 KB) |

---

## Automated Workflows

The repository uses three automated GitHub Actions workflows for maximum reliability:

### 1. Twice-Daily Fuel Prices & Release Builder ([`update-database.yml`](.github/workflows/update-database.yml))
Scheduled **07:17 & 15:23 EEST** with backups **08:47 & 16:53** (GitHub cron often skips mornings; backups catch drops):
- **`scraper.py`**: Fetches and parses government PDF bulletins for regional averages (Unleaded 95, 100, Diesel, LPG).
- **`scraper.js`**: Primary nationwide station price scraper querying `deixto.gr` (fuelGR mobile backend; no Cloudflare). Dense ~22 km mesh + per-station backfill for all fuels; coverage gates refuse thin publishes.
- **`fallback_scraper.js`**: Automatic multi-tier government fallback pipeline if primary `deixto.gr` is unreachable or fails coverage gates:
  1. **Fallback 1 (Government Station Listings + `coordinate_matcher.js`)**: Probes live consumer observatory feeds (e-Katanalotis / Ministry tables) and executes production spatial reconciliation engine (`CoordinateMatcher`) to map uncoordinated station prices to verified physical GPS pins (Greek diacritic stripping, corporate suffix removal, brand aliasing, and highway km extraction).
  2. **Fallback of the Fallback (Official Ministry Bulletins - `fuelprices.mindev.gov.gr`)**: Parses official Ministry of Development daily prefecture price bulletins (open PDF files immune to anti-bot blocks), normalizes all 54 Greek prefecture forms, and maps fresh benchmark prices across all 4,700+ verified station pins.
  3. **Disaster Recovery**: Automatically restores previous release dataset from GitHub Releases if upstream government networks are fully offline.
- **`scraper_ev.py`**: Queries the official Greek Ministry of Infrastructure & Transport (Μ.Υ.Φ.Α.Η.) OCPI 2.2 National Access Point (IDRO) static and dynamic feeds for 4,300+ EV charging hubs nationwide.
- **`package_dataset.py`**: Normalizes schema, accumulates daily ledger history, calculates 7-day price deltas & 14-day sparklines, embeds Google Reviews, packages EV chargers, and compresses with zstandard.
- **GitHub Releases**: Publishes release tagged by date (e.g. `2026-09-17`) marked as `--latest`.

### 2. Twice-Daily Google Reviews Enrichment ([`scrape-reviews.yml`](.github/workflows/scrape-reviews.yml))
Scheduled **09:19 & 17:27 EEST** with backups **10:49 & 18:57** (~2h after price primaries), also triggerable via `workflow_dispatch`:
- **`reviews_scraper.js`**: Stealth Playwright automation querying Greek Google Maps for station ratings and review counts.
- **Anti-Bot Protections**: Single browser context (`concurrency=1`), randomized human delay, mouse scroll emulation, and automatic CAPTCHA backoff.
- **Urban Prioritization**: Queues Athens, Attica, Thessaloniki, and major prefectures first.
- **Release Update**: Uploads updated `reviews.min.json` and `stations_latest.min.json` to the latest GitHub Release.

### 3. Hourly EV Charger Status Updater ([`update-chargers.yml`](.github/workflows/update-chargers.yml))
Scheduled hourly at :20 UTC (`20 * * * *`), also triggerable via `workflow_dispatch`:
- **`scraper_ev.py`**: Queries the official Greek Ministry of Infrastructure & Transport (Μ.Υ.Φ.Α.Η. / OCPI 2.2 National Access Point) for real-time connector availability, tariffs, and EVSE status updates across all Greek CPO networks.
- **Fast Packaging**: Regroups EV data into normalized schema, generates minified `chargers_latest.min.json`, and compresses with zstandard (`.zst`).
- **In-Place Release Update**: Uploads refreshed charger datasets directly to the active `--latest` GitHub Release without waiting for or disrupting twice-daily fuel runs.

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

# Run station price scraper (primary deixto.gr backend)
npm run scrape

# Run emergency fallback scraper (cascading government fallback pipeline)
npm run scrape:fallback
# or: node fallback_scraper.js

# Run spatial coordinate reconciliation test suite (250 stations, 100% accuracy benchmark)
npm run test:matcher

# Run end-to-end multi-tier government fallback pipeline test
npm run test:fallback

# Run EV charging stations scraper (Greek Ministry OCPI feeds)
npm run scrape:ev
# or: python scraper_ev.py

# Run Google Reviews scraper (slow stealth mode)
npm run scrape:reviews

# Run Google Reviews scraper with custom limits
node reviews_scraper.js --limit 50 --concurrency 1 --delay-min 5000 --delay-max 10000

# Package and compress artifacts into dist/
python package_dataset.py
```

---

## Windows Task Scheduler Automation

Station prices are scraped from `deixto.gr` (no Cloudflare). Local Windows Task Scheduler remains the most reliable publisher path for long mesh+backfill runs and release uploads.

The repository includes a turnkey Windows Task Scheduler integration that automates the entire scraping, packaging, and GitHub Releases publishing workflow with zero maintenance.

### Recommended Schedule Rationale

| Task | Frequency | Time (Greek Local / EEST) | Why |
| :--- | :--- | :--- | :--- |
| **`FuelGR-DailyScraper`** | Twice daily | **08:00** & **16:00** | Greek gas stations are legally mandated to submit price updates to the Ministry of Development (`fuelprices.gr` / e-Katanalotis) in the early morning (06:00–07:30) and afternoon (14:00–15:30). Running at 08:00 and 16:00 captures all updates in time for morning and evening commutes. |
| **`FuelGR-EVHourly`** | Every 1 hour | **00:00–23:00 (Hourly)** | Electric vehicle chargers report dynamic live connector status (`available`, `occupied`, `out_of_service`) from official Ministry (MYFAH/IDRO) OCPI feeds. The task runs in ~25 seconds and uploads directly to the active release with `--clobber`. |

Both tasks are configured with:
- **`Hidden` Window Style**: Completely silent execution in the background (no popup windows stealing focus).
- **`StartWhenAvailable`**: If your PC was turned off or asleep during a scheduled run, Task Scheduler runs the missed job immediately upon waking up.
- **Battery Support**: Enabled for laptops on battery (`AllowStartIfOnBatteries`).
- **Single Instance**: Prevents overlapping runs (`MultipleInstances IgnoreNew`).
- **Transcript Logging**: All output is automatically logged with timestamps to `logs/scraper_daily.log` and `logs/ev_hourly.log`.

### Setup & Installation

Run once from PowerShell (or terminal):

```powershell
# Using npm script:
npm run tasks:setup

# Or directly in PowerShell:
powershell -ExecutionPolicy Bypass -File .\setup-tasks.ps1
```

### Checking Status & Logs

```powershell
# Inspect registered task status:
Get-ScheduledTask -TaskName "FuelGR-*" | Select-Object TaskName, State, LastRunTime, NextRunTime

# Manually trigger a run anytime:
Start-ScheduledTask -TaskName "FuelGR-DailyScraper"
Start-ScheduledTask -TaskName "FuelGR-EVHourly"

# Live-tail execution logs:
Get-Content logs\scraper_daily.log -Tail 30 -Wait
Get-Content logs\ev_hourly.log -Tail 30 -Wait
```

### Removing Scheduled Tasks

```powershell
npm run tasks:remove
# or:
powershell -ExecutionPolicy Bypass -File .\remove-tasks.ps1
```
