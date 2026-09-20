# Handoff

State of the project as of **2026-09-20**. Read this once at the start of a fresh session,
then work from `CLAUDE.md`.

The site is **built and rendering but has never been deployed, and the three data fetchers
have never been executed.** That is the whole shape of the remaining work.

---

## What exists

A complete, building, rendering dashboard:

- Three tabs (JWST / Roman / Starship), each with current location, current mission and latest
  data sections.
- A Three.js scene of the Sun–Earth–L2 neighbourhood with both telescopes on their real
  trajectories, plus a second scene for Starship (procedural vehicle model + orbital ground
  track), bloom post-processing, procedural Earth and starfield.
- Three fetchers writing static JSON snapshots, and a GitHub Actions workflow that fetches,
  builds and deploys to Cloudflare Pages every 30 minutes.
- Seeded data captured live on 2026-09-20 so the scene renders correctly on a fresh clone with
  no network.
- A headless smoke test (`npm run shots`) that screenshots every tab at two breakpoints and
  asserts the page populated.

---

## Verification status — read this before trusting anything

| Area | Status | How |
|---|---|---|
| Horizons API contract (endpoints, params, response format, error text) | **Verified live** | Real responses fetched 2026-09-20 |
| Roman exists in Horizons as NAIF `-211` | **Verified live** | Horizons lookup API |
| Reference frame is Ecliptic J2000 | **Verified live** | Sun's geocentric Z ≈ -9,000 km out of 1.5e8 |
| Seed ephemeris values | **Verified live**, cross-checked | Roman's range matches an independent single-point query digit-for-digit |
| LL2 response shape (all 18 paths `shape()` reads) | **Verified live** | `lldev.thespacedevs.com` sample |
| Spaceflight News API response shape | **Verified live** | v4 sample |
| Build | **Verified** | `npm run build` clean |
| Rendering, all tabs, both breakpoints | **Verified** | `npm run shots` passes; screenshots reviewed |
| **`fetch-telescopes.mjs` executing** | ❌ **never run** | container network blocked all four API hosts |
| **`fetch-starship.mjs` executing** | ❌ **never run** | same |
| **`fetch-news.mjs` executing** | ❌ **never run** | same |
| **GitHub Actions workflow** | ❌ **never run** | not pushed yet |
| **Cloudflare deploy** | ❌ **never run** | project not created yet |

The parsing logic was written against real captured responses and the field paths are
confirmed, so the risk is in **execution paths** — network handling, error branches, the
coverage-window clamp retry — not in the shape of what gets parsed.

---

## Task queue, in order

### 1. Run the three fetchers locally — do this first
```bash
npm run fetch:telescopes
LL2_DEV=1 npm run fetch:starship    # dev mirror: no rate limit, stale data
npm run fetch:news
```
Then inspect each `public/data/*.json`. Specifically check:
- `telescopes.json` — `bodies.roman.arcClamped` should be `true`, and `coverage.notAfter`
  should name a date. This exercises the coverage-window retry, the most intricate code in the
  repo. If `arc` is short or empty, the clamp logic needs work.
- `bodies.jwst.arc` should have ~78 points and trace a closed loop.
- `starship.json` — `next` should be a real upcoming flight. Re-run **without** `LL2_DEV=1`
  once to confirm the production endpoint and rate-limit handling.
- `news.json` — the seed has empty feeds; all three should populate.

Then `npm run build && npm run shots` to confirm real data renders as well as seed data.

### 2. Deploy
Follow `README.md` § Setup. Needs: a GitHub repo, `npx wrangler pages project create` as
**Direct Upload**, and the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets. Add
`LL2_API_KEY` too — GitHub runners share IPs and 15 req/hour is shared across them.

### 3. Watch the first scheduled run
The workflow's per-step `continue-on-error` means a fetcher can fail without failing the
deploy. Check the Actions step summary, which reports each fetcher's outcome. A site that
deploys with stale data and no visible error is this architecture's main failure mode.

