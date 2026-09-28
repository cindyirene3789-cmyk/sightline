# Sightline

Sightline is a portfolio prototype of an "analyst in a box" for independent marketing agencies. It reads the CSV exports agencies already pull from their ad platforms, then shows:

- which clients need attention, over the last 7, 14 or 30 days or month to date
- what changed, and which platform or campaign drove the change
- whether each client is on pace for its monthly budget and hitting its CPA or ROAS targets
- what to do first, with the evidence behind each action
- gaps in the imported data that could make the numbers look wrong

It also keeps dated notes per client (shown on charts and in reports), lets you tune the alert rules for the agency or a single client, and prints branded client reports with your logo and colour.

Everything runs in the browser. There's no backend, no account and no paid service, and imported files never leave the visitor's computer. All money is shown in SGD.

**Everything in the demo is fictional.** The agency, the six clients, the numbers and the sample CSV files are made up for demonstration.

## Run it

- **Locally:** double-click `index.html`. It needs an internet connection the first time, to load the fonts and the CSV reader (PapaParse from cdnjs).
- **Free hosting:** drag the whole `sightline` folder onto [Netlify Drop](https://app.netlify.com/drop), or push it to a GitHub repo and turn on GitHub Pages. There's no build step.
- **Tests:** open `tests.html`. It runs 72 checks on the insight rules, date ranges, budgets, change breakdown, data health and CSV import, and shows pass or fail.

## Try it in two minutes

1. Open the app and click **Try it with demo data**.
2. Read the overview, then open a client for the full weekly brief.
3. Go to **Import**, use **Clear sample data**, and import the four files in `samples/` into one new client. They're one fictional yoga studio across four platforms.
4. Try the files in `samples/errors/` (a `.txt` file, an empty CSV and a CSV without a date column) to see the error messages.

## How the insights work

The insights come from **fixed rules, not a language model**. Each client's current period (last 7, 14 or 30 days, or month to date) is compared with the period before. Every default threshold lives in one `THRESHOLDS` object at the top of `engine.js`. Agencies can override them in Settings, and a client can override the CPA and ROAS rules on its own page (defaults, then agency, then client).

| Severity | Rule |
|---|---|
| Critical | Tracking break: spend on each of the last 3 days with zero conversions, after averaging at least 1 a day over the 14 days before. This suppresses the CPA and ROAS rules, which would only be symptoms. |
| Critical / Warning | Cost per conversion up 40% / 20%, or ROAS down 35% / 20% |
| Warning | Spend up 25% or more while conversions rise less than 5% |
| Warning | Click-through rate down 15% or more |
| Warning | Spend down 40% or more |
| Warning | One campaign with at least 15% of a client's spend has its cost per conversion rise 40%, even when the client's totals look steady |
| Warning | The latest data is more than 10 days old |
| Critical | A client's monthly budget is already spent |
| Warning | Projected month-end spend is 10% above or 15% below the monthly budget (from day 5 of the month) |
| Critical / Warning | Cost per conversion or ROAS misses the client's target by 30% / 10% |
| Opportunity | A campaign's cost per conversion fell 15% or more, or its ROAS rose 20% or more |

Noise guards keep small numbers from triggering alerts:
- Cost and ROAS rules need at least 5 conversions in both weeks.
- CTR rules need 1,000 impressions.
- Spend rules need S$100 of weekly spend.

Each finding names the campaign that drove it and lists its numbers and the threshold. Actions are ranked by severity, then by the S$ at stake. A tracking break always comes first, because it makes every other number unreliable.

**Change breakdown.** For each platform and campaign, Sightline shows the spend and conversion change (these add up exactly to the client total) and asks: "What would the client's CPA be if only this one had repeated its previous numbers?" The gap between that and the actual CPA is its effect.

**Data health** checks for missing days, a platform whose data stops before the others, and exports without conversions or revenue. These are listed separately and don't change a client's status.

A client is **At risk** if any finding is critical, **Watch** if any is a warning, and **Healthy** otherwise.

Agency-wide ROAS only divides by spend from clients whose exports include revenue.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell, fonts, SEO and Open Graph tags |
| `styles.css` | Design tokens (light and dark), components, layouts and print styles |
| `engine.js` | Pure logic with no page or storage access: demo data, `analyze()`, CSV platform detection, column matching, date and number parsing, and import merging |
| `app.js` | Screens, navigation, import flow, events and saving to the browser |
| `tests.html` | Browser test page for `engine.js` |
| `samples/` | Fictional exports for Meta, Google, TikTok and Shopee Ads, plus `errors/` test files |
| `screenshots/` | Renders at 375, 768 and 1440px, light and dark |

Data is saved in the browser's localStorage under `sightline-db-v1`, with a `version` field so the shape can change later. Budgets, notes, settings (period, alert rules, logo, brand colour) were added as optional fields, so saves from the first version still load. If saved data can't be read, the app leaves it untouched and says so, rather than overwriting it.

## About the sample CSV files

The column names follow each platform's export format as closely as possible without access to live ad accounts. **They haven't been checked against real exports.** A real file may need a column or two matched by hand on the import screen.

Lazada Ads and LinkedIn Ads are detected from header names but have no sample files.

Two formatting assumptions:
- Dates such as 04/09/2026 are read as day/month, the usual Singapore format.
- Amounts are assumed to be SGD. A file with another currency in its headers gets a warning, and nothing is converted.

## Design

The visual direction adapts three principles from a dated reference capture of helicone.ai (6 Sep 2026, one viewport). No logos, copy or assets were taken.

1. **Cyan on white and charcoal.** Deep cyan for text and buttons, mid cyan for charts and focus rings, and bright cyan only as a fill or underline. Cyan never means "good": healthy, watch and at risk use separate green, amber and red. Dark mode is a designed charcoal palette, not an inversion.
2. **Headline plus product preview.** The welcome screen uses the real table and brief components, fed by the built-in demo data and labelled "Sample data". Text chips name the supported sources. Nothing is saved until the visitor clicks "Try it with demo data".
3. **Restrained texture.** No gradients or glows. KPIs are separated by thin rules, not cards. Borders are kept for tables, the brief, the preview frame and alerts.

Fonts: Bricolage Grotesque (headlines), IBM Plex Sans (body) and IBM Plex Mono (numbers), each with a system fallback.

### Contrast (WCAG ratios, measured)

| Pair | Light | Dark | Minimum |
|---|---|---|---|
| Body text | 17.68:1 | 15.28:1 | 4.5:1 |
| Secondary text | 7.98:1 | 8.66:1 | 4.5:1 |
| Muted text | 5.21:1 | 5.90:1 | 4.5:1 |
| Muted text on panel | 4.84:1 | 5.47:1 | 4.5:1 |
| Links, accent text | 6.08:1 | 9.98:1 | 4.5:1 |
| Accent text on accent tint | 5.42:1 | 7.53:1 | 4.5:1 |
| Primary button label | 6.08:1 | 10.20:1 | 4.5:1 |
| Chart line, focus ring | 3.68:1 | 7.93:1 | 3:1 |
| Healthy pill | 6.29:1 | 7.46:1 | 4.5:1 |
| Watch pill | 4.86:1 | 7.12:1 | 4.5:1 |
| At risk pill | 5.70:1 | 6.06:1 | 4.5:1 |
| Worse change text | 6.57:1 | 6.93:1 | 4.5:1 |
| Better change text | 7.13:1 | 8.96:1 | 4.5:1 |
| Alert badge | 6.57:1 | 6.93:1 | 4.5:1 |
| Input borders | 3.02:1 | 3.10:1 | 3:1 |

## Known limits

- The demo data is dated to the day before you load it. If you come back more than 10 days later, every demo client correctly shows a "data is old" warning. Loading the sample data again in Settings refreshes it.
- Browser storage holds a few megabytes. The app shows a message if it fills up, but very large multi-year exports may not fit.
- The CSV reader loads from the internet, so the app can't import files while fully offline.

## Features adapted from agency tools

Round 2 adapted features from established agency platforms, keeping Sightline's approach of evidence on every call and no logins:

| Feature | Inspired by | Sightline's version |
|---|---|---|
| Budget pacing and targets | Optmyzr budget pacing | Projects month-end spend and flags misses, with the numbers behind each flag |
| Channel comparison | ReportsMate cross-channel view | Spend share, CPA and ROAS per platform, per client and agency-wide |
| Custom alert rules | Optmyzr rule builder | Editable thresholds for the agency and per client, with validation |
| Branded reports | AgencyAnalytics white-label | Logo and brand colour on printed reports, stored in the browser |
| Change breakdown | Optmyzr PPC Investigator | A counterfactual "CPA without this change" per platform or campaign |
| Flexible date ranges | Most reporting tools | Last 7, 14 or 30 days, or month to date vs the same days last month |
| Client notes | Annotations in reporting tools | Dated notes on charts, in the brief and in reports |
| Data health check | Adalysis audits | Missing days, stopped platforms, and missing conversion or revenue columns |

Features those tools have that need a backend (live account connections, scheduled emails, Slack alerts, share links, AI write-ups) are listed below instead.

## Next steps (would need a backend)

These were cut on purpose and aren't built:

- Logins and team sharing
- Automatic sync with ad platform APIs, instead of CSV exports
- Scheduled email and Slack alerts
- A real AI model for briefs and plain-English questions
- Sample files for Lazada Ads and LinkedIn Ads, verified against real exports
