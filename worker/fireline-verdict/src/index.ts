// FireLine "Person B" Worker.
// Job: given { o2_fraction, pressure_atm, material }, return FACTS from Tiger Data.
// It never decides PASS/CAUTION/FAIL and never writes explanations. That is Person D's layer.
import postgres from 'postgres';
import { handleChat } from './chat';
import { importCsv } from './import';

export interface Env { HYPERDRIVE: Hyperdrive; GEMINI_API_KEY: string; AI_GATEWAY_ACCOUNT_ID: string; AI_GATEWAY_ID: string; CF_AIG_TOKEN?: string; UPLOAD_KEY?: string }
export type Sql = ReturnType<typeof postgres>;

// ---- how flammability_envelope buckets work (from its view definition) ----
// o2_bucket       = width_bucket(o2_fraction,   0, 1, 20) -> bucket n covers [(n-1)*0.05, n*0.05)
// pressure_bucket = width_bucket(pressure_atm,  0, 2, 20) -> bucket n covers [(n-1)*0.10, n*0.10)
// Bucket 0 / 21 mean "outside the range"; NULL pressure_bucket means the test had no pressure.
const O2_W = 0.05;
const P_W = 0.1;
const o2Range = (b: number): [number, number] => [round((b - 1) * O2_W), round(b * O2_W)];
const pRange = (b: number): [number, number] => [round((b - 1) * P_W), round(b * P_W)];
const round = (x: number, d = 3) => Number(x.toFixed(d));

const HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: HEADERS });

const clip = (s: unknown, n = 600) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s ?? null);
const likePattern = (m: string) => (m ? `%${m.replace(/[\\%_]/g, (c) => '\\' + c)}%` : '%');
// Community CSV uploads get accession ids prefixed "USER-" (see import.ts). Everything
// else came from the original NASA PSI scrape. Callers (the page, the chat prompt) use
// this to flag unreviewed data instead of presenting it with NASA's authority.
const isVerified = (investigationId: string) => !investigationId.startsWith('USER-');

export interface VerdictInput { o2: number; p: number; material: string }

