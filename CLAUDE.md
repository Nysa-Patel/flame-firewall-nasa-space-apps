# FireLine (NASA Space Apps)

Will a material burn in a given spacecraft atmosphere? Answered from real NASA PSI combustion tests.

## Layout

- `scrape_psi.py`, `load_to_tigerdata.py`, `schema.sql` — data pipeline into Tiger Data (Postgres). See README.md.
- `worker/fireline-verdict/` — Cloudflare Worker. `POST /verdict` with `{ o2_fraction, pressure_atm, material }` returns facts only (nearest tested bucket, relation, evidence, fallback). It never decides PASS/CAUTION/FAIL. `GET /health` for a DB check.
- `web/index.html` — the front end. One static file, no build step, no dependencies. Deployed as Cloudflare Static Assets from the worker's `wrangler.jsonc` (`assets.directory` points at `web/`), so `wrangler deploy` / `wrangler dev` in the worker folder serves the UI at `/` and the API on the same origin. API URL defaults to the page's origin when the worker serves it, otherwise to the deployed worker `https://fireline-verdict.fireline-team.workers.dev`; override with `?api=` or the Settings field. `?mock=1` (or the Settings checkbox) runs on synthetic data with a visible banner.
  - Scenario picker: ISS / Lunar / Spacesuit / Custom presets (psia in the UI, atm to the worker), a candidate-material list, and a pressure sweep from nominal down to a depress floor (4 points). Each material × point is one `POST /verdict`; requests run 4 at a time.
  - Verdict, confidence and recommendation are computed in the page from the worker's facts (see "How verdicts are computed" on the page and the `assess()` function). Keep that rule and the on-page explanation in sync.
  - Investigation browser calls `GET /investigations` and expects `[{ accession, title, doi, objective, n_tests }]`. The worker does not have that route yet; until it does the page shows a placeholder list plus investigations cited by the analysis.
  - Mission Control box calls `POST /chat` with `{ message }` and shows `reply`.

## Rules for the front end

- Keep it a single `web/index.html` unless there is a strong reason not to. Touch as few files as possible.
- The PASS/CAUTION/FAIL verdict is a documented heuristic in the page, not NASA guidance. Always show the evidence behind it (bucket counts, relation, investigation id, DOI) next to the badge, and never present it as a certification.
- Send `o2_fraction` as a 0–1 fraction (the form takes a percent and divides by 100). The worker rejects values over 1.

### Design

- Direction: ISS interior, not sci-fi. Light cool-grey panel background, blue-black ink, one accent: the blue of a microgravity flame. The hero's combustion-chamber viewport with the flame sphere that reacts to the oxygen field is the single bold element; everything else stays quiet.
- Tokens live in `:root` in `web/index.html`; use them, do not hardcode new colors.
  - Paper `#eef1f4`, surface `#ffffff`, ink `#14202b`, secondary ink `#51616f`, rules `#d3dbe2` / `#aab6c2`.
  - Accent (microgravity flame blue) `#1f5eea` with tint `#e3ecff`. Verdicts: pass `#157a4e`, caution `#9c6208`, fail `#bf3129`, no data `#66727f`, each with a matching `-tint` fill.
- Type: Archivo variable from Google Fonts, one family. Width axis does the hierarchy: condensed heavy (`font-stretch` 72–88%) for the headline, section headings and verdict words; regular width for body. Tabular numerals on. Monospace only for the worker URL field.
- Structure over decoration: rules between rows instead of cards, no all-caps eyebrow labels, no middle-dot meta strings, sentence case everywhere including verdict words. Rank numbers are allowed because the ranking is a real sequence.
- Verdicts are always the word plus color plus the evidence line. Never rely on color alone to convey meaning.
- Motion: only the flame's size and color transition when oxygen changes, and it respects `prefers-reduced-motion`. No entrance animations.

### Must work on mobile

- Layout must work at 360px width with 16px side gutters and no horizontal page scroll. Wide tables go inside a `.wrap` container that scrolls on its own.
- Tap targets at least 40px tall.

### Must be keyboard accessible

- Every control reachable and operable with Tab, Enter and Space. Visible focus ring on every interactive element (do not remove outlines).
- Every input has a `<label for>`. Use real `<button>`, `<a>`, `<details>` elements, not clickable divs.
- Loading and error states are announced in text, not just by a spinner or color change.

### Before saying a change is done

- Open the page in a browser (Playwright MCP if it is configured), run a query against the worker or a fixture, and take a screenshot at desktop and at 375px width.
- Check the quantified result, the fallback result, and an error response all render. Do not report done on syntax checks alone.
- If the worker is not reachable, say so explicitly in the final message instead of implying it was tested end to end.

## Worker rules

- Do not put credentials in the repo. The Tiger Data password lives in the Cloudflare Hyperdrive binding and in the gitignored `.env` / `.dev.vars`.
- Keep the response shape stable; the front end depends on it. If a field is added, update `web/index.html` in the same change.
