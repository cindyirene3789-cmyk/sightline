# Sightline build plan

Portfolio prototype. Static site: open `index.html` directly, host free on Netlify Drop or GitHub Pages. No backend, no paid services.

## File layout

| File | Role |
|---|---|
| `index.html` | Page shell, fonts, PapaParse, SEO tags |
| `styles.css` | Tokens (light + dark), components, layouts, print |
| `engine.js` | Pure logic, no DOM and no storage: demo data, `analyze()`, CSV detection, column matching, parsing, upsert. Shared by the app and the tests |
| `app.js` | UI: router, views, events, localStorage |
| `tests.html` | Runs engine tests in the browser, shows pass/fail |
| `samples/` | Fictional CSV exports (Meta, Google, TikTok, Shopee) plus `errors/` files for testing error messages |

`engine.js` is split from `app.js` so the rules can be tested without the UI.

## Data model (localStorage key `sightline-db-v1`)

```
{
  version: 1,
  agency:  { name },
  clients: [{ id, name, createdAt }],
  rows:    [{ clientId, platform, date: 'YYYY-MM-DD', campaign, spend, impressions, clicks, conversions, revenue, importId }],
  imports: [{ id, clientId, platform, fileName, rowCount, added, updated, at }],
  isDemo:  boolean
}
```

Rows are unique on client + platform + date + campaign. Re-importing the same file updates rows instead of duplicating them.

## Insight rules (`THRESHOLDS` in engine.js)

Each client is compared on its latest 7 days of data against the 7 days before.

1. **Tracking break (critical).** Spend on each of the last 3 days with zero conversions, after averaging at least 1 conversion a day over the previous 14 days. This suppresses the CPA and ROAS rules, which would only be symptoms.
2. **Spend up, conversions flat (warning).** Spend up 25% or more while conversions are up less than 5%.
3. **CPA up (warning at 20%, critical at 40%).** Needs at least 5 conversions in both weeks. Skipped if rule 2 fired, unless the rise reaches the critical level.
4. **ROAS down (warning at 20%, critical at 35%).** Only when revenue is tracked in both weeks.
5. **CTR down 15% or more (warning).** Needs at least 1,000 impressions in both weeks.
6. **Spend down 40% or more (warning).**
6b. **Campaign CPA jump (warning).** One campaign with at least 15% of the client's spend has its CPA rise 40%, even when the client's totals look steady. Added after testing showed campaign problems were being diluted.
7. **Winner (opportunity).** ROAS up 20% or more, or CPA down 15% or more.
8. **Stale data (warning).** Latest row is more than 10 days old.

Each rule names the campaign that drove the change and carries its evidence (the numbers plus the threshold). Actions are ranked by severity, then by the S$ at stake.

A client's health is **At risk** if any finding is critical, **Watch** if any is a warning, and **Healthy** otherwise.

## Phases

- [x] 1. Foundation: tokens, shell, nav, storage, demo data. *Verify:* page loads, theme toggle works, nothing is saved until demo is clicked.
- [x] 2. Engine and tests. *Verify:* every test passes in tests.html, and the demo shows at-risk, watch and healthy clients.
- [x] 3. Welcome screen. *Verify:* the preview renders and localStorage stays empty.
- [x] 4. Overview. *Verify:* headline counts match the table.
- [x] 5. Client detail and brief. *Verify:* charts render, copy brief works.
- [x] 6. CSV import. *Verify:* all 4 samples are detected, and the 3 error files show their messages.
- [x] 7. Alerts and printable report. *Verify:* the badge count matches the list, and print preview is clean.
- [x] 8. Settings. *Verify:* rename works, reset and delete use in-page confirmation.
- [x] Final: 375, 768 and 1440 in light and dark, no sideways scroll, clean console, contrast ratios, README.

---

# Round 2: features adapted from agency tools (2026-09-28)

Scope was confirmed by Cindy: all eight features below. The constraints haven't changed: still static, free, no login, and data stays in the browser. Live account connections, scheduled emails, Slack alerts, share links and AI write-ups stay out of scope because they need a backend.

## Data model additions (same key `sightline-db-v1`, all fields optional so older saves still load)

```
settings: { period: 'w7'|'d14'|'d30'|'mtd', thresholds: {…agency overrides}, logo: dataURL|null, brandColor: '#rrggbb'|null }
clients[i].budget:     { monthly, targetCpa, targetRoas }   // numbers or null
clients[i].thresholds: { cpaUpWarn, cpaUpCrit, roasDownWarn, roasDownCrit }  // per-client overrides
notes: [{ id, clientId, date, text, createdAt }]
```

Threshold order: built-in defaults, then agency overrides, then client overrides.

## Steps

- [x] A1. Periods: last 7, 14 or 30 days vs the period before, or this month to date vs the same days last month. Rule text uses period labels, not "this week". A comparison needs a full previous period. *Verify:* tests for each period's date boundaries.
- [x] A2. Threshold overrides (agency, then client). *Verify:* tests that an override changes whether a rule fires.
- [x] A3. Channel breakdown per client and agency-wide: spend share, CPA and ROAS per platform. *Verify:* shares add up to 100%.
- [x] A4. Change breakdown: spend and conversion change per platform and campaign (these add up exactly), plus the counterfactual "CPA if this segment hadn't changed". *Verify:* tests with known numbers.
- [x] A5. Budgets and targets: month-to-date spend, projected month-end, over/under pace warnings, budget already exceeded (critical), and CPA/ROAS target misses. *Verify:* tests.
- [x] A6. Data health: missing days, a platform that stopped sending data, no revenue tracked, no conversions tracked. Kept separate from performance status. *Verify:* tests.
- [x] A7. Demo: 70 days of data, budgets and targets on some clients, a few notes, one data gap. *Verify:* the demo still shows at-risk, watch and healthy clients.
- [x] B1. Period selector on the overview, client page and report, saved in settings.
- [x] B2. Overview: pacing column, agency channel table, data-issues link.
- [x] B3. Client page: budget and targets form plus pacing bar, channels table, change breakdown (platform or campaign toggle), notes (add, delete with in-page confirm), note markers on charts.
- [x] B4. Settings: alert rules editor with validation (warning below critical, sensible ranges) and a reset option; branding (logo upload of 200 KB or less as PNG, JPG, WebP or SVG, plus brand colour).
- [x] B5. Report: logo, brand colour, pacing, channels, notes for the period. Print keeps the brand colour.
- [x] B6. Import page: data health section.
- [x] C. Verify: tests, every screen at 375, 768 and 1440 in light and dark, print, overflow audit, console, old save loads, redeploy.
