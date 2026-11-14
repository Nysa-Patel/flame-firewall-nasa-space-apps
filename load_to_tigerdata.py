"""
Load scraped PSI data (output/investigations.json, output/experimental_tests.jsonl)
into Tiger Data, normalizing the wildly inconsistent per-investigation columns
into a common subset (fuel/material, O2 fraction, pressure in atm, burn rate,
outcome) while keeping every original column in `raw` JSONB.

Run scrape_psi.py first.
"""

import json
import os
import re
from datetime import datetime
from pathlib import Path

import psycopg2
import psycopg2.extras

OUT_DIR = Path(__file__).parent / "output"

# ---------------------------------------------------------------------
# Column-name heuristics. PSI investigations each shipped their own CSV
# with their own header names (confirmed by inspecting all 26 files) --
# there is no shared schema, so we match on substrings.
# ---------------------------------------------------------------------

FUEL_PATTERNS = [
    r"fuel\s*(sample\s*material|type|bottle)?",
    r"material",
    r"sample\s*material",
    r"sample\s*type",
]
O2_PATTERNS = [
    r"o2|oxygen",
    r"^o\s.*composition",        # NASA style: "O initial ambient composition; mole fraction"
    r"percent\s*o2",
]
PRESSURE_PATTERNS = [
    r"pressure",
]
BURN_RATE_PATTERNS = [
    r"burn(ing)?\s*rate",
    r"weight loss rate",
]
OUTCOME_PATTERNS = [
    r"test end",
    r"result",
    r"self.?ext",
    r"flow term",
]
DATE_PATTERNS = [
    r"\btest date\b",
    r"\bdate\b",
    r"\bgmt date\b",
]


def find_col(row: dict, patterns):
    """Return the first key whose (cleaned) header matches any pattern."""
    for key in row.keys():
        cleaned = key.strip().lstrip("﻿").lower()
        for p in patterns:
            if re.search(p, cleaned):
                return key
    return None


def parse_float(val):
    if val is None:
        return None
    s = str(val).strip()
    if s == "" or s.lower() in ("n/a", "na", "none", "-"):
        return None
    s = re.sub(r"[^\d.\-eE]", "", s)
    try:
        return float(s)
    except ValueError:
        return None


def normalize_o2(raw_value, header_name: str):
    """PSI O2 columns show up as mole fraction (0-1) or percent (0-100)
    depending on the investigation. Normalize everything to 0-1 fraction."""
    v = parse_float(raw_value)
    if v is None:
        return None
    header = header_name.lower()
    if "percent" in header or "%" in header_name or v > 1.5:
        return v / 100.0
    return v


def normalize_pressure(raw_value, header_name: str):
    """Normalize to atmospheres. Headers seen: mmHg, atm, bar."""
    v = parse_float(raw_value)
    if v is None:
        return None
    header = header_name.lower()
    if "mmhg" in header:
        return v / 760.0
    if "bar" in header:
        return v * 0.986923
    # already atm (or unitless small number close to 1) -> assume atm
    return v


DATE_FORMATS = ["%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y", "%d-%b-%Y"]


def normalize_date(raw_value):
    if raw_value is None:
        return None
    s = str(raw_value).strip()
    if not s:
        return None
    for fmt in DATE_FORMATS:
        try:
            parsed = datetime.strptime(s, fmt)
        except ValueError:
            continue
        # Sanity clamp: PSI's own source CSVs have at least one typo'd year
        # (e.g. "5/15/2103" in the BASS data). Combustion research on PSI
        # predates this challenge, so anything outside this window is a
        # data-entry error upstream, not a real test date.
        if 1960 <= parsed.year <= 2026:
            return parsed
        return None
    return None


