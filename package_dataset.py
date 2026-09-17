#!/usr/bin/env python3
"""
package_dataset.py

Packages fuelGR dataset artifacts for GitHub Release and static hosting.
1. Validates and minifies JSON datasets (stations and prefecture averages).
2. Compresses artifacts using zstandard (.zst).
3. Generates release_notes.md and tag.txt for GitHub Release publishing.
"""

import datetime
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


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

    # Fallback to zstd command-line tool if available
    zstd_bin = shutil.which("zstd")
    if zstd_bin:
        res = subprocess.run([zstd_bin, "-19", "-f", str(source_path), "-o", str(dest_path)], capture_output=True)
        if res.returncode == 0:
            print(f"  [zstd-cli] Compressed {source_path.name} -> {dest_path.name} ({dest_path.stat().st_size} bytes)")
            return
        else:
            print(f"  [!] zstd CLI error: {res.stderr.decode('utf-8', errors='ignore')}")

    print(f"  [!] Warning: zstandard not available; {dest_path.name} not generated.")


def main():
    base_dir = Path(__file__).resolve().parent
    data_dir = base_dir / "data"
    dist_dir = base_dir / "dist"

    dist_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    tag = today

    # 1. Process Prefectures
    pref_file = data_dir / "prefectures_latest.json"
    pref_data = []
    if pref_file.exists():
        with open(pref_file, "r", encoding="utf-8") as f:
            pref_data = json.load(f)
        
        # Save pretty
        with open(dist_dir / "prefectures_latest.json", "w", encoding="utf-8") as f:
            json.dump(pref_data, f, ensure_ascii=False, indent=2)
        
        # Save minified
        pref_min_file = dist_dir / "prefectures_latest.min.json"
        with open(pref_min_file, "w", encoding="utf-8") as f:
            json.dump(pref_data, f, ensure_ascii=False, separators=(",", ":"))
        
        # Compress zst
        compress_zstd(pref_min_file, dist_dir / "prefectures_latest.min.json.zst")
    else:
        print(f"[!] Warning: {pref_file} not found.")

    # 2. Process Stations
    station_file = data_dir / "stations_latest.min.json"
    station_data = []
    if station_file.exists():
        with open(station_file, "r", encoding="utf-8") as f:
            station_data = json.load(f)

        # Save minified
        station_min_file = dist_dir / "stations_latest.min.json"
        with open(station_min_file, "w", encoding="utf-8") as f:
            json.dump(station_data, f, ensure_ascii=False, separators=(",", ":"))

        # Save pretty for inspection
        with open(dist_dir / "stations_latest.json", "w", encoding="utf-8") as f:
            json.dump(station_data, f, ensure_ascii=False, indent=2)

        # Compress zst
        compress_zstd(station_min_file, dist_dir / "stations_latest.min.json.zst")
    else:
        print(f"[!] Warning: {station_file} not found.")

    # 3. Write tag.txt
    tag_file = dist_dir / "tag.txt"
    with open(tag_file, "w", encoding="utf-8") as f:
        f.write(tag)

    # 4. Generate release_notes.md
    notes_file = dist_dir / "release_notes.md"
    station_count = len(station_data)
    pref_count = len(pref_data)
    
    release_notes = f"""## FuelGR Daily Dataset Release [{tag}]

Automated daily fuel prices dataset snapshot for Greece.

### Summary
- **Release Date:** {today}
- **Prefectures Tracked:** {pref_count}
- **Gas Stations Tracked:** {station_count:,}
- **Fuel Types:** Unleaded 95, Unleaded 100, Diesel, LPG, Heating Diesel

### Direct Download Links
The following assets can be fetched directly by mobile clients via GitHub Release CDN:

| File | Format | Description |
|---|---|---|
| [`stations_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json) | JSON (Minified) | Station-level coordinates, brand, and live fuel prices |
| [`stations_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json.zst) | Zstandard | Compressed station dataset for minimal mobile bandwidth |
| [`prefectures_latest.min.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json) | JSON (Minified) | Prefecture regional price averages |
| [`prefectures_latest.min.json.zst`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.min.json.zst) | Zstandard | Compressed prefecture averages |
| [`prefectures_latest.json`](https://github.com/athanasso/fuelGR-scraper/releases/latest/download/prefectures_latest.json) | JSON | Human-readable prefecture averages |

*Generated automatically by [fuelGR-scraper](https://github.com/athanasso/fuelGR-scraper).*
"""
    with open(notes_file, "w", encoding="utf-8") as f:
        f.write(release_notes.strip() + "\n")

    print(f"\n[OK] Packaged dataset for release {tag} into {dist_dir}:")
    for item in sorted(dist_dir.iterdir()):
        print(f"  - {item.name} ({item.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
