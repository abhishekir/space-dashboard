# Handoff

State of the project as of **2026-09-20**. Read this once at the start of a fresh session,
then work from `CLAUDE.md`.

The site is **built and rendering but has never been deployed, and the three data fetchers
have never run against the live APIs.** That is the whole shape of the remaining work.

**2026-09-20 update — task 1 is done.** All three fetchers have now run against the live APIs
and every check in the task passes; see *Task 1 results* below. Getting there found the
telescope fetcher **fatally broken** in two independent ways, neither reachable without
executing it. Tasks 2-5 are unchanged, except that task 5's premise now actually holds.

The sandbox could not reach the APIs (egress policy, 403 on CONNECT, `example.com` blocked
too — it is a default-deny allowlist, nothing to do with these hosts). The fetchers were run on
a GitHub Actions runner instead, via `workflow_dispatch`.

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
| Horizons clamp + transient retry | **Verified offline** | `npm run test:horizons`, 8 cases |
| `fetch-telescopes.mjs` against live Horizons | **Verified live** | Actions run 2, 2026-09-20 23:17 UTC |
| `fetch-starship.mjs` against live LL2 | **Verified live** | same run, production endpoint, no key |
| `fetch-news.mjs` against live SNAPI | **Verified live** | same run, all three feeds populated |
| JWST arc point count and loop closure | **Verified live** | 79 points, 92k km gap over a 2,686k km span |
| **GitHub Actions workflow** | **Verified** | runs green end to end, deploy correctly skipped |
| **Cloudflare deploy** | ❌ **never run** | project not created yet |

The parsing logic was written against real captured responses and the field paths are
confirmed, so the risk is in **execution paths** — network handling, error branches, the
coverage-window clamp retry — not in the shape of what gets parsed. That judgement was right:
the clamp retry is exactly where the breakage was.

### Fetcher bugs found and fixed (2026-09-20)

Replaying the real captured responses through `fetch-telescopes.mjs` surfaced three defects in
`scripts/lib/horizons.mjs`, all on the retry path, none reachable without executing it:

1. **The clamp never advanced, so every telescope fetch hard-failed.** `ymd()` truncates
   `START_TIME` to a date, so Roman's request went out as `2026-08-30` (midnight). Horizons
   rejects that against an ephemeris starting `11:59:09` that day — but the guard asked
   `lim >= startD` against the in-memory `12:30`, read false, and re-sent an identical request
   until the attempt budget ran out. `fetch-telescopes.mjs` could never have completed a run.
   Comparisons are now made against the truncated value actually sent.
2. **Coverage was always `{null, null}`.** Coverage is only ever stated in an *error* response,
   and the success path parsed it out of the *successful* reply. It is now carried across
   attempts, so `coverage.notAfter` names a date as the seed always claimed it would.
3. **`arcClamped` could never clear.** It was set by a start clamp as well as an end clamp, and
   Roman's launch-day start clamps on every run forever — so the short-arc warning would have
   been permanently stuck on. It now tracks the end clamp only, which is what the UI warns
   about. This is what task 5 below depends on.

Retries also went from 3 attempts to 4: Roman's real case needs exactly 3, which left no margin.

A fourth defect showed up the moment the fetchers first ran for real:

4. **One transient 503 sank the whole telescope fetch.** The very first CI run died 0.4s in on
   `Horizons HTTP 503 for 10`. `rawQuery` threw on any non-OK status, so a single 503 on any of
   the six requests a refresh makes killed the run — and with `continue-on-error` the site would
   have kept serving the previous snapshot with nothing going red. 5xx, 429 and connection
   failures now get two retries with a 0.5s/1s backoff; other 4xx still fail immediately, since
   a malformed request will not fix itself. The next run succeeded. Whether the retry fired or
   Horizons had simply recovered is not distinguishable from the logs — but the exposure was
   real either way, and it is now covered.

`scripts/test-horizons.mjs` (`npm run test:horizons`, also a CI step) locks all four in across
8 cases. It fails against the pre-fix file, which is how each one was confirmed to be real.

---

## Task queue, in order

### 1. Run the three fetchers — DONE (2026-09-20)

All three ran green on a GitHub Actions runner at 23:17 UTC. Every check in the original task
passes:

| check | expected | live result |
|---|---|---|
| `bodies.roman.arcClamped` | `true` | yes |
| `bodies.roman.coverage.notAfter` | names a date | `2026-Oct-12 13:01:09` |
| `bodies.jwst.arc` | ~78 points, closed loop | 79 points, first-to-last gap 92k km over a 2,686k km span |
| `starship.json` `next` | a real upcoming flight | Starship Flight 14 / Starlink Group 31-1, 2026-09-28 12:15 UTC |
| `news.json` | all three feeds populate | jwst 10 · roman 10 · starship 8 |

Two things the old notes predicted, both confirmed: Roman's arc end **moved**, 12:58:00 →
13:01:09, and `tidy()` in `horizons.mjs` parses the real Horizons error wording, which had only
ever been tested against a replay.

Live snapshot at that moment: JWST 1.2298M km from Earth (451k from L2), Roman 1.2497M km
(563k from L2), L2 at 1.5027M km. Roman's arc is 42 points at a 1-day step.

Starship ran against the **production** LL2 endpoint with no API key and succeeded, so the
production path and its rate-limit handling are exercised. It took 11.5s versus 3s on the
previous run — LL2 is slow from shared runner IPs and the 15 req/hr cap is shared across them,
so `LL2_API_KEY` is still worth adding in task 2.

Still not verified: `LL2_DEV=1` against the dev mirror. The production path is the one that
matters and it works, so this is a convenience for local iteration, not a gap.

**A fetcher failing does not fail the run** — `continue-on-error` is deliberate. Check the
step summary, which now reports what each snapshot actually contains, not just step outcomes.

### 2. Deploy
Follow `README.md` § Setup. Needs: a GitHub repo, `npx wrangler pages project create` as
**Direct Upload**, and the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets. Add
`LL2_API_KEY` too — GitHub runners share IPs and 15 req/hour is shared across them.

### 3. Watch the first scheduled run
The workflow's per-step `continue-on-error` means a fetcher can fail without failing the
deploy. A site that deploys with stale data and no visible error is this architecture's main
failure mode, and step outcomes alone do not catch it — a fetcher can exit 0 having written a
thinner payload than yesterday.

`scripts/summarize-data.mjs` now reports what each snapshot actually contains into the step
summary: arc point counts and spans, whether Roman's arc is end-clamped, the next Starship
flight, article counts per feed, and each file's age. Seed data and the LL2 dev mirror are
called out explicitly, because both look like a healthy fetch from the outside. It earned its
place on the first run, flagging `⚠️ SEED DATA, fetcher did not run` when Horizons 503'd.

So: read the snapshot table, not just the outcome list.

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
should disappear on its own — verify it does. (Before 2026-09-20 it could not have: the start
clamp kept `arcClamped` true forever. Fixed, and covered by the `romanArrived` case in
`npm run test:horizons`.)

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
| Roman arc ended | `2026-Oct-12 13:01:09` as of 2026-09-20 23:17 UTC (was `12:58` at 08:00) — **this moves** |
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
