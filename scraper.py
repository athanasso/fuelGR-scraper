#!/usr/bin/env python3
"""
Greek Fuel Prices Scraper
Downloads and parses daily prefecture-level fuel price bulletins (IMERISIO_DELTIO_ANA_NOMO_*.pdf)
published by the Greek Ministry of Development (fuelprices.gr).
Outputs a static JSON array of fuel price averages for all 51 prefectures.
"""

import argparse
import datetime
import io
import json
import logging
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

BASE_URL = "http://www.fuelprices.gr/files/deltia"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Resilient regex patterns from mavroprovato/fuelpricesgr to handle PDF font encoding variations
PREFECTURES_CONFIG: List[Tuple[str, str, str, str]] = [
    # (id, name_en, name_el, regex_pattern)
    ("ATTICA", "Attica", "Αττική", r"Α\s?[ΤΣ]\s?[ΤΣ]\s?[ΙΗ]\s?Κ\s?[ΗΖ]\s?[Σ΢]"),
    ("AETOLIA_ACARNANIA", "Aetolia-Acarnania", "Αιτωλοακαρνανία", r"Α\s?[ΙΗ]\s?[ΤΣ]\s?Ω\s?Λ\s?[ΙΗ]\s?Α\s?[Σ΢]\s{1,2}Κ\s?Α\s?[ΙΗ]\s{1,2}Α\s?Κ\s?Α\s?Ρ\s?Ν\s?Α\s?Ν\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("ARGOLIS", "Argolis", "Αργολίδα", r"Α\s?Ρ\s?Γ\s?Ο\s?Λ\s?[ΙΗ]\s?[ΔΓ]\s?Ο\s?[Σ΢]"),
    ("ARKADIAS", "Arcadia", "Αρκαδία", r"Α\s?Ρ\s?Κ\s?Α\s?[ΔΓ]\s?[ΙΗ]Α\s?[Σ΢]"),
    ("ARTA", "Arta", "Άρτα", r"Α\s?Ρ\s?[ΤΣ]\s?[ΗΖ]\s?[Σ΢]"),
    ("ACHAEA", "Achaea", "Αχαΐα", r"Α\s?[ΧΥ]\s?Α\s?Ϊ\s?Α\s?[Σ΢]"),
    ("BOEOTIA", "Boeotia", "Βοιωτία", r"Β\s?Ο\s?[ΙΗ]\s?Ω\s?[ΤΣ]\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("GREVENA", "Grevena", "Γρεβενά", r"Γ\s?Ρ\s?[ΕΔ]\s?Β\s?[ΕΔ]\s?Ν\s?Ω\s?Ν"),
    ("DRAMA", "Drama", "Δράμα", r"[ΔΓ]\s?Ρ\s?Α\s?Μ\s?Α\s?[Σ΢]"),
    ("DODECANESE", "Dodecanese", "Δωδεκάνησα", r"[ΔΓ]\s?Ω\s?[ΔΓ]\s?[ΕΔ]\s?ΚΑ\s?Ν\s?[ΗΖ]\s?[Σ΢]Ο\s?[ΥΤ]"),
    ("EVROS", "Evros", "Έβρος", r"[ΕΔ]\s?Β\s?Ρ\s?Ο\s?[ΥΤ]"),
    ("EUBOEA", "Euboea", "Εύβοια", r"[ΕΔ]\s?[ΥΤ]\s?Β\s?Ο\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("EVRYTANIA", "Evrytania", "Ευρυτανία", r"[ΕΔ]\s?[ΥΤ]\s?Ρ\s?[ΥΤ]\s?[ΤΣ]\s?Α\s?Ν\s?[ΙΗ]Α\s?[Σ΢]"),
    ("ZAKYNTHOS", "Zakynthos", "Ζάκυνθος", r"[ΖΕ]\s?Α\s?Κ\s?[ΥΤ]\s?Ν\s?Θ\s?Ο\s?[ΥΤ]"),
    ("ELIS", "Elis", "Ηλεία", r"[ΗΖ]\s?Λ\s?[ΕΔ]\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("IMATHIA", "Imathia", "Ημαθία", r"[ΗΖ]\s?Μ\s?Α\s?Θ\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("HERAKLION", "Heraklion", "Ηράκλειο", r"[ΗΖ]\s?Ρ\s?Α\s?Κ\s?Λ\s?[ΕΔ]\s?[ΙΗ]\s?Ο\s?[ΥΤ]"),
    ("THESPROTIA", "Thesprotia", "Θεσπρωτία", r"Θ\s?[ΕΔ]\s?[Σ΢]\s?Π\s?Ρ\s?Ω\s?[ΤΣ]\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("THESSALONIKI", "Thessaloniki", "Θεσσαλονίκη", r"Θ\s?[ΕΔ]\s?[Σ΢]\s?[Σ΢]\s?Α\s?Λ\s?Ο\s?Ν\s?[ΙΗ]\s?Κ\s?[ΗΖ]\s?[Σ΢]"),
    ("IOANNINA", "Ioannina", "Ιωάννινα", r"[ΙΗ]\s?Ω\s?Α\s?Ν\s?Ν\s?[ΙΗ]\s?Ν\s?Ω\s?Ν"),
    ("KAVALA", "Kavala", "Καβάλα", r"Κ\s?Α\s?Β\s?Α\s?Λ\s?Α\s?[Σ΢]"),
    ("KARDITSA", "Karditsa", "Καρδίτσα", r"Κ\s?Α\s?Ρ\s?[ΔΓ]\s?[ΙΗ]\s?[ΤΣ]\s?[Σ΢]\s?[ΗΖ]\s?[Σ΢]"),
    ("KASTORIA", "Kastoria", "Καστοριά", r"Κ\s?Α\s?[Σ΢]\s?[ΤΣ]\s?Ο\s?Ρ\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("KERKYRA", "Corfu", "Κέρκυρα", r"Κ\s?[ΕΔ]\s?Ρ\s?Κ\s?[ΥΤ]\s?ΡΑ\s?[Σ΢]"),
    ("CEPHALONIA", "Cephalonia", "Κεφαλονιά", r"Κ\s?[ΕΔ]\s?Φ\s?Α\s?Λ\s?Λ\s?[ΗΖ]\s?Ν\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("KILKIS", "Kilkis", "Κιλκίς", r"Κ\s?[ΙΗ]\s?Λ\s?Κ\s?[ΙΗ]\s?[Σ΢]"),
    ("KOZANI", "Kozani", "Κοζάνη", r"Κ\s?Ο\s?[ΖΕ]\s?Α\s?Ν\s?[ΗΖ]\s?[Σ΢]"),
    ("CORINTHIA", "Corinthia", "Κορινθία", r"Κ\s?Ο\s?Ρ\s?[ΙΗ]\s?Ν\s?Θ\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("CYCLADES", "Cyclades", "Κυκλάδες", r"Κ\s?[ΥΤ]\s?Κ\s?Λ\s?Α\s?[ΔΓ]\s?Ω\s?Ν"),
    ("LACONIA", "Laconia", "Λακωνία", r"Λ\s?Α\s?Κ\s?Ω\s?Ν\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("LARISSA", "Larissa", "Λάρισα", r"Λ\s?Α\s?Ρ\s?[ΙΗ]\s?[Σ΢][ΗΖ]\s?[Σ΢]"),
    ("LASITHI", "Lasithi", "Λασίθι", r"Λ\s?Α\s?[Σ΢]\s?[ΙΗ]\s?Θ\s?[ΙΗ]\s?Ο\s?[ΥΤ]"),
    ("LESBOS", "Lesbos", "Λέσβος", r"Λ\s?[ΕΔ]\s?[Σ΢]Β\s?Ο\s?[ΥΤ]"),
    ("LEFKADA", "Lefkada", "Λευκάδα", r"Λ\s?[ΕΔ]\s?[ΥΤ]\s?Κ\s?Α\s?[ΔΓ]\s?Ο\s?[Σ΢]"),
    ("MAGNESIA", "Magnesia", "Μαγνησία", r"Μ\s?Α\s?Γ\s?Ν\s?[ΗΖ]\s?[Σ΢]\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("MESSENIA", "Messenia", "Μεσσηνία", r"Μ\s?[ΕΔ]\s?[Σ΢]\s?[Σ΢]\s?[ΗΖ]\s?Ν\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("XANTHI", "Xanthi", "Ξάνθη", r"Ξ\s?Α\s?Ν\s?Θ\s?[ΗΖ]\s?[Σ΢]"),
    ("PELLA", "Pella", "Πέλλα", r"Π\s?[ΕΔ]\s?Λ\s?Λ\s?[ΗΖ]\s?[Σ΢]"),
    ("PIERIA", "Pieria", "Πιερία", r"Π\s?[ΙΗ]\s?[ΕΔ]\s?Ρ\s?[ΙΗ]\s?Α\s?[Σ΢]"),
    ("PREVEZA", "Preveza", "Πρέβεζα", r"Π\s?Ρ\s?[ΕΔ]\s?Β\s?[ΕΔ]\s?[ΖΕ]\s?[ΗΖ]\s?[Σ΢]"),
    ("RETHYMNO", "Rethymno", "Ρέθυμνο", r"Ρ\s?[ΕΔ]\s?Θ\s?[ΥΤ]\s?Μ\s?Ν\s?[ΗΖ]\s?[Σ΢]"),
    ("RHODOPE", "Rhodope", "Ροδόπη", r"Ρ\s?Ο\s?[ΔΓ]\s?Ο\s?Π\s?[ΗΖ]\s?[Σ΢]"),
    ("SAMOS", "Samos", "Σάμος", r"[Σ΢]\s?Α\s?Μ\s?Ο\s?[ΥΤ]"),
    ("SERRES", "Serres", "Σέρρες", r"[Σ΢]\s?[ΕΔ]\s?Ρ\s?Ρ\s?Ω\s?Ν"),
    ("TRIKALA", "Trikala", "Τρίκαλα", r"[ΤΣ]\s?Ρ\s?[ΙΗ]\s?Κ\s?Α\s?Λ\s?Ω\s?Ν"),
    ("PHTHIOTIS", "Phthiotis", "Φθιώτιδα", r"Φ\s?Θ\s?[ΙΗ]\s?Ω\s?[ΤΣ]\s?[ΙΗ]\s?[ΔΓ]\s?Ο\s?[Σ΢]"),
    ("FLORINA", "Florina", "Φλώρινα", r"Φ\s?Λ\s?Ω\s?Ρ\s?[ΙΗ]\s?Ν\s?[ΗΖ]\s?[Σ΢]"),
    ("PHOCIS", "Phocis", "Φωκίδα", r"Φ\s?Ω\s?Κ\s?[ΙΗ]\s?[ΔΓ]\s?Ο\s?[Σ΢]"),
    ("CHALKIDIKI", "Chalkidiki", "Χαλκιδική", r"[ΧΥ]\s?Α\s?Λ\s?Κ\s?[ΙΗ]\s?[ΔΓ]\s?[ΙΗ]\s?Κ\s?[ΗΖ]\s?[Σ΢]"),
    ("CHANIA", "Chania", "Χανιά", r"[ΧΥ]\s?Α\s?Ν\s?[ΙΗ]\s?Ω\s?Ν"),
    ("CHIOS", "Chios", "Χίος", r"[ΧΥ]\s?[ΙΗ]\s?Ο\s?[ΥΤ]"),
]


def parse_price(val: Optional[str]) -> Optional[float]:
    """Parse Greek price format ('2,154', ' 2, 154 ', or '-') to float."""
    if not val or val.strip() in ("-", "", "—"):
        return None
    clean = val.replace(" ", "").replace(",", ".").strip()
    try:
        return round(float(clean), 3)
    except ValueError:
        return None


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extract plain text across all PDF pages using pypdf or pdfplumber."""
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            return "".join(page.extract_text() or "" for page in pdf.pages)
    except ImportError:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        return "".join(page.extract_text() or "" for page in reader.pages)


def download_bulletin(target_date: datetime.date) -> Tuple[bytes, datetime.date]:
    """
    Fetch the PDF bulletin for target_date.
    If the ministry server returns HTML (bulletin not yet uploaded), search back up to 7 days.
    """
    headers = {"User-Agent": USER_AGENT}
    for offset in range(8):
        current_date = target_date - datetime.timedelta(days=offset)
        filename = f"IMERISIO_DELTIO_ANA_NOMO_{current_date:%d_%m_%Y}.pdf"
        url = f"{BASE_URL}/{filename}"
        logger.info("Checking bulletin URL: %s", url)

        try:
            resp = requests.get(url, headers=headers, timeout=20)
            content_type = resp.headers.get("content-type", "").lower()
            
            # fuelprices.gr returns 200 with text/html when file is not yet available
            if resp.status_code == 200 and "application/pdf" in content_type:
                logger.info(
                    "Found valid PDF for date %s (%d bytes)",
                    current_date.isoformat(),
                    len(resp.content),
                )
                return resp.content, current_date
            else:
                logger.warning(
                    "Bulletin for %s not available (status=%s, content-type=%s)",
                    current_date.isoformat(),
                    resp.status_code,
                    content_type,
                )
        except requests.RequestException as e:
            logger.warning("Error fetching %s: %s", url, e)

    raise RuntimeError(
        f"No bulletin found within 7 days of target date {target_date.isoformat()}"
    )


def parse_prefectures(pdf_bytes: bytes, bulletin_date: datetime.date) -> List[Dict[str, Any]]:
    """
    Extract prices for Unleaded 95, Unleaded 100, Diesel, and LPG
    (and Heating Diesel if in winter season) for all 51 Greek prefectures.
    """
    text = extract_text_from_pdf(pdf_bytes)
    if not text:
        raise ValueError("PDF content is empty or could not be decoded.")

    # In winter (Oct 15 - Apr 30), a 5th column 'Diesel Θέρμανσης' is present
    has_heating = bool(re.search(r"Diesel\s*Θέρμανσης", text, re.IGNORECASE))
    logger.info("Bulletin column layout: %s", "5 columns (Winter / Heating)" if has_heating else "4 columns (Standard)")

    # Match price values: e.g. "2,154", "0,973", "-"
    val_regex = r"(\d[,\.]\s?\d\s?\d\s?\d|-)"
    num_cols = 5 if has_heating else 4
    col_pattern = r"\s+".join([val_regex] * num_cols)

    results: List[Dict[str, Any]] = []
    missing_prefectures: List[str] = []

    for pref_id, name_en, name_el, pref_re in PREFECTURES_CONFIG:
        # Structure: ΝΟΜΟΣ <PREFECTURE> <P1> <P2> <P3> <P4> [<P5>]
        regex = r"Ν\s?Ο\s?Μ\s?Ο\s?[Σ΢]\s+" + pref_re + r"\s+" + col_pattern
        match = re.search(regex, text)

        if match:
            item: Dict[str, Any] = {
                "prefecture": name_en,
                "prefecture_el": name_el,
                "unleaded_95": parse_price(match.group(1)),
                "unleaded_100": parse_price(match.group(2)),
                "diesel": parse_price(match.group(3)),
                "lpg": parse_price(match.group(4)),
                "date": bulletin_date.isoformat(),
            }
            if has_heating:
                item["diesel_heating"] = parse_price(match.group(5))

            results.append(item)
        else:
            missing_prefectures.append(name_en)

    if missing_prefectures:
        logger.warning(
            "Missing %d/%d prefectures: %s",
            len(missing_prefectures),
            len(PREFECTURES_CONFIG),
            ", ".join(missing_prefectures),
        )

    if len(results) < 40:
        raise ValueError(
            f"Extraction threshold failed: only {len(results)}/{len(PREFECTURES_CONFIG)} prefectures extracted."
        )

    logger.info("Successfully extracted fuel prices for %d prefectures.", len(results))
    return results


def main():
    parser = argparse.ArgumentParser(description="Scrape Greek prefecture fuel prices.")
    parser.add_argument(
        "--date",
        type=str,
        default=None,
        help="Target date in YYYY-MM-DD format (defaults to today).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="data",
        help="Directory to write output JSON files.",
    )
    args = parser.parse_args()

    if args.date:
        target_date = datetime.date.fromisoformat(args.date)
    else:
        target_date = datetime.date.today()

    logger.info("Starting scraper for target date: %s", target_date.isoformat())

    # Download PDF
    pdf_bytes, actual_date = download_bulletin(target_date)

    # Parse data
    data = parse_prefectures(pdf_bytes, actual_date)

    # Ensure output directory exists
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Write data/prefectures_latest.json
    latest_file = os.path.join(output_dir, "prefectures_latest.json")
    with open(latest_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info("Saved latest data to: %s", latest_file)

    # Also save dated snapshot for historical reference
    dated_file = os.path.join(output_dir, f"prefectures_{actual_date.isoformat()}.json")
    with open(dated_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info("Saved dated snapshot to: %s", dated_file)


if __name__ == "__main__":
    main()
