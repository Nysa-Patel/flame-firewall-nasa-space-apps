# Phenox data pipeline

Pulls real combustion data from NASA's PSI repository and loads it into Tiger Data.

## Setup

```
python3 -m venv .venv
./.venv/bin/pip install psycopg2-binary
```

Create a `.env` file (gitignored, ask Nysa for the connection string):

```
TIGER_DATA_URL=postgres://...
```

## Run

```
set -a && source .env && set +a
./.venv/bin/python -c "import psycopg2,os; psycopg2.connect(os.environ['TIGER_DATA_URL']).cursor().execute(open('schema.sql').read())"  # first time only
./.venv/bin/python scrape_psi.py
./.venv/bin/python load_to_tigerdata.py
```

## What's in the database

- `investigations` — one row per PSI investigation (FLEX, BASS, Saffire-III, etc.), full metadata + citations.
- `experimental_tests` — one row per real test (~2,950 rows across 26 investigations). Hypertable, partitioned by `test_date`, compressed. Has normalized columns (`fuel_material`, `o2_fraction`, `pressure_atm`, `burn_rate`, `outcome`) where we could extract them, plus the full original row in `raw` (jsonb) always.
- `tests_per_month` — continuous aggregate, testing cadence over time.
- `flammability_envelope` — materialized view bucketing tests by O2%/pressure, with avg burn rate + extinction/disruption counts per bucket. Refresh with `REFRESH MATERIALIZED VIEW flammability_envelope;` after any reload.

## Known gaps (for whoever builds the verdict engine)

- Only ~360 of ~2,950 rows have both `o2_fraction` and `pressure_atm` populated — column names vary wildly per investigation and some only report pressure/O2 as a constant for the whole investigation, not per test.
- `fuel_material` extraction is best-effort string matching, not a clean enum — expect messy values like `"2 cm pmma sphere"`.
- `test_date_estimated = true` means we didn't find a real date in that row and fell back to the investigation's start date — don't trust it for anything time-sensitive.
