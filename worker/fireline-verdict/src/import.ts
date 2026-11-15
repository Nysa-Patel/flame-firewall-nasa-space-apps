// Lets a researcher upload a new NASA-style combustion CSV and have it
// normalized into the same schema load_to_tigerdata.py builds, inserted into
// Tiger Data, and folded into the existing views (so new data shows up in
// /verdict and /chat immediately, not as a separate silo).
import type { Sql } from 'postgres';

// ---------------------------------------------------------------------
// Column-name heuristics, ported from psi_pipeline/load_to_tigerdata.py so
// an uploaded CSV is matched the same way the original PSI scrape is.
// ---------------------------------------------------------------------
const FUEL_PATTERNS = [/fuel\s*(sample\s*material|type|bottle)?/i, /material/i, /sample\s*material/i, /sample\s*type/i];
const O2_PATTERNS = [/o2|oxygen/i, /^o\s.*composition/i, /percent\s*o2/i];
const PRESSURE_PATTERNS = [/pressure/i];
const BURN_RATE_PATTERNS = [/burn(ing)?\s*rate/i, /weight loss rate/i];
const OUTCOME_PATTERNS = [/test end/i, /result/i, /self.?ext/i, /flow term/i];
const DATE_PATTERNS = [/\btest date\b/i, /\bdate\b/i, /\bgmt date\b/i];

function findCol(row: Record<string, string>, patterns: RegExp[]): string | null {
  for (const key of Object.keys(row)) {
    const cleaned = key.trim().replace(/^﻿/, '');
    if (patterns.some((p) => p.test(cleaned))) return key;
  }
  return null;
}

function parseFloatLoose(val: unknown): number | null {
  if (val == null) return null;
  const s = String(val).trim();
  if (s === '' || /^(n\/a|na|none|-)$/i.test(s)) return null;
  const cleaned = s.replace(/[^\d.\-eE]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeO2(raw: unknown, header: string): number | null {
  const v = parseFloatLoose(raw);
  if (v == null) return null;
  const h = header.toLowerCase();
  if (h.includes('percent') || header.includes('%') || v > 1.5) return v / 100;
  return v;
}

function normalizePressure(raw: unknown, header: string): number | null {
  const v = parseFloatLoose(raw);
  if (v == null) return null;
  const h = header.toLowerCase();
  if (h.includes('mmhg')) return v / 760;
  if (h.includes('bar')) return v * 0.986923;
  return v;
}

const DATE_FORMATS: Array<(s: string) => Date | null> = [
  (s) => { const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null; },
  (s) => { const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; },
  (s) => { const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null; },
];

function normalizeDate(raw: unknown): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  for (const fmt of DATE_FORMATS) {
    const d = fmt(s);
    if (!d || Number.isNaN(d.getTime())) continue;
    // Sanity clamp: reject obvious typos (e.g. "5/15/2103"), same as the
    // original loader — anything outside this window is a data-entry error.
    if (d.getFullYear() >= 1960 && d.getFullYear() <= 2026) return d;
    return null;
  }
  return null;
}

export interface NormalizedRow {
  fuel_material: string | null;
  o2_fraction: number | null;
  pressure_atm: number | null;
  burn_rate: number | null;
  outcome: string | null;
  test_date: Date;
  test_date_estimated: boolean;
}

function normalizeRow(row: Record<string, string>, fallbackDate: Date): NormalizedRow {
  const fuelCol = findCol(row, FUEL_PATTERNS);
  const o2Col = findCol(row, O2_PATTERNS);
  const pCol = findCol(row, PRESSURE_PATTERNS);
  const burnCol = findCol(row, BURN_RATE_PATTERNS);
  const outcomeCol = findCol(row, OUTCOME_PATTERNS);
  const dateCol = findCol(row, DATE_PATTERNS);

  const parsedDate = dateCol ? normalizeDate(row[dateCol]) : null;
  const estimated = parsedDate == null;

  return {
    fuel_material: fuelCol ? (row[fuelCol] || '').trim() || null : null,
    o2_fraction: o2Col ? normalizeO2(row[o2Col], o2Col) : null,
    pressure_atm: pCol ? normalizePressure(row[pCol], pCol) : null,
    burn_rate: burnCol ? parseFloatLoose(row[burnCol]) : null,
    outcome: outcomeCol ? (row[outcomeCol] || '').trim() || null : null,
    test_date: parsedDate ?? fallbackDate,
    test_date_estimated: estimated,
  };
}

// Small CSV parser: handles quoted fields, escaped quotes ("") and commas
// inside quotes. No external dependency (Workers-friendly).
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\r') continue;
    else if (c === '\n') pushRow();
    else field += c;
  }
  if (field.length || row.length) pushRow();
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
}

