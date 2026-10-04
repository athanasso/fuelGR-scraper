#!/usr/bin/env python3
"""
scraper_ev.py

Automated Greek EV Charging Station scraper and normalizer for FuelGR.
Sourced from official Ministry of Infrastructure and Transport (MYFAH / electrokinisi.yme.gov.gr)
OCPI 2.2 National Access Point (IDRO) static and dynamic data feeds.

Outputs minified, highly compressed JSON matching FuelGR mobile EVCharger schema.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

# Safe utf-8 stdout/stderr on Windows terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DIST_DIR = BASE_DIR / "dist"

STATIC_ZIP_URL = "https://electrokinisi.yme.gov.gr/public/static_files/GR.IDRO.static.data.latest.json.zip"
DYNAMIC_ZIP_URL = "https://electrokinisi.yme.gov.gr/public/static_files/GR.IDRO.dynamic.data.latest.json.zip"
RELEASE_CHARGERS_URL = "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/chargers_latest.min.json"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# Curated fallback Greek hubs if all remote sources are unreachable
CURATED_FALLBACK = [
    {
        "id": "ev-ath-01",
        "name": "PPC blue - Golden Hall",
        "operator": "PPC blue",
        "operatorKey": "PPC_BLUE",
        "address": "Λεωφ. Κηφισίας 37Α, Μαρούσι",
        "city": "Μαρούσι",
        "pref": "Αττική",
        "lat": 38.0345,
        "lng": 23.7915,
        "maxPowerKw": 300.0,
        "connectors": [
            {"id": "c1", "type": "ccs2", "current": "DC", "powerKw": 300.0, "count": 2, "availableCount": 2, "status": "available", "tariffKwh": 0.60},
            {"id": "c2", "type": "ccs2", "current": "DC", "powerKw": 150.0, "count": 2, "availableCount": 1, "status": "occupied", "tariffKwh": 0.55},
            {"id": "c3", "type": "type2", "current": "AC", "powerKw": 22.0, "count": 4, "availableCount": 3, "status": "available", "tariffKwh": 0.45}
        ],
        "statusSummary": "available",
        "tariffFromKwh": 0.45,
    },
    {
        "id": "ev-ath-02",
        "name": "Tesla Supercharger - Marousi",
        "operator": "Tesla Supercharger",
        "operatorKey": "TESLA",
        "address": "Λεωφ. Κηφισίας 37 (Golden Hall P1)",
        "city": "Μαρούσι",
        "pref": "Αττική",
        "lat": 38.0349,
        "lng": 23.7922,
        "maxPowerKw": 250.0,
        "connectors": [
            {"id": "c1", "type": "ccs2", "current": "DC", "powerKw": 250.0, "count": 6, "availableCount": 4, "status": "available", "tariffKwh": 0.48}
        ],
        "statusSummary": "available",
        "tariffFromKwh": 0.48,
    },
    {
        "id": "ev-ath-03",
        "name": "nrg incharge - Shell ΣΕΑ Σείριος",
        "operator": "nrg incharge",
        "operatorKey": "NRG_INCHARGE",
        "address": "43ο χλμ Ν.Ε.Ο. Αθηνών - Λαμίας, Μαλακάσα",
        "city": "Μαλακάσα",
        "pref": "Αττική",
        "lat": 38.2573,
        "lng": 23.7852,
        "maxPowerKw": 180.0,
        "connectors": [
            {"id": "c1", "type": "ccs2", "current": "DC", "powerKw": 180.0, "count": 2, "availableCount": 1, "status": "available", "tariffKwh": 0.58},
            {"id": "c2", "type": "chademo", "current": "DC", "powerKw": 50.0, "count": 1, "availableCount": 1, "status": "available", "tariffKwh": 0.52},
            {"id": "c3", "type": "type2", "current": "AC", "powerKw": 22.0, "count": 2, "availableCount": 2, "status": "available", "tariffKwh": 0.46}
        ],
        "statusSummary": "available",
        "tariffFromKwh": 0.46,
    }
]


def download_with_retry(url: str, max_retries: int = 3, timeout: int = 40) -> bytes | None:
    """Download binary data with user-agent, retry backoff and timeout."""
    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    return resp.read()
        except Exception as e:
            print(f"  [!] Attempt {attempt}/{max_retries} failed for {url}: {e}")
            if attempt < max_retries:
                time.sleep(3 * attempt)
    return None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in kilometers between two GPS coordinates."""
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r * c