def normalize_row(raw_row: dict, investigation_fallback_date):
    fuel_col = find_col(raw_row, FUEL_PATTERNS)
    o2_col = find_col(raw_row, O2_PATTERNS)
    pressure_col = find_col(raw_row, PRESSURE_PATTERNS)
    burn_col = find_col(raw_row, BURN_RATE_PATTERNS)
    outcome_col = find_col(raw_row, OUTCOME_PATTERNS)
    date_col = find_col(raw_row, DATE_PATTERNS)

    test_date = normalize_date(raw_row.get(date_col)) if date_col else None
    test_date_estimated = test_date is None
    if test_date is None:
        test_date = investigation_fallback_date

    return {
        "fuel_material": (raw_row.get(fuel_col) or "").strip() or None if fuel_col else None,
        "o2_fraction": normalize_o2(raw_row.get(o2_col), o2_col) if o2_col else None,
        "pressure_atm": normalize_pressure(raw_row.get(pressure_col), pressure_col)
        if pressure_col
        else None,
        "burn_rate": parse_float(raw_row.get(burn_col)) if burn_col else None,
        "outcome": (raw_row.get(outcome_col) or "").strip() or None if outcome_col else None,
        "test_date": test_date,
        "test_date_estimated": test_date_estimated,
    }


def parse_iso_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d")
    except ValueError:
        return None


def main():
    db_url = os.environ["TIGER_DATA_URL"]
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor()

    investigations = json.loads((OUT_DIR / "investigations.json").read_text())
    print(f"Loading {len(investigations)} investigations...")

    inv_fallback_date = {}
    for inv in investigations:
        start = parse_iso_date(inv.get("investigationStartDate")) or datetime(2000, 1, 1)
        inv_fallback_date[inv["accession"]] = start

        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO investigations (
                accession, title, research_area, sub_research_area, project_type,
                flight_platform, investigation_start, investigation_end,
                objective, approach, hypothesis, research_impacts, raw
            ) VALUES %s
            ON CONFLICT (accession) DO UPDATE SET
                title = EXCLUDED.title,
                raw = EXCLUDED.raw
            """,
            [
                (
                    inv["accession"],
                    inv.get("title"),
                    inv.get("researchArea"),
                    inv.get("subResearchArea"),
                    inv.get("projectType"),
                    inv.get("flightProgram"),
                    parse_iso_date(inv.get("investigationStartDate")),
                    parse_iso_date(inv.get("investigationEndDate")),
                    inv.get("objective"),
                    inv.get("approach"),
                    inv.get("hypothesis"),
                    inv.get("researchImpacts"),
                    json.dumps(inv),
                )
            ],
        )
    conn.commit()
    print("Investigations loaded.")

    rows_to_insert = []
    n_lines = 0
    with (OUT_DIR / "experimental_tests.jsonl").open() as f:
        for line in f:
            n_lines += 1
            rec = json.loads(line)
            inv_id = rec["investigation_id"]
            raw_row = rec["raw"]
            norm = normalize_row(raw_row, inv_fallback_date.get(inv_id, datetime(2000, 1, 1)))
            rows_to_insert.append(
                (
                    inv_id,
                    rec["source_file"],
                    norm["test_date"],
                    norm["test_date_estimated"],
                    norm["fuel_material"],
                    norm["o2_fraction"],
                    norm["pressure_atm"],
                    norm["burn_rate"],
                    norm["outcome"],
                    json.dumps(raw_row),
                )
            )

    print(f"Inserting {len(rows_to_insert)} test rows (from {n_lines} scraped lines)...")
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO experimental_tests (
            investigation_id, source_file, test_date, test_date_estimated,
            fuel_material, o2_fraction, pressure_atm, burn_rate, outcome, raw
        ) VALUES %s
        """,
        rows_to_insert,
        page_size=500,
    )
    conn.commit()

    cur.execute("REFRESH MATERIALIZED VIEW flammability_envelope;")
    conn.commit()

    cur.execute("SELECT count(*) FROM experimental_tests;")
    print("Total rows in experimental_tests:", cur.fetchone()[0])
    cur.execute(
        "SELECT count(*) FROM experimental_tests WHERE o2_fraction IS NOT NULL AND pressure_atm IS NOT NULL;"
    )
    print("Rows with both O2 and pressure normalized:", cur.fetchone()[0])
    cur.execute("SELECT count(*) FROM flammability_envelope;")
    print("Flammability envelope buckets:", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