export interface ImportResult {
  investigation_id: string;
  rows_parsed: number;
  rows_inserted: number;
  columns_matched: { fuel_material: boolean; o2_fraction: boolean; pressure_atm: boolean; burn_rate: boolean; outcome: boolean; test_date: boolean };
  rows_with_o2_and_pressure: number;
  warnings: string[];
}

export async function importCsv(
  sql: Sql,
  { investigationId, title, csvText, sourceFile }: { investigationId: string; title: string; csvText: string; sourceFile: string },
): Promise<ImportResult> {
  const rawRows = parseCsv(csvText);
  const warnings: string[] = [];
  if (!rawRows.length) throw new Error('No data rows found in that CSV.');
  if (rawRows.length > 5000) throw new Error(`CSV has ${rawRows.length} rows; 5000 is the limit per upload.`);

  const fallbackDate = new Date();
  const normalized = rawRows.map((r) => ({ raw: r, norm: normalizeRow(r, fallbackDate) }));

  const matched = {
    fuel_material: normalized.some((r) => r.norm.fuel_material != null),
    o2_fraction: normalized.some((r) => r.norm.o2_fraction != null),
    pressure_atm: normalized.some((r) => r.norm.pressure_atm != null),
    burn_rate: normalized.some((r) => r.norm.burn_rate != null),
    outcome: normalized.some((r) => r.norm.outcome != null),
    test_date: normalized.some((r) => !r.norm.test_date_estimated),
  };
  (Object.keys(matched) as (keyof typeof matched)[]).forEach((k) => {
    if (!matched[k]) warnings.push(`Couldn't find a "${k.replace('_', ' ')}" column in this CSV — it will be blank for every row.`);
  });

  // Upsert the investigation this upload belongs to (user-attributed, not from PSI).
  await sql`
    INSERT INTO investigations (accession, title, research_area, project_type, raw)
    VALUES (${investigationId}, ${title}, 'User-contributed', 'Community upload', ${sql.json({ source: 'user_upload', uploaded_at: new Date().toISOString(), title })})
    ON CONFLICT (accession) DO UPDATE SET title = EXCLUDED.title`;

  const values = normalized.map(({ raw, norm }) => ({
    investigation_id: investigationId, source_file: sourceFile, test_date: norm.test_date, test_date_estimated: norm.test_date_estimated,
    fuel_material: norm.fuel_material, o2_fraction: norm.o2_fraction, pressure_atm: norm.pressure_atm,
    burn_rate: norm.burn_rate, outcome: norm.outcome, raw: sql.json(raw),
  }));

  await sql`
    INSERT INTO experimental_tests ${sql(values, 'investigation_id', 'source_file', 'test_date', 'test_date_estimated', 'fuel_material', 'o2_fraction', 'pressure_atm', 'burn_rate', 'outcome', 'raw')}`;

  await sql`REFRESH MATERIALIZED VIEW flammability_envelope`;
  await sql`CALL refresh_continuous_aggregate('tests_per_month', NULL, NULL)`;

  const rowsWithBoth = normalized.filter((r) => r.norm.o2_fraction != null && r.norm.pressure_atm != null).length;

  return {
    investigation_id: investigationId,
    rows_parsed: rawRows.length,
    rows_inserted: values.length,
    columns_matched: matched,
    rows_with_o2_and_pressure: rowsWithBoth,
    warnings,
  };
}