def map_operator(party_id: str | None, op_field: any) -> tuple[str, str]:
    """Map Greek CPO / IDRO party code to friendly display name and operatorKey."""
    p = (party_id or "").strip().upper()
    op_name = ""
    if isinstance(op_field, dict):
        op_name = op_field.get("name", "")
    elif isinstance(op_field, str):
        op_name = op_field

    op_upper = op_name.upper()

    if p == "PPC" or "DEI" in op_upper or "PPC" in op_upper:
        return "PPC blue", "PPC_BLUE"
    if p == "NRG" or "ERMIS" in op_upper or "NRG" in op_upper:
        return "nrg incharge", "NRG_INCHARGE"
    if p == "BLK" or "BLINK" in op_upper:
        return "Blink Hellas", "BLINK"
    if p == "HEC" or "EKO" in op_upper or "ELPE" in op_upper:
        return "ElpeFuture (EKO)", "ELPEFUTURE"
    if p == "WAV" or "PROTERGIA" in op_upper or "WATT" in op_upper:
        return "Chargespot (Protergia)", "PROTERGIA"
    if p == "TESLA" or "TESLA" in op_upper:
        return "Tesla Supercharger", "TESLA"
    if p == "AVIN" or "AVIN" in op_upper:
        return "Avin EV Point", "AVIN_EV"
    if p == "IONITY" or "IONITY" in op_upper:
        return "IONITY", "IONITY"
    if p == "JLT" or "JOLTIE" in op_upper:
        return "Joltie Greece", "JOLTIE"
    if p == "EMU" or "EV LOADER" in op_upper or "EVLOADER" in op_upper:
        return "EV Loader", "EV_LOADER"
    if p == "ELE" or "ELECTRIP" in op_upper:
        return "Electrip Hellas", "ELECTRIP"
    if p == "LDL" or "LIDL" in op_upper:
        return "Lidl Hellas", "LIDL"
    if p == "EVZ" or "EVZIIIN" in op_upper:
        return "EVZIIIN", "EVZIIIN"
    if p == "FRZ" or "FORTISIS" in op_upper:
        return "Fortisis", "FORTISIS"

    friendly = op_name.strip() if op_name else (p if p else "Other")
    key = re.sub(r"[^A-Z0-9]", "_", friendly.upper()).strip("_") or "OTHER"
    return friendly, key


def map_standard(std: str | None) -> tuple[str, str]:
    """Map IDRO/OCPI connector standard to FuelGR type ('ccs2', 'type2', 'chademo', 'tesla') and current ('AC', 'DC')."""
    s = (std or "").upper()
    if "COMBO" in s or "CCS" in s:
        return "ccs2", "DC"
    if "T2" in s or "TYPE2" in s or "MENNEKES" in s:
        return "type2", "AC"
    if "CHADEMO" in s:
        return "chademo", "DC"
    if "TESLA" in s:
        return "tesla", "DC"
    return "type2", "AC"


def get_default_tariff(op_key: str, current: str, power_kw: float) -> float:
    """Estimated default tariff in €/kWh for Greek operators."""
    if op_key == "PPC_BLUE":
        return 0.45 if current == "AC" else (0.55 if power_kw <= 150 else 0.60)
    if op_key == "NRG_INCHARGE":
        return 0.46 if current == "AC" else (0.54 if power_kw <= 150 else 0.58)
    if op_key == "BLINK":
        return 0.44 if current == "AC" else 0.56
    if op_key == "ELPEFUTURE":
        return 0.45 if current == "AC" else 0.55
    if op_key == "PROTERGIA":
        return 0.45 if current == "AC" else 0.55
    if op_key == "TESLA":
        return 0.48
    if op_key == "LIDL":
        return 0.38
    return 0.45 if current == "AC" else (0.58 if power_kw <= 150 else 0.62)


def load_gas_stations_for_linking(data_dir: Path) -> list[dict]:
    """Load fuel stations to cross-reference co-located EV chargers."""
    candidate_paths = [
        data_dir / "stations_latest.min.json",
        DIST_DIR / "stations_latest.min.json",
    ]
    for fuel_file in candidate_paths:
        if fuel_file.exists() and fuel_file.stat().st_size > 0:
            try:
                with open(fuel_file, "r", encoding="utf-8") as f:
                    stations = json.load(f)
                    valid = []
                    for s in stations:
                        lat = s.get("lat")
                        lng = s.get("lng")
                        if lat and lng:
                            valid.append({"id": s.get("id"), "lat": float(lat), "lng": float(lng)})
                    if valid:
                        return valid
            except Exception:
                pass

    # Try downloading from latest release if not cached locally
    try:
        release_url = "https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json"
        raw = download_with_retry(release_url, max_retries=1, timeout=10)
        if raw:
            stations = json.loads(raw.decode("utf-8"))
            return [{"id": s.get("id"), "lat": float(s["lat"]), "lng": float(s["lng"])} for s in stations if s.get("lat") and s.get("lng")]
    except Exception:
        pass

    return []


