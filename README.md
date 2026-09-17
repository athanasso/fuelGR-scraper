# fuelGR Scraper & Daily Dataset Pipeline

Automated daily scraper and dataset release pipeline for Greek fuel prices. Scrapes prefecture-level averages from the official Ministry of Development daily bulletins (fuelprices.gr) and live station-level fuel prices.

Builds and publishes daily minified JSON and zstandard-compressed (`.zst`) datasets directly to **GitHub Releases**, designed for low-bandwidth consumption by mobile apps (fuelGR Android).

---

## Direct API & Download Links

Your mobile application can fetch the latest dataset directly using the GitHub Release CDN links below:

| Dataset | URL | Format | Description |
|---|---|---|---|
| **Stations (Minified)** | [`stations_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json) | JSON | 4,700+ station coordinates, brand, address, live price |
| **Stations (Zstandard)** | [`stations_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json.zst) | Zstandard | High-compression (~90% reduction, ~179 KB) |
| **Prefectures (Minified)** | [`prefectures_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json) | JSON | 51 Greek prefectures daily averages |
| **Prefectures (Zstandard)** | [`prefectures_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json.zst) | Zstandard | High-compression prefecture averages (~1.4 KB) |
| **Prefectures (Formatted)** | [`prefectures_latest.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.json) | JSON | Human-readable formatted snapshot |

---

## Pipeline Workflow

The automated workflow [`.github/workflows/update-database.yml`](.github/workflows/update-database.yml) runs every day at **14:00 EEST (11:00 UTC)**:

1. **`scraper.py`**: Fetches and parses today's official government PDF bulletin (`IMERISIO_DELTIO_ANA_NOMO_*.pdf`) using font regex heuristics, outputting prefecture fuel averages for Unleaded 95, Unleaded 100, Diesel, and LPG.
2. **`scraper.js`**: Scrapes 4,700+ stations nationwide via the public web API (`fuelgr.gr/web/api/data.php`) using a mocked browser `localStorage` payload and geospatial grid scan. Each grid point is queried for Unleaded 95, Unleaded 100, Diesel, Heating Diesel, and LPG (the web API returns only one fuel type per request). Avoids the Android `get_data_v4.php` endpoint, which returns honeypot (scrambled) data to unrecognized clients.
3. **`package_dataset.py`**: Minifies JSON, compresses `.zst` files with `zstandard`, and generates `release_notes.md` + `tag.txt`.
4. **GitHub Releases**: Publishes / updates release with date tag (e.g. `2026-09-17`) marked `--latest` via `gh release`.

---

## Local Usage

### Requirements
- Python 3.10+
- Node.js 18+

### Setup
```bash
pip install -r requirements.txt
```

### Run Locally
```bash
# 1. Scrape prefecture averages
python scraper.py

# 2. Scrape station prices
node scraper.js

# 3. Package and compress datasets
python package_dataset.py
```
Output files will be generated in `dist/`.
