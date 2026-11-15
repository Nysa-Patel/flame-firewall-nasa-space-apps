# Phenox: critique and change options

Written 15 Nov 2026 from a code review, live probes of the deployed worker, and the official "Flame in Freefall" brief. Not yet checked in a browser. Each item is a problem followed by an option for fixing it.

## Done in `web/index.html` on 15 Nov 2026 (not deployed)

- B1, B2, B3, B5: new reading rule (Goes out / Mixed / Keeps burning / No data), nulls and disruptions left out, 2-bucket distance cap, Wilson interval.
- B6 (partly): burn-rate unit shown when the bucket has one.
- A1 (partly): investigation list ranked for the chosen oxygen, with area filters and search. No objectives until the worker has `/investigations`.
- A7: microgravity note on the lunar and Mars presets and in the method text.
- A9 (partly): CSV export of every test behind a ranking. No fitted curve.
- D3: oxygen × pressure table per ranked fuel. D4: fuel picker. D1 (partly): tour cut to 4 steps and fixed.
- C1 (partly): unreviewed uploads are tagged on cards. C2 (partly): chat uses the form's atmosphere.

Still open: A2 summaries, A3/A6 backfill, A4 airflow, A5 suppression data, A8 compare, A10, A11, B4, C1 upload key, D2, D5 redeploy, and the chat prompt's PASS/CAUTION/FAIL wording.

## What the brief asks for

An SI-powered, web-based dashboard that **summarizes, ranks and interprets combustion science investigations**. Suggested user goals:

1. Identify the investigations most relevant to crew environments (spacecraft, stations, lunar and Martian bases, pressurized rovers).
2. Extract data that supports predictive modelling of flammability and fire scenarios.
3. Highlight research that informs next-generation fire safety controls and equipment.

Audience: professors, students, aerospace researchers and engineers. Optional extras: Earth applications, comparing investigations, hardware families, partial gravity.

## A. Gaps against the brief

**A1. We rank materials; the brief ranks investigations.** There is no investigation browser on the page at all (its CSS remains, the HTML is gone).
- Option: add `GET /investigations` and make an investigation ranking the first thing in the navy section: each of the 26 scored for relevance to the chosen mission (fuel type, oxygen range covered, airflow, hardware), with the reason shown. Keep the material view as the drill-down.

**A2. The SI is a side widget.** The brief puts SI in the title; ours is a floating chat that needs oxygen and pressure in every question.
- Option: generate a short written summary per investigation (objective, fuels, what varied, what was measured, key finding) and a "why this matters for your mission" line per ranking, each tied to the rows and DOI it came from. Keep the chat, but default it to the form's atmosphere and have it explain the page's result.

**A3. Solids are the focus of the brief and we have none.** BASS, BASS-II and Saffire are named as the flammability studies; PMMA, Nomex and Kapton all return "No data".
- Option: backfill pressure from investigation-level constants (flagged "assumed from investigation") so the solid tests enter the envelope. 1,154 tests have oxygen; only 361 have both.

**A4. Airflow is ignored.** The brief calls it important in microgravity; BASS varies it.
- Option: extract flow speed as a third condition and show it on cards and in the evidence table.

**A5. Suppression and detection are missing (objective 3).** The page says suppressants are not in the data, but FLEX was the suppression experiment (carbon dioxide and helium dilution), and SAME / SAME-R cover smoke detection.
- Option: pull diluent type and fraction from the FLEX raw columns and show "how much CO2 or helium put it out". Add a "Detect, prevent, suppress" filter on investigations.

**A6. High-oxygen data exists but is not used.** CFI-G ran up to 85% oxygen; our tested range stops at 34% because those rows lack pressure. The spacesuit preset is judged from 30–35% oxygen tests.
- Option: same backfill as A3, then cite CFI-G as the nearest evidence for the suit and lunar presets.

