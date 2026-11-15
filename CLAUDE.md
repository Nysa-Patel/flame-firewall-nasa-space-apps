# FireLine (NASA Space Apps)

Will a material burn in a given spacecraft atmosphere? Answered from real NASA PSI combustion tests.

## Layout

- `scrape_psi.py`, `load_to_tigerdata.py`, `schema.sql` — data pipeline into Tiger Data (Postgres). See README.md.
- `worker/fireline-verdict/` — Cloudflare Worker. `POST /verdict` with `{ o2_fraction, pressure_atm, material }` returns facts only (nearest tested bucket, relation, evidence, fallback). It never decides PASS/CAUTION/FAIL. `GET /health` for a DB check.
- `web/index.html` — the front end. One static file, no build step, no dependencies. Deployed as Cloudflare Static Assets from the worker's `wrangler.jsonc` (`assets.directory` points at `web/`), so `wrangler deploy` / `wrangler dev` in the worker folder serves the UI at `/` and the API on the same origin. API URL defaults to the page's origin when the worker serves it, otherwise to the deployed worker `https://fireline-verdict.fireline-team.workers.dev`; override with `?api=` or the Settings field. `?mock=1` (or the Settings checkbox) runs on synthetic data with a visible banner.
  - Scenario picker: ISS / Lunar / Mars / Spacesuit / Custom presets (psia in the UI, atm to the worker), a candidate-material list, and a pressure sweep from nominal down to a depress floor (4 points). Each material × point is one `POST /verdict`; requests run 4 at a time.
  - Verdict, confidence and recommendation are computed in the page from the worker's facts (see "How verdicts are computed" on the page and the `assess()` function). Keep that rule and the on-page explanation in sync.
  - Investigation browser calls `GET /investigations` and expects `[{ accession, title, doi, objective, n_tests }]`. The worker does not have that route yet; until it does the page shows a placeholder list plus investigations cited by the analysis.
  - Mission Control box calls `POST /chat` with `{ message }` and shows `reply`.
  - Mission environment (top of the navy section, `#env-h`): a schematic of where the chosen preset is (Earth and the ISS, the Moon, Mars), a close/wide toggle, a live 3D view of the same place (NASA's Eyes on the Solar System in an `<iframe>` with `?embed=true`, created only when the stage scrolls into view and skipped when offline; this is the page's one outside runtime dependency), a link that opens it in a new tab, and an optional link to a locally running OpenSpace desktop app (WebSocket `ws://localhost:4682/websocket`, Lua camera commands). Its side panel mirrors the form's oxygen and pressure and the latest ranking. It is display only: it computes no verdicts and receives them through the `fireline:ranked` event that `render()` dispatches. The Mars preset's figures (34% oxygen, 8.2 psia, 7 psia floor) and the lunar and Mars camera sites are placeholders to confirm.

## Rules for the front end

- Keep it a single `web/index.html` unless there is a strong reason not to. Touch as few files as possible.
- The PASS/CAUTION/FAIL verdict is a documented heuristic in the page, not NASA guidance. Always show the evidence behind it (bucket counts, relation, investigation id, DOI) next to the badge, and never present it as a certification.
- Send `o2_fraction` as a 0–1 fraction (the form takes a percent and divides by 100). The worker rejects values over 1.

### Design

- Direction: white and NASA red (chosen 14 Nov 2026). A huge navy "FireLine." title on a white-grey top section with the flame chamber beside it, then a deep navy section holding results, investigations and chat as navy cards. Pill-shaped buttons and presets.
- Tokens live in `:root` in `web/index.html`; use them, do not hardcode new colors.
  - Light section: grey `#eef1f5`, paper `#ffffff`, navy ink `#0b1b33`, secondary ink `#47556b`. Navy section: `#0b1f3f`, cards `#132b52` / `#1b3766`, text `#f2f5fa`, secondary `#b6c3d8`.
  - Accent red `#d42a1c` with white text is for actions in the light section only (Rank materials, How it works, the orbit line). In the navy section red means Fail and nothing else: buttons there are white, links and focus rings are sky blue `#9cc4ff`.
  - Verdicts on navy: pass teal `#45d2c3`, caution amber `#f6b445`, fail coral `#ff8a7a`, no data `#a9b4c6`.
- Icons are Tabler Icons (MIT) fetched once from Iconify and inlined as CSS variables (`--i-*`), so there is no runtime dependency. Presets, section headings and Settings use them as masks; result cards show a round badge (droplet for liquid fuels, stack for solids) chosen by the decoration script from the material name.
- Verdicts are always word + shape icon + evidence line: tick in a circle (pass), ! in a triangle (caution), cross in an octagon (fail), dash in a square (no data). Never color alone.
- Type: Space Grotesk from Google Fonts, one family, weights 300 to 700. Sentence case everywhere.
- The flame is a WebGL fragment shader on a canvas inside the chamber (blue ringed sphere in cabin air, orange fireball in rich oxygen). It reads the oxygen field, pauses off screen, and falls back to the CSS `#flame` gradient when WebGL is missing. No 3D models or images.
- The page has two scripts. The first is the app (settings, worker calls, verdict logic, rendering). The second is decoration only (WebGL flame, count-up numbers, pointer spotlight on cards, table roles): it reads what the app rendered and must never fetch or change app state. A third script is the Mission environment block; it also never fetches or changes app state, and it must never open the OpenSpace socket on its own. Chrome shows a local-network permission prompt when a public page reaches for localhost, so the socket opens only when the user presses Connect, with no automatic retries.
- Motion: a particle fireball loader on first paint (ember to white-hot as it advances, with the same dots blazing rightward on the bar), then the page rises as that loader leaves; flame reacting to oxygen; results appearing or re-ranking as one View Transition; the same fireball curtain while a ranking is in flight; a height tween on the investigation list when filtering; numbers counting up when results arrive; a spotlight following the pointer on cards. Everything else under 0.5s, and all of it off or static under `prefers-reduced-motion`. One entrance sequence on page load is allowed (the fireball, then the top bar drops in, hero rises, flame chamber settles). Rest state visible if it never runs. No per-section fades, no scroll effects, no parallax.
- Hero background: a second WebGL canvas (`canvas.wave-gl`, first child of `body`, behind everything, pointer-events none) paints a controlled sphere of gold fire-dust, plus a sparse field of the same dots, drifting slowly and bending toward the pointer. Keep the dust light (alpha under 0.65, warm gold and ember only) so navy text over it stays readable. It pauses off screen and shows one still frame under `prefers-reduced-motion`. It lives in the decoration script.
- The hero facts strip (2,954 tests, 26 investigations, 361 with oxygen and pressure) is static text taken from the worker's `/health` and the README on 14 Nov 2026. Update it by hand if the data is reloaded.
- Hero type: mega wordmark at weight 700 with -0.06em tracking; the question headline at weight 500; big numerals at weight 300. Buttons are pills that grow 4% on hover and press to 97%. The navy section carries a 5% grain layer.

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