def scrape_ev_chargers() -> list[dict]:
    """Download official IDRO static + dynamic feeds, normalize, and return EVCharger list."""
    print("==> Downloading official Greek EV Registry (MYFAH) feeds...")

    # 1. Download Static Data
    print("  Fetching static dataset...")
    static_bytes = download_with_retry(STATIC_ZIP_URL)
    if not static_bytes:
        print("  [!] Failed to download IDRO static data zip.")
        return []

    try:
        with zipfile.ZipFile(io.BytesIO(static_bytes)) as z:
            name = z.namelist()[0]
            raw_text = z.read(name).decode("utf-8-sig")
            static_json = json.loads(raw_text)
    except Exception as e:
        print(f"  [!] Failed to unpack static JSON zip: {e}")
        return []

    # 2. Download Dynamic Status Data
    print("  Fetching dynamic real-time status dataset...")
    dyn_status: dict[str, str] = {}
    dyn_bytes = download_with_retry(DYNAMIC_ZIP_URL)
    if dyn_bytes:
        try:
            with zipfile.ZipFile(io.BytesIO(dyn_bytes)) as z:
                name = z.namelist()[0]
                dyn_raw = z.read(name).decode("utf-8-sig")
                dyn_json = json.loads(dyn_raw)
                for loc in dyn_json.get("Locations", []):
                    for evse in loc.get("evses", []):
                        uid = evse.get("uid") or evse.get("evse_id")
                        st = evse.get("status", "UNKNOWN").upper()
                        if uid:
                            dyn_status[uid] = st
            print(f"  Loaded {len(dyn_status):,} real-time EVSE dynamic status records.")
        except Exception as e:
            print(f"  [!] Could not parse dynamic data zip: {e}")
    else:
        print("  [!] Dynamic feed unavailable; falling back to static status.")

    raw_locs = static_json.get("Locations", [])
    print(f"  Processing {len(raw_locs):,} raw EV locations...")

    gas_stations = load_gas_stations_for_linking(DATA_DIR)

    chargers: list[dict] = []
    seen_ids = set()

    for loc in raw_locs:
        coords = loc.get("coordinates") or {}
        try:
            lat = round(float(coords.get("latitude", 0)), 5)
            lng = round(float(coords.get("longitude", 0)), 5)
        except (ValueError, TypeError):
            continue

        # Greek bounds check (lat ~34.0 to 42.5, lng ~19.0 to 29.5)
        if not (34.0 <= lat <= 42.5 and 19.0 <= lng <= 29.5):
            continue

        loc_id = loc.get("id") or f"ev-{len(chargers)+1}"
        if loc_id in seen_ids:
            continue
        seen_ids.add(loc_id)

        name = (loc.get("name") or loc.get("address") or "EV Charging Point").strip()
        address = (loc.get("address") or "").strip()
        city = (loc.get("city") or "").strip()
        pref = (loc.get("state") or "").strip()

        op_name, op_key = map_operator(loc.get("party_id"), loc.get("operator"))

        raw_conns: list[dict] = []
        max_power = 0.0

        for evse in loc.get("evses", []):
            uid = evse.get("uid") or evse.get("evse_id")
            evse_status = dyn_status.get(uid, evse.get("status", "UNKNOWN")).upper()

            if evse_status == "AVAILABLE":
                status = "available"
            elif evse_status in ("CHARGING", "OCCUPIED", "RESERVED", "BLOCKED"):
                status = "occupied"
            elif evse_status in ("INOPERATIVE", "OUTOFORDER"):
                status = "offline"
            else:
                status = "unknown"

            for conn in evse.get("connectors", []):
                ctype, ccurr = map_standard(conn.get("standard"))
                power_w = conn.get("max_electric_power") or 0
                power_kw = round(power_w / 1000.0, 1) if power_w else (22.0 if ctype == "type2" else 50.0)
                if power_kw > max_power:
                    max_power = power_kw
                raw_conns.append({
                    "type": ctype,
                    "current": ccurr,
                    "powerKw": power_kw,
                    "status": status,
                })

        if not raw_conns:
            continue

        # Group identical connectors (type, powerKw, current)
        conn_groups: dict[tuple, dict] = {}
        for rc in raw_conns:
            k = (rc["type"], rc["powerKw"], rc["current"])
            if k not in conn_groups:
                conn_groups[k] = {"count": 0, "availableCount": 0, "statuses": []}
            conn_groups[k]["count"] += 1
            if rc["status"] == "available":
                conn_groups[k]["availableCount"] += 1
            conn_groups[k]["statuses"].append(rc["status"])

        connectors: list[dict] = []
        idx = 1
        for (ctype, power_kw, ccurr), data in conn_groups.items():
            if data["availableCount"] > 0:
                st = "available"
            elif any(s == "occupied" for s in data["statuses"]):
                st = "occupied"
            elif all(s == "offline" for s in data["statuses"]):
                st = "offline"
            else:
                st = "unknown"

            tariff = get_default_tariff(op_key, ccurr, power_kw)

            connectors.append({
                "id": f"c{idx}",
                "type": ctype,
                "current": ccurr,
                "powerKw": power_kw,
                "count": data["count"],
                "availableCount": data["availableCount"],
                "status": st,
                "tariffKwh": tariff,
            })
            idx += 1

        any_avail = any(c["availableCount"] > 0 for c in connectors)
        if any_avail:
            status_summary = "available"
        elif any(c["status"] == "occupied" for c in connectors):
            status_summary = "occupied"
        elif all(c["status"] == "offline" for c in connectors):
            status_summary = "offline"
        else:
            status_summary = "unknown"

        tariff_from = min((c["tariffKwh"] for c in connectors if c["tariffKwh"] is not None), default=None)

        charger_item: dict = {
            "id": loc_id,
            "name": name,
            "operator": op_name,
            "operatorKey": op_key,
            "address": address,
            "lat": lat,
            "lng": lng,
            "maxPowerKw": max_power,
            "connectors": connectors,
            "statusSummary": status_summary,
            "tariffFromKwh": tariff_from,
        }
        if city:
            charger_item["city"] = city
        if pref and len(pref) < 40 and not pref.lower().startswith("good"):
            charger_item["pref"] = pref

        last_up = loc.get("last_updated")
        if last_up:
            charger_item["lastUpdated"] = str(last_up)

        # Cross-reference nearby petrol stations (co-located within 45 meters)
        if gas_stations:
            for gs in gas_stations:
                d_km = haversine_km(lat, lng, gs["lat"], gs["lng"])
                if d_km <= 0.045:  # <= 45 meters
                    charger_item["linkedStationId"] = gs["id"]
                    break

        chargers.append(charger_item)

    return chargers


