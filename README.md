# Deep Field

A live 3D dashboard for three space programmes: the **James Webb Space Telescope**, the
**Nancy Grace Roman Space Telescope**, and **SpaceX Starship**. One tab each, with current
location, current mission and latest data, over a real-time WebGL scene.

Positions are real. Webb and Roman are drawn where JPL Horizons says they are, on their
actual trajectories, in Ecliptic J2000 geocentric coordinates.

---

## The one architectural decision that matters

**The browser never calls an upstream API.** CI fetches, the browser reads static JSON.

This is not a stylistic preference — every upstream source forbids the alternative:

| Source | Why it can't be called from the page |
|---|---|
| JPL Horizons | No CORS headers. A browser `fetch` fails outright. |
| Launch Library 2 | CORS disabled, **and** 15 requests/hour per IP (30 with a free key). A few dozen visitors would exhaust the quota. |
| Spaceflight News API | CORS works, but there's no reason for every visitor to re-fetch the same articles. |

So: a GitHub Actions job runs every 30 minutes, writes `public/data/*.json`, builds, and
uploads the result to Cloudflare Pages. The page loads three small JSON files and nothing else.

### Why Direct Upload rather than Git-connected Pages

Cloudflare Pages' free plan allows **500 Cloudflare-run builds per month**. Refreshing every
30 minutes is ~1,440 deploys/month, which would blow through that in about ten days.

This project therefore keeps the Pages project **unconnected to Git** and builds inside
GitHub Actions, pushing the finished `dist/` with `wrangler pages deploy`. Cloudflare's build
system is never invoked, so the 500-build quota is never touched. Actions' free tier for
public repositories is unlimited minutes.

---

## Setup

### 1. Push to GitHub

```bash
git init && git add -A && git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/space-dashboard.git
git push -u origin main
```

### 2. Create the Cloudflare Pages project (Direct Upload)

```bash
npx wrangler login
npx wrangler pages project create space-dashboard --production-branch main
```

When prompted, choose **Direct Upload**. Do *not* connect it to your Git repository — that
re-enables Cloudflare-run builds and the 500/month cap.

### 3. Add repository secrets

In **Settings → Secrets and variables → Actions**:

