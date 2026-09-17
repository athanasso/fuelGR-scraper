#!/usr/bin/env python3
"""
package_dataset.py

Packages fuelGR dataset artifacts for GitHub Release and static hosting.
1. Normalizes and minifies master station dataset into high-efficiency mobile schema.
2. Accumulates REAL daily prices into a rolling ledger (no simulated sparklines).
3. Embeds 7-day deltas and 14-day sparklines derived from the ledger.
4. Writes per-station history/{id}.json + price_ledger.min.json for the app.
5. Compresses artifacts using zstandard (.zst).
6. Generates release_notes.md and tag.txt for GitHub Release publishing.
"""

from __future__ import annotations

import datetime
import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

# Fuel type mapping to compact keys
FUEL_KEY_MAP = {
    "1": "u95",   # Unleaded 95
    "2": "u100",  # Unleaded 100
    "4": "d",     # Diesel
    "5": "dh",    # Heating Diesel
    "6": "lpg",   # LPG / Autogas
    "8": "cng",   # CNG
}

FUEL_KEYS = ("u95", "u100", "d", "dh", "lpg", "cng")
LEDGER_MAX_DAYS = 365
SPARKLINE_DAYS = 14
RELEASE_LEDGER_URL = (
    "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/price_ledger.min.json"
)
RELEASE_STATIONS_URL = (
    "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json"
)


def compress_zstd(source_path: Path, dest_path: Path):
    """Compress file using python zstandard library or fallback to zstd CLI."""
    try:
        import zstandard as zstd

        cctx = zstd.ZstdCompressor(level=19)
        with open(source_path, "rb") as f_in, open(dest_path, "wb") as f_out:
            cctx.copy_stream(f_in, f_out)
        print(f"  [zstd-lib] Compressed {source_path.name} -> {dest_path.name} ({dest_path.stat().st_size} bytes)")
        return
    except ImportError:
        pass

    zstd_bin = shutil.which("zstd")
    if zstd_bin:
        res = subprocess.run(
            [zstd_bin, "-19", "-f", str(source_path), "-o", str(dest_path)],
            capture_output=True,
        )
        if res.returncode == 0:
            print(
                f"  [zstd-cli] Compressed {source_path.name} -> {dest_path.name} ({dest_path.stat().st_size} bytes)"
            )
            return

    print(f"  [!] Warning: zstandard not available; {dest_path.name} not generated.")


def fetch_json(url: str, timeout: int = 60):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "fuelGR-scraper/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if getattr(resp, "status", 200) >= 400:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  [!] Could not fetch {url}: {e}")
        return None


def extract_prices(raw: dict) -> dict:
    prices = {}
    raw_fuels = raw.get("fuels") or {}
    for fid, fobj in raw_fuels.items():
        key = FUEL_KEY_MAP.get(str(fid))
        if key and isinstance(fobj, dict):
            pr = fobj.get("price")
            if pr is not None and float(pr) > 0:
                prices[key] = round(float(pr), 3)

    # Already-compact master schema (from a previous release)
    if not prices and isinstance(raw.get("p"), dict):
        for k, v in raw["p"].items():
            if k in FUEL_KEYS and isinstance(v, (int, float)) and v > 0:
                prices[k] = round(float(v), 3)

    if "u95" not in prices and raw.get("price") and raw.get("price") > 0:
        ft = str(raw.get("fuel_type", "")).lower()
        if "diesel" in ft:
            prices["d"] = round(float(raw["price"]), 3)
        elif "lpg" in ft or "autogas" in ft:
            prices["lpg"] = round(float(raw["price"]), 3)
        elif "100" in ft:
            prices["u100"] = round(float(raw["price"]), 3)
        else:
            prices["u95"] = round(float(raw["price"]), 3)

    return prices


def normalize_ledger(raw_ledger) -> dict[str, list[dict]]:
    """Accept either {stations:{id:[...]}} or flat {id:[...]}."""
    if not isinstance(raw_ledger, dict):
        return {}
    stations = raw_ledger.get("stations") if isinstance(raw_ledger.get("stations"), dict) else raw_ledger
    out: dict[str, list[dict]] = {}
    for sid, records in stations.items():
        if sid in ("updated", "stations"):
            continue
        if not isinstance(records, list):
            continue
        cleaned = []
        for rec in records:
            if not isinstance(rec, dict) or not rec.get("date"):
                continue
            row = {"date": str(rec["date"])[:10]}
            for k in FUEL_KEYS:
                v = rec.get(k)
                if isinstance(v, (int, float)) and v > 0:
                    row[k] = round(float(v), 3)
            if len(row) > 1:
                cleaned.append(row)
        cleaned.sort(key=lambda r: r["date"])
        # de-dupe by date (keep last)
        by_date = {r["date"]: r for r in cleaned}
        out[str(sid)] = [by_date[d] for d in sorted(by_date.keys())][-LEDGER_MAX_DAYS:]
    return out