export async function buildVerdict(sql: Sql, { o2, p, material }: VerdictInput) {
  const pattern = likePattern(material);
  const notes: string[] = [
    'Extinction/disruption counts follow the flammability_envelope view: outcomes containing "extinct" / "disrupt". Outcomes like "SE" or "FT" are not counted in either.',
    'avg_burn_rate is null when none of the tests in that bucket recorded a burn rate.',
  ];

  // 1) nearest O2/pressure bucket(s) in flammability_envelope that have BOTH numbers
  const candidates = await sql`
    SELECT e.investigation_id, e.fuel_material, e.o2_bucket::int AS o2_bucket, e.pressure_bucket::int AS pressure_bucket,
           e.n_tests::int AS n_tests, e.avg_burn_rate, e.n_extinctions::int AS n_extinctions, e.n_disruptions::int AS n_disruptions,
           i.title, i.raw->>'doi' AS doi,
           width_bucket(${o2}::float8, 0::float8, 1::float8, 20) AS in_o2_bucket,
           width_bucket(${p}::float8, 0::float8, 2::float8, 20) AS in_pressure_bucket
    FROM flammability_envelope e
    LEFT JOIN investigations i ON i.accession = e.investigation_id
    WHERE e.o2_bucket BETWEEN 1 AND 20
      AND e.pressure_bucket BETWEEN 1 AND 20
      AND COALESCE(e.fuel_material, '') ILIKE ${pattern}
    ORDER BY sqrt(power((${o2}::float8 - (e.o2_bucket - 0.5) * 0.05) / 0.05, 2)
                + power((${p}::float8 - (e.pressure_bucket - 0.5) * 0.1) / 0.1, 2)) ASC,
             e.n_tests DESC
    LIMIT 5`;

  if (candidates.length > 0) {
    const top = candidates[0];

    // 2) range of conditions actually tested for this material (to call it interpolation vs extrapolation)
    const [range] = await sql`
      SELECT min(o2_fraction) AS o2_min, max(o2_fraction) AS o2_max,
             min(pressure_atm) AS p_min, max(pressure_atm) AS p_max, count(*)::int AS n
      FROM experimental_tests
      WHERE o2_fraction BETWEEN 0 AND 1 AND pressure_atm BETWEEN 0 AND 2
        AND COALESCE(fuel_material, '') ILIKE ${pattern}`;

    const toNeighbor = (c: any) => {
      const o2c = round((c.o2_bucket - 0.5) * O2_W);
      const pc = round((c.pressure_bucket - 0.5) * P_W);
      const dO2 = round(o2 - o2c), dP = round(p - pc);
      return {
        investigation_id: c.investigation_id, investigation_title: c.title ?? null, doi: c.doi || null, verified: isVerified(c.investigation_id),
        fuel_material: c.fuel_material,
        o2_bucket: { index: c.o2_bucket, range: o2Range(c.o2_bucket), center: o2c },
        pressure_bucket: { index: c.pressure_bucket, range: pRange(c.pressure_bucket), center: pc },
        n_tests: c.n_tests, avg_burn_rate: c.avg_burn_rate == null ? null : round(Number(c.avg_burn_rate)),
        n_extinctions: c.n_extinctions, n_disruptions: c.n_disruptions,
        distance: { o2_fraction: dO2, pressure_atm: dP, bucket_widths: round(Math.hypot(dO2 / O2_W, dP / P_W), 2) },
      };
    };
    const neighbors = candidates.map(toNeighbor);

    const exact = top.in_o2_bucket === top.o2_bucket && top.in_pressure_bucket === top.pressure_bucket;
    const inside = range && range.o2_min != null &&
      o2 >= range.o2_min && o2 <= range.o2_max && p >= range.p_min && p <= range.p_max;
    const relation = exact ? 'exact_bucket' : inside ? 'interpolation' : 'extrapolation';
    if (relation === 'interpolation') notes.push('"interpolation" only means the input is inside the min/max tested for this material; there may still be untested gaps inside that box.');

    // 3) evidence: the individual tests behind the nearest bucket, with investigation title + DOI
    const evidenceRows = await sql`
      SELECT t.id::text AS test_id, t.investigation_id, t.fuel_material, t.o2_fraction, t.pressure_atm,
             t.burn_rate, t.outcome, t.test_date, t.source_file, i.title, i.raw->>'doi' AS doi
      FROM experimental_tests t
      JOIN investigations i ON i.accession = t.investigation_id
      WHERE t.investigation_id = ${top.investigation_id}
        AND t.fuel_material IS NOT DISTINCT FROM ${top.fuel_material}::text
        AND width_bucket(t.o2_fraction,  0::float8, 1::float8, 20) = ${top.o2_bucket}::int
        AND width_bucket(t.pressure_atm, 0::float8, 2::float8, 20) = ${top.pressure_bucket}::int
      ORDER BY t.test_date NULLS LAST, t.id
      LIMIT 10`;

    return {
      quantified: true,
      input: { o2_fraction: o2, pressure_atm: p, material: material || null },
      nearest: neighbors[0],
      relation,
      tested_range: range && range.o2_min != null
        ? { o2_fraction: [range.o2_min, range.o2_max], pressure_atm: [round(range.p_min), round(range.p_max)], n_tests: range.n }
        : null,
      neighbors: neighbors.slice(1),
      evidence: evidenceRows.map((r: any) => ({
        test_id: r.test_id, investigation_id: r.investigation_id, investigation_title: r.title, doi: r.doi || null, verified: isVerified(r.investigation_id),
        fuel_material: r.fuel_material, o2_fraction: r.o2_fraction, pressure_atm: r.pressure_atm,
        burn_rate: r.burn_rate, outcome: r.outcome || null, test_date: r.test_date, source_file: r.source_file,
      })),
      fallback: null,
      notes,
    };
  }

  // ---- FALLBACK: nothing quantified. Return descriptions instead of inventing a number. ----
  let reason = 'no_quantified_match';
  let investigations: any[] = [];
  if (material) {
    investigations = await sql`
      SELECT i.accession, i.title, i.raw->>'doi' AS doi, i.objective, i.approach, i.raw->>'description' AS description,
             count(*)::int AS n_matching_tests
      FROM experimental_tests t
      JOIN investigations i ON i.accession = t.investigation_id
      WHERE COALESCE(t.fuel_material, '') ILIKE ${pattern}
      GROUP BY i.accession, i.title, i.raw->>'doi', i.objective, i.approach, i.raw->>'description'
      ORDER BY n_matching_tests DESC
      LIMIT 5`;
    if (investigations.length === 0) {
      reason = 'material_not_in_tests_text_search_only';
      investigations = await sql`
        SELECT accession, title, raw->>'doi' AS doi, objective, approach, raw->>'description' AS description, 0 AS n_matching_tests
        FROM investigations
        WHERE title ILIKE ${pattern} OR objective ILIKE ${pattern} OR approach ILIKE ${pattern}
           OR raw->>'description' ILIKE ${pattern}
        LIMIT 5`;
    }
  } else {
    reason = 'no_quantified_match_and_no_material_given';
  }
  if (investigations.length === 0) notes.push('No investigation matched this material at all.');

  return {
    quantified: false,
    input: { o2_fraction: o2, pressure_atm: p, material: material || null },
    nearest: null, relation: null, tested_range: null, neighbors: [], evidence: [],
    fallback: {
      reason,
      investigations: investigations.map((r: any) => ({
        investigation_id: r.accession, title: r.title, doi: r.doi || null, verified: isVerified(r.accession),
        objective: clip(r.objective), approach: clip(r.approach), description: clip(r.description),
        n_matching_tests: r.n_matching_tests,
      })),
    },
    notes,
  };
}