### 4. Add the post-deploy smoke test
Append to `.github/workflows/deploy.yml` after the wrangler step:
```yaml
      - run: npx playwright install --with-deps chromium
      - run: npm run smoke https://space-dashboard.pages.dev
```
This catches the failure mode above — it asserts data actually loaded, not just that files
uploaded.

### 5. Roman's phase transition — a real deadline
Roman arrives at L2 around **late November 2026**. When it does:
- `bodies.roman.phase` flips from `cruise` to `operational` (threshold: within 400,000 km of
  L2, in `fetch-telescopes.mjs`).
- The cruise progress bar is replaced by an "offset from L2" stat.
- The eyebrow changes to "Operational · Sun–Earth L2 orbit".

That logic is written but **has never run against arrival-phase data**. Worth forcing a test by
temporarily raising the threshold and confirming the UI switches cleanly. Also: once Roman is
station-keeping, its Horizons arc should stop being short-arc-clamped, and the warning note
should disappear on its own — verify it does.

---

## Worthwhile next features, roughly by value

- **JWST observing schedule.** STScI publishes weekly observing schedules and MAST has an API
  (`mast.stsci.edu/api/v0/`). "What is Webb looking at this week" is the most compelling thing
  the JWST tab is currently missing. Not yet investigated — treat the API shape as unknown.
- **Roman commissioning milestones.** NASA's Roman blog has an RSS feed. During cruise and
  commissioning this is where the real news is, and it is higher-signal than the general news
  search.
- **A daily "what changed" narrative.** Diff consecutive snapshots and have Claude write a
  short summary as another static JSON file. This needs the data committed to git for history —
  currently it is not, deliberately, to avoid repo bloat. Decide that tradeoff before building.
- **Starship flight history.** `starship.json` already carries `previous` and `outcomes` from
  LL2; nothing renders them yet. A flight-by-flight outcome strip would be cheap and good.
- **Deep-link the Starship 3D mode** (`#starship/profile`) so a specific view is shareable.

---

## Verified reference facts

Do not re-derive these; they cost real API calls to establish.

| Fact | Value |
|---|---|
| JWST NAIF id | `-170` (also `@jwst`, `500@-170`) |
| Roman NAIF id | `-211`, alias "RST Nancy Grace" |
| Sun / Moon ids | `10` / `301` |
| Horizons default reference plane | **Ecliptic of J2000.0** |
| Horizons geocentric center | `500@399` |
| Roman ephemeris starts | `2026-Aug-30 11:59:09 TDB` (33 min after liftoff) |
| Roman arc ended (as of capture) | `2026-Oct-12 12:58` — **this moves**, expect it to have advanced |
| JWST arc coverage | through `2031-Sep-06` |
| Roman launch | 2026-08-30 11:26:04 UTC, Falcon Heavy, KSC LC-39A |
| L2 ratio | `0.0100038` × Sun distance, anti-Sun direction |
| Starbase Pad 2 | 25.99677 N, -97.15799 W (from LL2) |
| LL2 rate limit | 15 req/hr unauthenticated, 30 with free key, **CORS disabled** |
| Cloudflare Pages free builds | 500/month — Git-connected builds only, not Direct Upload |
| Workers Free CPU | 10 ms/invocation — too tight to parse Horizons in a Worker, which is why this uses Actions |

As of the 2026-09-20 snapshot: JWST 1.2166M km from Earth (422k km from L2), Roman 1.2265M km
(544k km from L2, ~82% of the way out), L2 at 1.5036M km. Both telescopes happen to be at
nearly the same range from Earth right now, in completely different directions.

---

## Open decisions for the user

1. **Refresh cadence.** Currently 30 minutes. Hourly halves the deploy count if that ever
   matters. Neither is constrained by the Pages build quota under Direct Upload.
2. **Custom domain.** The site will land on `*.pages.dev` by default.
3. **Committing data snapshots to git.** Currently not committed — deploys are built from a
   fresh fetch each run. Committing them enables the "what changed" narrative and gives a
   history to diff, at the cost of ~200 KB per commit, 48 times a day.
4. **Whether to add more programmes.** The tab structure and scene code generalise — another L2
   or deep-space mission would mostly be a new entry in `fetch-telescopes.mjs` plus a panel.