def seed_ledger_from_stations(stations: list) -> dict[str, list[dict]]:
    """Bootstrap ledger from a previous stations snapshot (one day each)."""
    ledger: dict[str, list[dict]] = {}
    for s in stations:
        sid = str(s.get("id") or s.get("n") or "").strip()
        if not sid:
            continue
        prices = extract_prices(s)
        if not prices:
            continue
        date = str(s.get("dt") or s.get("last_updated") or "")[:10]
        if not date:
            continue
        row = {"date": date, **prices}
        ledger[sid] = [row]
    return ledger


def load_previous_ledger(data_dir: Path) -> dict[str, list[dict]]:
    local = data_dir / "price_ledger.min.json"
    if local.exists():
        try:
            with open(local, "r", encoding="utf-8") as f:
                ledger = normalize_ledger(json.load(f))
            if ledger:
                print(f"  [OK] Loaded local ledger ({len(ledger)} stations).")
                return ledger
        except Exception as e:
            print(f"  [!] Local ledger unreadable: {e}")

    remote = fetch_json(RELEASE_LEDGER_URL)
    if remote:
        ledger = normalize_ledger(remote)
        if ledger:
            print(f"  [OK] Loaded CDN ledger ({len(ledger)} stations).")
            return ledger

    # First-run bootstrap: previous station prices become day-0 history
    prev_stations = fetch_json(RELEASE_STATIONS_URL)
    if isinstance(prev_stations, list) and prev_stations:
        ledger = seed_ledger_from_stations(prev_stations)
        print(f"  [OK] Bootstrapped ledger from previous stations ({len(ledger)} stations).")
        return ledger

    print("  [!] No previous ledger found — starting fresh (history grows daily).")
    return {}


def append_today(ledger: dict[str, list[dict]], station_id: str, today: str, prices: dict):
    if not prices:
        return
    records = ledger.get(station_id, [])
    row = {"date": today, **prices}
    if records and records[-1].get("date") == today:
        records[-1] = row
    else:
        records.append(row)
    ledger[station_id] = records[-LEDGER_MAX_DAYS:]


def sparkline_and_delta(records: list[dict], fuel_key: str, today_price: float):
    """Build real 14d sparkline + 7d delta from ledger; never invent prices."""
    series = []
    for rec in records:
        v = rec.get(fuel_key)
        if isinstance(v, (int, float)) and v > 0:
            series.append(round(float(v), 3))

    if not series:
        series = [today_price]

    # Ensure today's price is the tip
    if series[-1] != today_price:
        series.append(today_price)

    sp = series[-SPARKLINE_DAYS:]
    # Pad short history by repeating earliest known real price (not noise)
    while len(sp) < min(2, SPARKLINE_DAYS) and sp:
        sp = [sp[0]] + sp

    d7 = None
    if len(series) >= 8:
        d7 = round(today_price - series[-8], 3)
    elif len(series) >= 2:
        d7 = round(today_price - series[0], 3)

    return sp, d7


def build_master_and_history(raw: dict, today: str, ledger: dict[str, list[dict]], reviews: dict[str, dict] | None = None):
    st_id = str(raw.get("id", "")).strip()
    name = str(raw.get("name", "")).strip()
    brand = str(raw.get("brand", "")).strip() or "Ανεξάρτητο"
    address = str(raw.get("address", "")).strip()
    prefecture = str(raw.get("prefecture", "")).strip()
    municipality = str(raw.get("municipality", "")).strip()
    lat = raw.get("latitude")
    lng = raw.get("longitude")
    last_updated = raw.get("last_updated") or today

    # Compact schema passthrough when packaging already-minified input
    if raw.get("n") and raw.get("p"):
        name = str(raw.get("n") or name).strip()
        brand = str(raw.get("b") or brand).strip() or "Ανεξάρτητο"
        address = str(raw.get("a") or address).strip()
        prefecture = str(raw.get("pref") or prefecture).strip()
        municipality = str(raw.get("mun") or municipality).strip()
        lat = raw.get("lat", lat)
        lng = raw.get("lng", lng)
        last_updated = raw.get("dt") or last_updated

    prices = extract_prices(raw)
    append_today(ledger, st_id, today, prices)
    records = ledger.get(st_id, [])

    sparklines = {}
    d7_deltas = {}
    for fkey, base_price in prices.items():
        sp, d7 = sparkline_and_delta(records, fkey, base_price)
        sparklines[fkey] = sp
        if d7 is not None:
            d7_deltas[fkey] = d7

    master_item = {
        "id": st_id,
        "n": name,
        "b": brand,
        "a": address,
        "pref": prefecture,
        "mun": municipality,
        "lat": lat,
        "lng": lng,
        "p": prices,
        "d7": d7_deltas,
        "sp": sparklines,
        "dt": last_updated if isinstance(last_updated, str) else today,
    }
    if reviews and st_id in reviews:
        rev = reviews[st_id]
        if isinstance(rev, dict):
            if rev.get("rating") is not None:
                master_item["mr"] = round(float(rev["rating"]), 1)
            if rev.get("reviews") is not None:
                master_item["mc"] = int(rev["reviews"])

    detailed_history = {
        "id": st_id,
        "brand": brand,
        "name": name,
        "address": address,
        "prefecture": prefecture,
        "history": records,
    }

    return master_item, detailed_history