**A7. Lunar and Mars verdicts do not say the data is microgravity.** PSI has no partial-gravity data.
- Option: a fixed line on those presets: "All evidence is microgravity; partial gravity is untested. Microgravity and Earth results bound it. LUCI and FM2 will add data." Mention E-FIELD Flames as the nearest proxy.

**A8. No comparison between investigations.**
- Option: a compare table for two or three investigations: objective, fuels with sample shape and size, conditions, what varied, sensors. Group by hardware family (CIR/MDCA droplets, CIR/ACME gases, MSG flow duct).

**A9. No export for modelling (objective 2).**
- Option: "Download this evidence as CSV" on every ranking and investigation, with units and source file columns, plus a fitted extinction-limit curve with an uncertainty band.

**A10. No Earth-applications angle (optional).**
- Option: one short section: water-mist extinguishers, smoke detection, firefighter gear, each linked to the investigation behind it.

**A11. The story is missing.** The brief opens with Apollo 1, Mir, Apollo 13 and the Artemis II alarm.
- Option: one line under the hero headline, for example Apollo 1's pure-oxygen cabin next to the spacesuit preset.

## B. Science and data (highest priority)

**B1. The verdict says heptane is safe in cabin air.** Live at ISS conditions: heptane Pass (confidence 87), methanol Pass, dodecane Fail with "Heptane ranks as a Pass". Every FLEX droplet was ignited and burned; "Extinction" and "Disruption" describe how the flame ended.
- Option: drop Pass/Caution/Fail for fuels. Report what was measured: share that self-extinguished, burn rate, lowest oxygen at which the flame was sustained. Change the headline to "How does it burn up there?".

**B2. Missing outcomes count as burned.** Dodecane fails only because its 10 tests have no recorded outcome.
- Option: leave nulls out of the denominator; show "outcome not recorded".

**B3. Pure oxygen comes back Caution.** Heptane at 100% oxygen is judged from a bucket 14 widths away.
- Option: beyond about 2 bucket widths show "No data near these conditions" and the trend direction only.

**B4. "SE" (183 tests) and "FT" (89) are ignored.** These look like the solid-material results.
- Option: map them into the outcome vocabulary with definitions cited from the source.

**B5. Confidence out of 99 is an invented formula.**
- Option: show an interval: "3 of 4 extinguished, 95% range 30–95%".

**B6. Burn rates mix units** (mm-based droplet constant and mg/s).
- Option: never average across `burn_header`; label the unit per card.

## C. Trust and security

**C1. `/import` is an open write.** The page sends no upload key, and `render()` never reads `verified`, although the page promises uploads are marked everywhere.
- Option: require the key, exclude uploads from verdicts by default, tag any card that uses them.

**C2. Chat issues its own Pass/Caution/Fail**, which can disagree with the page, and refuses questions without a pressure (including the placeholder's own example).
- Option: see A2.

## D. Experience

**D1. Slow to the first result.** Forced loader, then a 7-step scroll-blocking tour, then a loader per ranking. Tour step 5 targets `#method`, hidden until a ranking runs; step 3 says results are below the mission environment, they are above.
- Option: auto-run the ISS preset on load, 3-step tour after the first result, loader capped near 1.5 s.

**D2. Mission environment is heavy and carries no analysis.**
- Option: collapse it behind "Show location"; give the space to the heatmap (D3).

**D3. No picture of the envelope on the main page.**
- Option: an inline oxygen × pressure heatmap per fuel with the mission point and depress line drawn on it.

**D4. Materials are free text with substring matching** ("ethanol" matches Methanol, empty matches everything).
- Option: a picker built from fuels that exist, with test counts.

**D5. Deployed worker is behind the repo** (`/points` returns 404 live). Hero says 26 investigations; 22 have tests.
- Option: redeploy before judging; refresh the hero facts from `/health`.

## Suggested order

1. B1–B4 (the verdict rule and the envelope view).
2. A3 / A6 backfill, then A1 investigation ranking and A2 summaries.
3. D3 heatmap, A9 export, A5 suppression.
4. C1, D1, D5 before the demo.
