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
import os
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path

# Fuel type mapping to compact keys
FUEL_KEY_MAP = {
    "1": "u95",   # Unleaded 95
    # "2" (Αμόλυβδη 98/100) classified by product name → u98 / u100
    "4": "d",     # Diesel (motion)
    "5": "dh",    # Heating Diesel
    "6": "lpg",   # LPG / Autogas
    "8": "cng",   # CNG
    "u98": "u98", # Unleaded 98 (from type-2 product name)
    "u100": "u100",
    "dp": "dp",   # Diesel Premium (branded; classified from diesel product name)
}

FUEL_KEYS = ("u95", "u98", "u100", "d", "dp", "dh", "lpg", "cng")

# diesel product names that are premium / special quality (same API fuel id 4)
_PREMIUM_DIESEL_RE = re.compile(
    r"v-?\s*power\s*diesel|super\s*diesel|diesel\s*super|ultimate\s*diesel|"
    r"diesel\s*premium|premium\s*diesel|\bcrystal\b|diesel\s*best|d-?\s*force",
    re.IGNORECASE,
)


def is_premium_diesel_name(name: str) -> bool:
    return bool(name and _PREMIUM_DIESEL_RE.search(str(name)))


def classify_high_octane(name: str) -> list[str]:
    """Split fuelgr type 2 (98/100) by product name."""
    n = str(name or "")
    has98 = bool(re.search(r"\b98\b", n))
    has100 = bool(re.search(r"\b100\b", n))
    if has98 and not has100:
        return ["u98"]
    if has100 and not has98:
        return ["u100"]
    if has98 and has100:
        return ["u98", "u100"]
    # Ambiguous — keep under u100 for backward compatibility with old clients
    return ["u100"]