def format_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def count_fuel_coverage(master_stations: list) -> dict:
    keys = ("u95", "u100", "d", "lpg", "dh", "cng")
    counts = {k: 0 for k in keys}
    for s in master_stations:
        prices = s.get("p") or {}
        for k in keys:
            val = prices.get(k)
            if isinstance(val, (int, float)) and val > 0:
                counts[k] += 1
    return counts


def main():
    base_dir = Path(__file__).resolve().parent
    data_dir = base_dir / "data"
    dist_dir = base_dir / "dist"
    history_dir = dist_dir / "history"

    dist_dir.mkdir(parents=True, exist_ok=True)
    history_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    tag = today

    # 1. Process Prefectures
    pref_file = data_dir / "prefectures_latest.json"
    pref_data = []
    if pref_file.exists():
        with open(pref_file, "r", encoding="utf-8") as f:
            pref_data = json.load(f)

        with open(dist_dir / "prefectures_latest.json", "w", encoding="utf-8") as f:
            json.dump(pref_data, f, ensure_ascii=False, indent=2)

        pref_min_file = dist_dir / "prefectures_latest.min.json"
        with open(pref_min_file, "w", encoding="utf-8") as f:
            json.dump(pref_data, f, ensure_ascii=False, separators=(",", ":"))

        compress_zstd(pref_min_file, dist_dir / "prefectures_latest.min.json.zst")
    else:
        print(f"[!] Warning: {pref_file} not found.")

    # 2. Process Stations + real ledger
    station_file = data_dir / "stations_latest.min.json"
    raw_stations = []
    master_stations = []
    if station_file.exists():
        with open(station_file, "r", encoding="utf-8") as f:
            raw_stations = json.load(f)

        print(f"Transforming {len(raw_stations)} stations with real price history...")
        ledger = load_previous_ledger(data_dir)

        # Load Google Reviews
        reviews_data = {}
        rev_file = data_dir / "reviews.min.json"
        if rev_file.exists():
            try:
                with open(rev_file, "r", encoding="utf-8") as f_rev:
                    reviews_data = json.load(f_rev)
                print(f"  [OK] Loaded local reviews ({len(reviews_data)} stations).")
            except Exception as e:
                print(f"  [!] Local reviews unreadable: {e}")
        if not reviews_data:
            remote_rev = fetch_json("https://github.com/athanasso/fuelGR-scraper/releases/latest/download/reviews.min.json")
            if isinstance(remote_rev, dict):
                reviews_data = remote_rev
                print(f"  [OK] Loaded CDN reviews ({len(reviews_data)} stations).")

        if reviews_data:
            with open(dist_dir / "reviews.min.json", "w", encoding="utf-8") as f_rev_dist:
                json.dump(reviews_data, f_rev_dist, ensure_ascii=False, separators=(",", ":"))
            compress_zstd(dist_dir / "reviews.min.json", dist_dir / "reviews.min.json.zst")

        for raw in raw_stations:
            master_item, detail_history = build_master_and_history(raw, today, ledger, reviews_data)
            master_stations.append(master_item)

            hist_file = history_dir / f"{master_item['id']}.json"
            with open(hist_file, "w", encoding="utf-8") as f_hist:
                json.dump(detail_history, f_hist, ensure_ascii=False, separators=(",", ":"))

        # Persist ledger locally (for local re-runs) + release asset
        ledger_payload = {"updated": today, "stations": ledger}
        local_ledger = data_dir / "price_ledger.min.json"
        with open(local_ledger, "w", encoding="utf-8") as f:
            json.dump(ledger_payload, f, ensure_ascii=False, separators=(",", ":"))

        ledger_dist = dist_dir / "price_ledger.min.json"
        with open(ledger_dist, "w", encoding="utf-8") as f:
            json.dump(ledger_payload, f, ensure_ascii=False, separators=(",", ":"))
        compress_zstd(ledger_dist, dist_dir / "price_ledger.min.json.zst")

        station_min_file = dist_dir / "stations_latest.min.json"
        with open(station_min_file, "w", encoding="utf-8") as f:
            json.dump(master_stations, f, ensure_ascii=False, separators=(",", ":"))

        with open(dist_dir / "stations_latest.json", "w", encoding="utf-8") as f:
            json.dump(master_stations, f, ensure_ascii=False, indent=2)

        compress_zstd(station_min_file, dist_dir / "stations_latest.min.json.zst")
        print(f"[OK] Master stations dataset written ({station_min_file.stat().st_size:,} bytes).")
        print(f"[OK] Ledger stations={len(ledger)} bytes={ledger_dist.stat().st_size:,}.")
        print(f"[OK] Generated {len(raw_stations)} history files in {history_dir}.")
    else:
        print(f"[!] Warning: {station_file} not found.")

    # 3. Write tag.txt
    tag_file = dist_dir / "tag.txt"
    with open(tag_file, "w", encoding="utf-8") as f:
        f.write(tag)

    # 4. Generate release_notes.md
    notes_file = dist_dir / "release_notes.md"
    station_count = len(master_stations) if master_stations else len(raw_stations)
    pref_count = len(pref_data)
    fuel_counts = count_fuel_coverage(master_stations)

    def asset_size(name: str) -> str:
        path = dist_dir / name
        return format_bytes(path.stat().st_size) if path.exists() else "n/a"

    stations_min_size = asset_size("stations_latest.min.json")
    stations_zst_size = asset_size("stations_latest.min.json.zst")
    ledger_size = asset_size("price_ledger.min.json")

    release_notes = f"""## FuelGR Daily Dataset Release [{tag}]

Automated daily fuel prices dataset snapshot for Greece.

### Summary
- **Release Date:** {today}
- **Prefectures Tracked:** {pref_count}
- **Gas Stations Tracked:** {station_count:,}
- **Stations with Unleaded 95 (`u95`):** {fuel_counts['u95']:,}
- **Stations with Unleaded 100 (`u100`):** {fuel_counts['u100']:,}
- **Stations with Diesel (`d`):** {fuel_counts['d']:,}
- **Stations with LPG (`lpg`):** {fuel_counts['lpg']:,}
- **Stations with Heating Diesel (`dh`):** {fuel_counts['dh']:,}
- **Schema:** Real daily price ledger → 7-day deltas (`d7`) and 14-day sparklines (`sp`).

### Direct Download Links
The following assets can be fetched directly by mobile clients via GitHub Release CDN:

| File | Format | Size | Description |
|---|---|---|---|
| [`stations_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json) | JSON (Minified) | {stations_min_size} | Daily master: {station_count:,} stations with prices, `d7` deltas, and ledger-based sparklines |
| [`stations_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json.zst) | Zstandard | {stations_zst_size} | High-compression master dataset |
| [`price_ledger.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/price_ledger.min.json) | JSON (Minified) | {ledger_size} | **Source of truth for charts** — real per-station daily prices (grows each scrape) |
| [`price_ledger.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/price_ledger.min.json.zst) | Zstandard | {asset_size("price_ledger.min.json.zst")} | Compressed price ledger |
| [`prefectures_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json) | JSON (Minified) | {asset_size("prefectures_latest.min.json")} | Prefecture regional price averages |
| [`prefectures_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json.zst) | Zstandard | {asset_size("prefectures_latest.min.json.zst")} | Compressed prefecture averages |
| [`prefectures_latest.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.json) | JSON | {asset_size("prefectures_latest.json")} | Human-readable prefecture averages |

*Generated automatically by [fuelGR-scraper](https://github.com/athanasso/fuelGR-scraper).*
"""
    with open(notes_file, "w", encoding="utf-8") as f:
        f.write(release_notes.strip() + "\n")

    print(f"\n[OK] Packaged dataset for release {tag} into {dist_dir}:")
    for item in sorted(dist_dir.iterdir()):
        if item.is_file():
            print(f"  - {item.name} ({item.stat().st_size:,} bytes)")
    print(
        "Fuel coverage:",
        ", ".join(f"{k}={v:,}" for k, v in fuel_counts.items() if v > 0) or "(none)",
    )


if __name__ == "__main__":
    main()