def compress_zstd(source_path: Path, dest_path: Path):
    """Compress file using python zstandard library or fallback to zstd CLI."""
    try:
        import zstandard as zstd

        cctx = zstd.ZstdCompressor(level=19)
        with open(source_path, "rb") as f_in, open(dest_path, "wb") as f_out:
            cctx.copy_stream(f_in, f_out)
        print(f"  [zstd-lib] Compressed {source_path.name} -> {dest_path.name} ({dest_path.stat().st_size:,} bytes)")
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
            print(f"  [zstd-cli] Compressed {source_path.name} -> {dest_path.name} ({dest_path.stat().st_size:,} bytes)")
            return

    print(f"  [!] Note: zstd not available to compress {dest_path.name}")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    target_data_file = DATA_DIR / "chargers_latest.min.json"

    chargers = scrape_ev_chargers()

    # Fallback to local or CDN release if live scrape failed
    if not chargers:
        if target_data_file.exists() and target_data_file.stat().st_size > 0:
            print(f"  [i] Using existing local {target_data_file.name} fallback.")
            with open(target_data_file, "r", encoding="utf-8") as f:
                chargers = json.load(f)
        else:
            print("  [!] Scraping failed. Attempting to fetch previous release fallback from GitHub...")
            fallback_bytes = download_with_retry(RELEASE_CHARGERS_URL, max_retries=2, timeout=20)
            if fallback_bytes:
                try:
                    chargers = json.loads(fallback_bytes.decode("utf-8"))
                    print(f"  [OK] Successfully restored {len(chargers)} chargers from GitHub Releases CDN.")
                except Exception:
                    pass

    if not chargers:
        print("  [!] Remote unavailable. Using curated Greek EV charging hubs fallback.")
        chargers = CURATED_FALLBACK

    # 1. Write data/chargers_latest.min.json
    with open(target_data_file, "w", encoding="utf-8") as f:
        json.dump(chargers, f, ensure_ascii=False, separators=(",", ":"))

    # 2. Write dist/chargers_latest.min.json
    dist_min = DIST_DIR / "chargers_latest.min.json"
    with open(dist_min, "w", encoding="utf-8") as f:
        json.dump(chargers, f, ensure_ascii=False, separators=(",", ":"))

    # 3. Write dist/chargers_latest.json
    dist_json = DIST_DIR / "chargers_latest.json"
    with open(dist_json, "w", encoding="utf-8") as f:
        json.dump(chargers, f, ensure_ascii=False, indent=2)

    # 4. Write dist/chargers_latest.min.json.zst
    compress_zstd(dist_min, DIST_DIR / "chargers_latest.min.json.zst")

    print(f"\n[OK] Successfully saved {len(chargers):,} Greek EV chargers to {target_data_file} and {DIST_DIR}.")


if __name__ == "__main__":
    main()