LEDGER_MAX_DAYS = 365
SPARKLINE_DAYS = 14
RELEASE_LEDGER_URL = (
    "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/price_ledger.min.json"
)
RELEASE_STATIONS_URL = (
    "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json"
)
RELEASE_REVIEWS_URL = (
    "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/reviews.min.json"
)
RELEASE_CHARGERS_URL = (
    "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/chargers_latest.min.json"
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
        if not isinstance(fobj, dict):
            continue
        pr = fobj.get("price")
        if pr is None or float(pr) <= 0:
            continue
        pr = round(float(pr), 3)
        fid_s = str(fid)

        # Type 2 is combined 98/100 on fuelgr — split by product name
        if fid_s == "2":
            for k in classify_high_octane(fobj.get("name", "")):
                prices[k] = pr
            continue

        # Type 4 diesel: premium product → dp only; regular → d only
        if fid_s == "4":
            if is_premium_diesel_name(fobj.get("name", "")):
                prices["dp"] = pr
            else:
                prices["d"] = pr
            continue

        key = FUEL_KEY_MAP.get(fid_s)
        if key:
            prices[key] = pr

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
        elif "98" in ft:
            prices["u98"] = round(float(raw["price"]), 3)
        else:
            prices["u95"] = round(float(raw["price"]), 3)

    # Legacy dual-key bug: same type-4 price was written to both d and dp
    if (
        isinstance(prices.get("d"), (int, float))
        and isinstance(prices.get("dp"), (int, float))
        and abs(float(prices["d"]) - float(prices["dp"])) < 1e-6
    ):
        del prices["d"]

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


def ledger_depth(ledger: dict[str, list[dict]]) -> int:
    """Total day-rows — used to prefer a full release ledger over a truncated local one."""
    return sum(len(v) for v in ledger.values()) if ledger else 0


def merge_ledgers(*ledgers: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Union per-station histories by date (later sources overwrite same-day rows)."""
    out: dict[str, list[dict]] = {}
    for ledger in ledgers:
        if not ledger:
            continue
        for sid, records in ledger.items():
            by_date = {r["date"]: dict(r) for r in out.get(sid, []) if r.get("date")}
            for rec in records:
                d = rec.get("date")
                if not d:
                    continue
                by_date[d] = dict(rec)
            out[sid] = [by_date[d] for d in sorted(by_date.keys())][-LEDGER_MAX_DAYS:]
    return out


def load_previous_ledger(data_dir: Path) -> dict[str, list[dict]]:
    """
    Build the prior ledger from every available source.

    Prefer depth (CDN release usually wins over a short local file from a failed
    local publish). Optional override: FUELGR_LEDGER_URL.
    """
    candidates: list[tuple[str, dict[str, list[dict]]]] = []

    override = (os.environ.get("FUELGR_LEDGER_URL") or "").strip()
    if override:
        remote = fetch_json(override)
        if remote:
            ledger = normalize_ledger(remote)
            if ledger:
                print(
                    f"  [OK] Loaded override ledger ({len(ledger)} stations, "
                    f"depth={ledger_depth(ledger)})."
                )
                candidates.append(("override", ledger))

    local = data_dir / "price_ledger.min.json"
    if local.exists():
        try:
            with open(local, "r", encoding="utf-8") as f:
                ledger = normalize_ledger(json.load(f))
            if ledger:
                print(
                    f"  [OK] Loaded local ledger ({len(ledger)} stations, "
                    f"depth={ledger_depth(ledger)})."
                )
                candidates.append(("local", ledger))
        except Exception as e:
            print(f"  [!] Local ledger unreadable: {e}")

    remote = fetch_json(RELEASE_LEDGER_URL)
    if remote:
        ledger = normalize_ledger(remote)
        if ledger:
            print(
                f"  [OK] Loaded CDN ledger ({len(ledger)} stations, "
                f"depth={ledger_depth(ledger)})."
            )
            candidates.append(("cdn", ledger))

    if candidates:
        # Merge all sources so a truncated local never erases CDN history.
        # Sort by depth ascending so deeper histories win same-day conflicts last.
        candidates.sort(key=lambda x: ledger_depth(x[1]))
        merged = merge_ledgers(*(led for _, led in candidates))
        print(
            f"  [OK] Using merged ledger from {[n for n, _ in candidates]} "
            f"({len(merged)} stations, depth={ledger_depth(merged)})."
        )
        return merged

    # First-run bootstrap: previous station prices become day-0 history
    prev_stations = fetch_json(RELEASE_STATIONS_URL)
    if isinstance(prev_stations, list) and prev_stations:
        ledger = seed_ledger_from_stations(prev_stations)
        print(f"  [OK] Bootstrapped ledger from previous stations ({len(ledger)} stations).")
        return ledger

    print("  [!] No previous ledger found - starting fresh (history grows daily).")
    return {}


def is_valid_review(rec) -> bool:
    return (
        isinstance(rec, dict)
        and isinstance(rec.get("rating"), (int, float))
        and int(rec.get("reviews") or 0) > 0
    )


def merge_review_pair(prev: dict | None, incoming: dict | None) -> dict | None:
    """Same rules as merge_reviews.js: prefer newer ts, never drop Maps links."""
    if not is_valid_review(incoming):
        return prev if is_valid_review(prev) else None
    if not is_valid_review(prev):
        return dict(incoming)

    prev = dict(prev)
    inc = dict(incoming)
    in_ts = int(inc.get("ts") or 0)
    prev_ts = int(prev.get("ts") or 0)

    if in_ts >= prev_ts:
        nxt = {**inc}
        if not nxt.get("mu") and prev.get("mu"):
            nxt["mu"] = prev["mu"]
        if not nxt.get("pid") and prev.get("pid"):
            nxt["pid"] = prev["pid"]
        return nxt

    if not prev.get("mu") and inc.get("mu"):
        prev["mu"] = inc["mu"]
    if not prev.get("pid") and inc.get("pid"):
        prev["pid"] = inc["pid"]
    return prev


def dedupe_review_maps_links(reviews: dict[str, dict]) -> dict[str, dict]:
    """Strip shared Google cid links (wrong neighbour match) — mirrors merge_reviews.js."""
    by_cid: dict[str, list[str]] = {}
    for sid, rec in reviews.items():
        mu = str(rec.get("mu") or "")
        pid = str(rec.get("pid") or "")
        m = re.search(r"[?&]cid=(\d+)", mu) or re.search(r"^cid:(\d+)$", pid)
        if not m:
            continue
        by_cid.setdefault(m.group(1), []).append(sid)

    for ids in by_cid.values():
        if len(ids) < 2:
            continue
        for sid in ids:
            reviews[sid].pop("mu", None)
            reviews[sid].pop("pid", None)
    return reviews


def merge_reviews_dicts(*sources: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for src in sources:
        if not isinstance(src, dict):
            continue
        for sid, rec in src.items():
            if sid in ("updated", "stations"):
                continue
            merged = merge_review_pair(out.get(str(sid)), rec if isinstance(rec, dict) else None)
            if merged:
                out[str(sid)] = merged

    out = {k: v for k, v in out.items() if is_valid_review(v)}
    return dedupe_review_maps_links(out)


def load_previous_reviews(data_dir: Path) -> dict[str, dict]:
    """
    Union reviews from baseline file, local data, and CDN release.

    Local-only packaging used to overwrite a fuller release map (same class of bug
    as truncated ledgers). Optional FUELGR_REVIEWS_URL for recovery.
    """
    candidates: list[tuple[str, dict]] = []

    override = (os.environ.get("FUELGR_REVIEWS_URL") or "").strip()
    if override:
        remote = fetch_json(override)
        if isinstance(remote, dict) and remote:
            candidates.append(("override", remote))

    baseline = data_dir / "reviews_baseline.min.json"
    if baseline.exists():
        try:
            with open(baseline, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                candidates.append(("baseline", data))
                print(f"  [OK] Loaded baseline reviews ({len(data)} stations).")
        except Exception as e:
            print(f"  [!] Baseline reviews unreadable: {e}")

    local = data_dir / "reviews.min.json"
    if local.exists():
        try:
            with open(local, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                candidates.append(("local", data))
                print(f"  [OK] Loaded local reviews ({len(data)} stations).")
        except Exception as e:
            print(f"  [!] Local reviews unreadable: {e}")

    remote = fetch_json(RELEASE_REVIEWS_URL)
    if isinstance(remote, dict) and remote:
        candidates.append(("cdn", remote))
        print(f"  [OK] Loaded CDN reviews ({len(remote)} stations).")

    if not candidates:
        return {}

    merged = merge_reviews_dicts(*(d for _, d in candidates))
    print(
        f"  [OK] Using merged reviews from {[n for n, _ in candidates]} "
        f"({len(merged)} stations)."
    )
    return merged


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


def fill_price_gaps_from_ledger(
    prices: dict, records: list[dict], today: str, max_age_days: int = 7
) -> dict:
    """
    If today's scrape missed a fuel (throttle / sparse enrich), keep a recent
    ledger price so diesel/u100 don't flicker off for a day.
    Never invent fuels the station never had.
    """
    if not records:
        return prices
    out = dict(prices)
    try:
        today_d = datetime.date.fromisoformat(today[:10])
    except ValueError:
        return out

    for rec in reversed(records):
        d = str(rec.get("date") or "")[:10]
        if not d or d == today[:10]:
            continue
        try:
            age = (today_d - datetime.date.fromisoformat(d)).days
        except ValueError:
            continue
        if age < 0:
            continue
        if age > max_age_days:
            break
        for k in FUEL_KEYS:
            if k in out:
                continue
            v = rec.get(k)
            if isinstance(v, (int, float)) and v > 0:
                out[k] = round(float(v), 3)
    return out


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


def build_master_and_history(
    raw: dict,
    today: str,
    ledger: dict[str, list[dict]],
    reviews: dict[str, dict] | None = None,
    is_fallback: bool = False,
):
    st_id = str(raw.get("id", "")).strip()
    name = str(raw.get("name", "")).strip()
    brand = str(raw.get("brand", "")).strip() or "Ανεξάρτητο"
    address = str(raw.get("address", "")).strip()
    prefecture = str(raw.get("prefecture", "")).strip()
    municipality = str(raw.get("municipality", "")).strip()
    lat = raw.get("latitude", raw.get("lat"))
    lng = raw.get("longitude", raw.get("lng"))
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

    # Normalize coords (deixto scraper uses lat/lng; never ship null pins)
    try:
        lat = float(lat) if lat is not None else None
        lng = float(lng) if lng is not None else None
    except (TypeError, ValueError):
        lat, lng = None, None
    if lat is not None and not (34.0 <= lat <= 42.0):
        lat = None
    if lng is not None and not (19.0 <= lng <= 29.0):
        lng = None

    prices = extract_prices(raw)
    # Don't drop diesel/u100 for one incomplete scrape — carry recent ledger gaps forward
    prices = fill_price_gaps_from_ledger(prices, ledger.get(st_id, []), today, max_age_days=7)
    if not is_fallback:
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
            rating = rev.get("rating")
            count = rev.get("reviews")
            # Skip bogus star-with-zero-reviews matches
            if rating is not None and count is not None and int(count) > 0:
                master_item["mr"] = round(float(rating), 1)
                master_item["mc"] = int(count)
                # Maps deep link captured by reviews scraper (exact place listing)
                if rev.get("pid"):
                    master_item["mp"] = str(rev["pid"])
                if rev.get("mu"):
                    master_item["mu"] = str(rev["mu"])[:512]

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
    keys = ("u95", "u98", "u100", "d", "dp", "lpg", "dh", "cng")
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
    is_fallback = False

    if not station_file.exists() or station_file.stat().st_size == 0:
        print(f"[!] Warning: {station_file} missing or empty. Fetching fallback from latest release CDN...")
        remote_stations = fetch_json(RELEASE_STATIONS_URL)
        if remote_stations:
            with open(station_file, "w", encoding="utf-8") as f:
                json.dump(remote_stations, f, ensure_ascii=False, separators=(",", ":"))
            print(f"  [OK] Loaded fallback stations from CDN ({len(remote_stations)} stations).")
            is_fallback = True

    if station_file.exists() and station_file.stat().st_size > 0:
        with open(station_file, "r", encoding="utf-8") as f:
            raw_stations = json.load(f)

        if not is_fallback and raw_stations and isinstance(raw_stations[0], dict) and "n" in raw_stations[0] and "p" in raw_stations[0]:
            print(f"  [i] Detected carried-forward compact station dataset ({len(raw_stations)} stations). Skipping ledger today append.")
            is_fallback = True

        print(f"Transforming {len(raw_stations)} stations with real price history (is_fallback={is_fallback})...")
        ledger = load_previous_ledger(data_dir)

        reviews_data = load_previous_reviews(data_dir)

        if reviews_data:
            with open(data_dir / "reviews.min.json", "w", encoding="utf-8") as f_rev_local:
                json.dump(reviews_data, f_rev_local, ensure_ascii=False, separators=(",", ":"))
            with open(dist_dir / "reviews.min.json", "w", encoding="utf-8") as f_rev_dist:
                json.dump(reviews_data, f_rev_dist, ensure_ascii=False, separators=(",", ":"))
            compress_zstd(dist_dir / "reviews.min.json", dist_dir / "reviews.min.json.zst")

        for raw in raw_stations:
            master_item, detail_history = build_master_and_history(
                raw, today, ledger, reviews_data, is_fallback=is_fallback
            )
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
        missing_coords = sum(
            1
            for s in master_stations
            if not isinstance(s.get("lat"), (int, float)) or not isinstance(s.get("lng"), (int, float))
        )
        if master_stations and missing_coords / len(master_stations) > 0.05:
            raise SystemExit(
                f"[!] Abort: {missing_coords}/{len(master_stations)} stations missing lat/lng "
                f"— refusing to publish a blank map."
            )
        print(
            f"[OK] Master stations dataset written ({station_min_file.stat().st_size:,} bytes) "
            f"(missing coords: {missing_coords})."
        )
        print(f"[OK] Ledger stations={len(ledger)} bytes={ledger_dist.stat().st_size:,}.")
        print(f"[OK] Generated {len(raw_stations)} history files in {history_dir}.")
    else:
        print(f"[!] Warning: {station_file} not found.")

    # 3. Process EV Chargers
    charger_file = data_dir / "chargers_latest.min.json"
    chargers_data = []
    if not charger_file.exists() or charger_file.stat().st_size == 0:
        print(f"[!] Warning: {charger_file} missing or empty. Fetching fallback from latest release CDN...")
        remote_chargers = fetch_json(RELEASE_CHARGERS_URL)
        if remote_chargers:
            with open(charger_file, "w", encoding="utf-8") as f:
                json.dump(remote_chargers, f, ensure_ascii=False, separators=(",", ":"))
            chargers_data = remote_chargers
    else:
        with open(charger_file, "r", encoding="utf-8") as f:
            chargers_data = json.load(f)

    if chargers_data:
        charger_min_file = dist_dir / "chargers_latest.min.json"
        with open(charger_min_file, "w", encoding="utf-8") as f:
            json.dump(chargers_data, f, ensure_ascii=False, separators=(",", ":"))
        with open(dist_dir / "chargers_latest.json", "w", encoding="utf-8") as f:
            json.dump(chargers_data, f, ensure_ascii=False, indent=2)
        compress_zstd(charger_min_file, dist_dir / "chargers_latest.min.json.zst")
        print(f"[OK] EV chargers dataset written ({charger_min_file.stat().st_size:,} bytes, {len(chargers_data):,} hubs).")
    else:
        print("[!] Warning: No EV chargers data available.")

    # 4. Write tag.txt
    tag_file = dist_dir / "tag.txt"
    with open(tag_file, "w", encoding="utf-8") as f:
        f.write(tag)

    # 5. Generate release_notes.md
    notes_file = dist_dir / "release_notes.md"
    station_count = len(master_stations) if master_stations else len(raw_stations)
    pref_count = len(pref_data)
    fuel_counts = count_fuel_coverage(master_stations)

    def asset_size(name: str) -> str:
        path = dist_dir / name
        return format_bytes(path.stat().st_size) if path.exists() else "n/a"

    # Keep this table in sync with ASSETS uploaded in .github/workflows/update-database.yml
    dl = "https://github.com/athanasso/fuelGR-scraper/releases/latest/download"
    reviews_path = dist_dir / "reviews.min.json"
    reviews_count = 0
    if reviews_path.exists():
        try:
            with open(reviews_path, "r", encoding="utf-8") as f_rev_count:
                reviews_count = len(json.load(f_rev_count))
        except Exception:
            reviews_count = 0

    charger_count = len(chargers_data)
    avail_chargers = sum(1 for c in chargers_data if c.get("statusSummary") == "available")

    status_note = (
        "- **Station Prices Status:** ⚠️ Carried forward from previous release (Cloudflare WAF blocked runner IP). Prefectures updated.\n"
        if is_fallback
        else "- **Station Prices Status:** Fresh nationwide scrape.\n"
    )

    release_notes = f"""## FuelGR Daily Dataset Release [{tag}]

Automated daily fuel prices dataset snapshot for Greece.

### Summary
- **Release Date:** {today}
{status_note.rstrip()}
- **Prefectures Tracked:** {pref_count}
- **Gas Stations Tracked:** {station_count:,}
- **Stations with Unleaded 95 (`u95`):** {fuel_counts['u95']:,}
- **Stations with Unleaded 98 (`u98`):** {fuel_counts['u98']:,}
- **Stations with Unleaded 100 (`u100`):** {fuel_counts['u100']:,}
- **Stations with Diesel (`d`):** {fuel_counts['d']:,}
- **Stations with Diesel Premium (`dp`):** {fuel_counts['dp']:,}
- **Stations with LPG (`lpg`):** {fuel_counts['lpg']:,}
- **Stations with CNG (`cng`):** {fuel_counts['cng']:,}
- **Stations with Heating Diesel (`dh`):** {fuel_counts['dh']:,}
- **Stations with Google Reviews:** {reviews_count:,}
- **EV Charging Hubs Tracked:** {charger_count:,} ({avail_chargers:,} live available)
- **Schema:** Real daily price ledger → 7-day deltas (`d7`) and ledger-based sparklines (`sp`).

### Direct Download Links
The following assets can be fetched directly by mobile clients via GitHub Release CDN:

| File | Format | Size | Description |
|---|---|---|---|
| [`stations_latest.min.json`]({dl}/stations_latest.min.json) | JSON (Minified) | {asset_size("stations_latest.min.json")} | Daily master: {station_count:,} stations with prices, `d7` deltas, and ledger-based sparklines |
| [`stations_latest.min.json.zst`]({dl}/stations_latest.min.json.zst) | Zstandard | {asset_size("stations_latest.min.json.zst")} | High-compression master dataset |
| [`stations_latest.json`]({dl}/stations_latest.json) | JSON | {asset_size("stations_latest.json")} | Human-readable master stations dataset |
| [`price_ledger.min.json`]({dl}/price_ledger.min.json) | JSON (Minified) | {asset_size("price_ledger.min.json")} | **Source of truth for charts** — real per-station daily prices (grows each scrape) |
| [`price_ledger.min.json.zst`]({dl}/price_ledger.min.json.zst) | Zstandard | {asset_size("price_ledger.min.json.zst")} | Compressed price ledger |
| [`reviews.min.json`]({dl}/reviews.min.json) | JSON (Minified) | {asset_size("reviews.min.json")} | Google rating + review counts by station id ({reviews_count:,} stations) |
| [`reviews.min.json.zst`]({dl}/reviews.min.json.zst) | Zstandard | {asset_size("reviews.min.json.zst")} | Compressed Google reviews map |
| [`prefectures_latest.min.json`]({dl}/prefectures_latest.min.json) | JSON (Minified) | {asset_size("prefectures_latest.min.json")} | Prefecture regional price averages |
| [`prefectures_latest.min.json.zst`]({dl}/prefectures_latest.min.json.zst) | Zstandard | {asset_size("prefectures_latest.min.json.zst")} | Compressed prefecture averages |
| [`prefectures_latest.json`]({dl}/prefectures_latest.json) | JSON | {asset_size("prefectures_latest.json")} | Human-readable prefecture averages |
| [`chargers_latest.min.json`]({dl}/chargers_latest.min.json) | JSON (Minified) | {asset_size("chargers_latest.min.json")} | Greek EV charging hubs ({charger_count:,} locations) with live OCPI status |
| [`chargers_latest.min.json.zst`]({dl}/chargers_latest.min.json.zst) | Zstandard | {asset_size("chargers_latest.min.json.zst")} | High-compression EV chargers dataset |
| [`chargers_latest.json`]({dl}/chargers_latest.json) | JSON | {asset_size("chargers_latest.json")} | Human-readable Greek EV charging dataset |

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
