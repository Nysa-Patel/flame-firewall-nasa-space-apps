"""
FireLine data pipeline: pull combustion investigations + per-test experimental
tables from NASA's Physical Science Informatics (PSI) repository.

Endpoints (reverse-engineered from the PSI web app's own network traffic):
  1. Search:    GET /geode-py/ws/repo/search?term=...&source=psi&type=investigation
  2. Detail:    GET /geode-py/ws/repo/investigations/{accession}
                 -> includes an "experimentalTable" list of {file_name, version}
  3. Download:  GET /geode-py/ws/studies/{accession}/download?file={file_name}&version={v}&redirect=false
                 -> returns a presigned S3 URL (as plain text)
  4. The S3 URL itself returns the raw CSV.

Output (written to ./output/):
  investigations.json        - full metadata for every matched investigation
  experimental_tests.jsonl   - one row per test, across all investigations,
                                tagged with investigation_id + original columns
                                preserved under "raw"
  schema.sql                 - suggested Postgres/Tiger Data schema
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://psi.nasa.gov"
SEARCH_TERMS = ["combustion", "flammability", "fire"]  # union, deduped by accession
OUT_DIR = Path(__file__).parent / "output"
OUT_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "FireLine-SpaceApps-2026/1.0 (research pipeline)"}


def get_json(url: str):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_text(url: str):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        # Some PSI-authored CSVs were saved as Windows-1252 (e.g. curly quotes).
        return raw.decode("cp1252")


def search_investigations(term: str):
    url = (
        f"{BASE}/geode-py/ws/repo/search?"
        f"term={urllib.parse.quote(term)}&source=psi&type=investigation"
        f"&sort=Public%20Release%20Date&order=desc"
    )
    data = get_json(url)
    hits = data.get("hits", {}).get("hits", [])
    return [h["_source"] for h in hits]


def fetch_investigation_detail(accession: str):
    url = f"{BASE}/geode-py/ws/repo/investigations/{accession}"
    return get_json(url)


def download_experimental_table(accession: str, file_name: str, version: int):
    dl_url = (
        f"{BASE}/geode-py/ws/studies/{accession}/download?"
        f"file={urllib.parse.quote(file_name)}&version={version}&redirect=false"
    )
    s3_url = get_text(dl_url)
    return get_text(s3_url)


def parse_csv(text: str):
    """Minimal CSV parser (stdlib csv module, handles quoting properly)."""
    import csv
    import io

    reader = csv.DictReader(io.StringIO(text))
    return list(reader)


def main():
    seen = {}
    for term in SEARCH_TERMS:
        for inv in search_investigations(term):
            seen[inv["Accession"]] = inv
    print(f"Found {len(seen)} unique investigations across {SEARCH_TERMS}")

    all_investigations = []
    all_tests = []

    for i, accession in enumerate(sorted(seen.keys(), key=lambda a: int(a.split("-")[1]))):
        print(f"[{i+1}/{len(seen)}] {accession} ...")
        try:
            detail = fetch_investigation_detail(accession)
        except Exception as e:
            print(f"  ! failed to fetch detail: {e}")
            continue

        all_investigations.append(detail)

        exp_tables = detail.get("experimentalTable") or []
        if not exp_tables:
            print("  (no experimental table file)")
        for et in exp_tables:
            file_name = et.get("file_name")
            version = et.get("version", 1)
            if not file_name or not file_name.lower().endswith(".csv"):
                continue
            try:
                csv_text = download_experimental_table(accession, file_name, version)
                rows = parse_csv(csv_text)
            except Exception as e:
                print(f"  ! failed to download/parse {file_name}: {e}")
                continue

            print(f"  + {file_name}: {len(rows)} rows, {len(rows[0]) if rows else 0} columns")
            for row in rows:
                all_tests.append(
                    {
                        "investigation_id": accession,
                        "investigation_title": detail.get("title"),
                        "source_file": file_name,
                        "raw": row,
                    }
                )

        time.sleep(0.3)  # be polite to NASA's servers

    (OUT_DIR / "investigations.json").write_text(
        json.dumps(all_investigations, indent=2), encoding="utf-8"
    )
    with (OUT_DIR / "experimental_tests.jsonl").open("w", encoding="utf-8") as f:
        for row in all_tests:
            f.write(json.dumps(row) + "\n")

    print(f"\nWrote {len(all_investigations)} investigations -> investigations.json")
    print(f"Wrote {len(all_tests)} test rows -> experimental_tests.jsonl")


if __name__ == "__main__":
    main()