| Secret | Where to get it | Required |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → *Edit Cloudflare Workers* template (or a custom token with `Account / Cloudflare Pages / Edit`) | yes |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → right sidebar | yes |
| `LL2_API_KEY` | free from [thespacedevs.com](https://thespacedevs.com/llapi) | no — raises the LL2 limit from 15 to 30 req/hour, worth adding since GitHub runners share IPs |

### 4. Run it

Push to `main`, or use **Actions → Refresh data and deploy → Run workflow**. After that it
runs itself every 30 minutes.

---

## Local development

```bash
npm install
npm run dev          # http://localhost:5173
```

The repo ships with **seeded** data captured from the live APIs on 2026-09-20, so the scene
renders correctly on first clone with no network access. To pull fresh data:

```bash
npm run fetch:all              # all three sources
npm run fetch:telescopes       # JPL Horizons only
LL2_DEV=1 npm run fetch:starship   # LL2 dev mirror: no rate limit, stale data
npm run seed                   # regenerate the committed seed snapshot
```

Use `LL2_DEV=1` while iterating. The production LL2 endpoint gives you 15 requests an hour
and you will hit that faster than you expect.

---

## Data sources and their sharp edges

Each of these cost real debugging time. They're handled in the code; this is so you know why.

**Roman's ephemeris has a hard start.** Horizons has nothing for NAIF `-211` before
`2026-Aug-30 11:59:09 TDB` — 33 minutes after liftoff. Requesting anything earlier returns an
error string, not an empty table.

**Roman's ephemeris has a moving end.** It is a short-arc solution that JPL re-issues as
tracking data arrives. When this was written the arc ended `2026-Oct-12`. A naive fetcher that
asks for "launch → today + 120 days" fails outright the moment it passes the arc's end.
`scripts/lib/horizons.mjs` parses the coverage window out of the error text and retries inside
it, and the UI surfaces a warning when the plotted path had to be truncated.

**Horizons' default reference plane is Ecliptic of J2000.0**, not the equatorial ICRF frame.
Verified by checking that the Sun's geocentric Z stays near zero (~-9,000 km out of 1.5×10⁸).
Everything — spacecraft, Sun, the computed L2 point — is fetched in that one frame. Mixing
frames here produces a plot that looks plausible and is wrong.

**L2 is computed, not hardcoded.** It sits on the anti-Sun line at 1.00038% of the Sun's
current distance, derived from the live Sun vector, so it stays correct as Earth moves between
perihelion and aphelion. Hardcoding 1.5 million km introduces a ~25,000 km seasonal error.

**There is no public live telemetry for Starship.** Launch timing, status, pad and mission come
from Launch Library 2 and are live. The ground track drawn in the *Flight profile* view is a
**planned** trajectory computed from the launch site and orbital inclination. The UI says so
rather than implying a downlink exists.

---

## What's real and what's illustrative in the 3D view

Being clear about this is the difference between a data visualisation and a screensaver.

**Real:** spacecraft positions, trajectory paths, the Sun direction, the L2 point, the
Sun–Earth–L2 axis, Starship's orbital ground-track geometry.

**Illustrative:** Earth is drawn about 9× oversized; the spacecraft are symbolic markers many
orders of magnitude too large (at true scale Webb's 6.5 m mirror is far below one pixel at a
1.2-million-km viewing distance); Earth's landmasses are procedural noise, not cartography; the
starfield is a plausible magnitude distribution, not a real catalogue.

The UI states the exaggeration factor on the location cards.

---

## Further docs

- `CLAUDE.md` — working notes for Claude Code: invariants, platform gotchas, how to verify a change.
- `HANDOFF.md` — current state, verification status, and the task queue.

## Project layout

```
.github/workflows/deploy.yml   fetch → build → wrangler deploy, every 30 min
scripts/
  lib/horizons.mjs             JPL Horizons client; coverage-window clamping lives here
  fetch-telescopes.mjs         JWST (-170), Roman (-211), Sun (10) → telescopes.json
  fetch-starship.mjs           Launch Library 2 → starship.json
  fetch-news.mjs               Spaceflight News API → news.json
  make-seed.mjs                regenerates the committed seed snapshot
  screenshot.mjs               headless render + smoke assertions (npm run shots)
public/data/*.json             the static snapshots the page reads
src/
  main.js                      data loading, panel rendering, tab + countdown logic
  styles.css                   the whole interface
  scene/
    common.js                  starfield, Earth shader, labels, thick lines, bloom, env map
    L2Scene.js                 Sun–Earth–L2 scene: Webb + Roman on real trajectories
    StarshipScene.js           vehicle model + orbital ground track
```

### Implementation notes worth knowing before you edit the scenes

- **Thick lines need `Line2`.** `THREE.Line` ignores `linewidth` on nearly every platform
  (ANGLE/D3D clamps it to 1px). `LineMaterial.resolution` must be updated on every resize or
  the widths go wrong.
- **Metals need an environment map.** A `metalness: 0.9` material lit only by directional
  lights renders essentially black — there is nothing for it to reflect. `createSpaceEnvironment`
  bakes a tiny procedural sky into a PMREM cubemap. Removing it turns the Starship stack into a
  silhouette.
- **`modelMatrix` is not available in Three's fragment shader prefix**, only the vertex one.
  World position has to be passed as a varying.
- **The camera view is offset 15% to the right on desktop** so the scene clears the reading
  panel, and `frameObjects` compensates the camera distance by `0.5 / (0.5 - bias)`. Without
  that compensation the subject simply slides out of frame.

---

## Adjusting the refresh rate

The cadence is one line in `.github/workflows/deploy.yml`:

```yaml
- cron: '*/30 * * * *'    # every 30 min
- cron: '0 * * * *'       # hourly
```

GitHub's scheduler is best-effort and can lag several minutes under load. That's irrelevant
for orbital mechanics and fine for a launch countdown, which is computed client-side from the
target timestamp and ticks every second regardless of when data last refreshed.

## Licence and attribution

Not affiliated with NASA, ESA, CSA, STScI or SpaceX. Data from JPL Horizons (public domain),
The Space Devs' Launch Library 2 and Spaceflight News API (free, community-funded — they take
[Patreon support](https://www.patreon.com/TheSpaceDevs)).