function parseInput(body: any): { ok: true; value: VerdictInput } | { ok: false; error: string } {
  const o2 = Number(body?.o2_fraction), p = Number(body?.pressure_atm);
  if (body?.o2_fraction == null || !Number.isFinite(o2)) return { ok: false, error: 'o2_fraction is required and must be a number (e.g. 0.30 for 30%)' };
  if (o2 < 0 || o2 > 1) return { ok: false, error: `o2_fraction must be between 0 and 1 (got ${o2}). Send 0.30, not 30.` };
  if (body?.pressure_atm == null || !Number.isFinite(p)) return { ok: false, error: 'pressure_atm is required and must be a number (e.g. 0.70)' };
  if (p < 0 || p > 5) return { ok: false, error: `pressure_atm must be between 0 and 5 (got ${p}).` };
  const material = typeof body?.material === 'string' ? body.material.trim() : '';
  return { ok: true, value: { o2, p, material } };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    const { pathname } = new URL(request.url);

    if (pathname === '/health' && request.method === 'GET') {
      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
      try {
        const [r] = await sql`SELECT count(*)::int AS tests_total,
          count(*) FILTER (WHERE o2_fraction IS NOT NULL AND pressure_atm IS NOT NULL)::int AS tests_with_o2_and_pressure
          FROM experimental_tests`;
        return json({ ok: true, ...r });
      } catch (e) {
        return json({ ok: false, error: String((e as Error).message) }, 500);
      } finally { ctx.waitUntil(sql.end()); }
    }

    if (pathname === '/verdict' && request.method === 'POST') {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: 'body must be valid JSON' }, 400); }
      const parsed = parseInput(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);

      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
      try {
        return json(await buildVerdict(sql, parsed.value));
      } catch (e) {
        console.error(e);
        return json({ error: 'database query failed', detail: String((e as Error).message) }, 500);
      } finally { ctx.waitUntil(sql.end()); }
    }

    if (pathname === '/chat' && request.method === 'POST') {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: 'body must be valid JSON' }, 400); }
      const message = (body as any)?.message;
      if (typeof message !== 'string' || !message.trim()) return json({ error: 'message (string) is required' }, 400);

      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
      try {
        return json(await handleChat(sql, env, message));
      } catch (e) {
        console.error(e);
        return json({ error: 'chat failed', detail: String((e as Error).message) }, 500);
      } finally { ctx.waitUntil(sql.end()); }
    }

    if (pathname === '/import' && request.method === 'POST') {
      if (env.UPLOAD_KEY && request.headers.get('x-upload-key') !== env.UPLOAD_KEY) {
        return json({ error: 'missing or wrong x-upload-key header' }, 401);
      }
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: 'body must be valid JSON' }, 400); }
      const b = body as any;
      const csvText = typeof b?.csv === 'string' ? b.csv : null;
      const title = typeof b?.title === 'string' ? b.title.trim() : '';
      const contributorName = typeof b?.contributor_name === 'string' ? b.contributor_name.trim() : '';
      if (!csvText) return json({ error: 'csv (string, the raw CSV text) is required' }, 400);
      if (!title) return json({ error: 'title is required (what this dataset is / who it is from)' }, 400);
      if (!contributorName) return json({ error: 'contributor_name is required (who is submitting this data)' }, 400);
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dataset';
      const investigationId = `USER-${slug}-${Date.now().toString(36)}`;
      const sourceFile = typeof b?.source_file === 'string' ? b.source_file : 'upload.csv';

      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
      try {
        return json(await importCsv(sql, { investigationId, title, csvText, sourceFile, contributorName }));
      } catch (e) {
        console.error(e);
        return json({ error: 'import failed', detail: String((e as Error).message) }, 500);
      } finally { ctx.waitUntil(sql.end()); }
    }

    // One random real test record for the page's clickable chamber. Draws only from NASA PSI
    // rows (never community uploads) that have oxygen, pressure, a fuel and at least one result.
    if (pathname === '/sample' && request.method === 'GET') {
      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
      try {
        const [r] = await sql`
          SELECT t.id::text AS test_id, t.investigation_id, t.fuel_material, t.o2_fraction, t.pressure_atm,
                 t.burn_rate, t.outcome, t.test_date, t.test_date_estimated, t.source_file,
                 i.title, i.raw->>'doi' AS doi, count(*) OVER ()::int AS pool_size
          FROM experimental_tests t
          JOIN investigations i ON i.accession = t.investigation_id
          WHERE t.o2_fraction BETWEEN 0 AND 1 AND t.pressure_atm BETWEEN 0 AND 2
            AND t.fuel_material IS NOT NULL AND btrim(t.fuel_material) <> ''
            AND (t.burn_rate IS NOT NULL OR t.outcome IS NOT NULL)
            AND t.investigation_id NOT LIKE 'USER-%'
          ORDER BY random()
          LIMIT 1`;
        if (!r) return json({ error: 'no records match' }, 404);
        return new Response(JSON.stringify({
          test_id: r.test_id, investigation_id: r.investigation_id, investigation_title: r.title, doi: r.doi || null,
          verified: isVerified(r.investigation_id), fuel_material: r.fuel_material,
          o2_fraction: r.o2_fraction, pressure_atm: r.pressure_atm, burn_rate: r.burn_rate, outcome: r.outcome || null,
          test_date: r.test_date_estimated ? null : r.test_date, source_file: r.source_file, pool_size: r.pool_size,
        }, null, 2), { headers: { ...HEADERS, 'cache-control': 'no-store' } });
      } catch (e) {
        console.error(e);
        return json({ error: 'database query failed', detail: String((e as Error).message) }, 500);
      } finally { ctx.waitUntil(sql.end()); }
    }

    // Every test that recorded an oxygen level, for the 3D model page (web/viz.html). Pressure and
    // burn rate come back null when the test did not record them; the page shows that, it never fills them in.
    // burn_header is the source column the burn rate came from, so the page can tell the units apart.
    // Rows are arrays in `columns` order to keep the payload small. Keep this query in sync with
    // web/points.json, the bundled snapshot the page falls back to.
    if (pathname === '/points' && request.method === 'GET') {
      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
      try {
        const rows = await sql`
          SELECT t.id::text AS test_id, t.investigation_id, t.fuel_material, t.o2_fraction, t.pressure_atm,
                 t.burn_rate, t.outcome,
                 CASE WHEN t.test_date_estimated THEN NULL ELSE to_char(t.test_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS test_date,
                 CASE WHEN t.burn_rate IS NOT NULL AND jsonb_typeof(t.raw) = 'object' THEN
                   (SELECT k FROM jsonb_object_keys(t.raw) k WHERE k ~* 'burn(ing)?\\s*rate|weight loss rate' ORDER BY k LIMIT 1)
                 END AS burn_header
          FROM experimental_tests t
          WHERE t.o2_fraction BETWEEN 0 AND 1
            AND (t.pressure_atm IS NULL OR t.pressure_atm BETWEEN 0 AND 5)
          ORDER BY t.id`;
        const [totals] = await sql`
          SELECT count(*)::int AS tests_total,
                 count(*) FILTER (WHERE investigation_id LIKE 'USER-%')::int AS tests_unverified,
                 count(DISTINCT investigation_id)::int AS investigations_with_tests
          FROM experimental_tests`;
        const invs = await sql`SELECT accession, title, raw->>'doi' AS doi FROM investigations`;
        const investigations: Record<string, { title: string | null; doi: string | null; verified: boolean }> = {};
        for (const i of invs) investigations[i.accession] = { title: i.title ?? null, doi: i.doi || null, verified: isVerified(i.accession) };
        const columns = ['test_id', 'investigation_id', 'fuel_material', 'o2_fraction', 'pressure_atm', 'burn_rate', 'outcome', 'test_date', 'burn_header'];
        return new Response(JSON.stringify({
          generated_at: new Date().toISOString(), summary: totals, investigations, columns,
          rows: rows.map((r: any) => columns.map((c) => r[c] ?? null)),
        }), { headers: { ...HEADERS, 'cache-control': 'public, max-age=300' } });
      } catch (e) {
        console.error(e);
        return json({ error: 'database query failed', detail: String((e as Error).message) }, 500);
      } finally { ctx.waitUntil(sql.end()); }
    }

    return json({ error: 'not found', routes: ['GET /health', 'GET /sample', 'GET /points', 'POST /verdict', 'POST /chat', 'POST /import'] }, 404);
  },
};
