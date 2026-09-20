# CLAUDE.md

Project memory for Claude Code. Read `HANDOFF.md` once at the start of a fresh session
for current state and the task queue. `README.md` is the human-facing doc.

**Deep Field** — a live 3D dashboard for JWST, the Nancy Grace Roman Space Telescope, and
SpaceX Starship. Vanilla JS + Vite + Three.js. No framework, no runtime dependencies beyond
`three`.

---

## Commands

```bash
npm run dev            # vite dev server, localhost:5173
npm run build          # -> dist/
npm run shots          # headless render of dist: screenshots + smoke assertions
npm run shots -- --dev # same, against the running dev server
npm run smoke <url>    # smoke-test a deployed URL
npm run fetch:all      # refresh all three data snapshots
npm run seed           # regenerate the committed seed snapshot
npm run test:horizons  # offline test of the Horizons coverage-window clamp
```

`npm run shots` needs `npx playwright install chromium` once.

---

## Hard invariants

Do not undo these without a deliberate reason. Each exists because the alternative is broken.

1. **The browser never calls an upstream API.** CI writes `public/data/*.json`; the page reads
   those. Horizons has no CORS headers, LL2 has CORS disabled *and* a 15 req/hour per-IP cap.
   Moving a fetch into the client breaks the site for everyone at once.

2. **Cloudflare Pages stays a Direct Upload project, not Git-connected.** The free plan allows
   500 *Cloudflare-run* builds/month; the 30-minute refresh is ~1,440 deploys/month. Building in
   Actions and uploading `dist/` sidesteps the quota entirely. Connecting the repo to Pages in
   the dashboard silently re-enables the cap and the site stops updating partway through a month.

3. **One reference frame everywhere: Ecliptic of J2000.0, geocentric (`CENTER=500@399`).**
   Spacecraft, Sun and the derived L2 point all come from Horizons in that frame. Mixing in an
   equatorial (`REF_PLANE=FRAME`) vector produces a plot that looks plausible and is wrong by
   the 23.4° obliquity.

4. **L2 is computed from the live Sun vector**, not hardcoded. It sits on the anti-Sun line at
   `1.00038%` of the Sun's current distance. Hardcoding 1.5e6 km introduces a ~25,000 km
   seasonal error.

5. **Never fabricate a number.** Every figure on the page traces to a fetched snapshot or a
   cited published spec. If data is missing, render the empty state — there is one for every
   panel. This applies to seed data too: `scripts/make-seed.mjs` contains real captured
   ephemeris rows, not plausible-looking ones.

6. **The 3D view states its own exaggerations.** Earth is drawn ~9× oversized and spacecraft are
   symbolic markers; the location cards say so. If you change `EARTH_DRAW_RADIUS`, the stated
   factor updates automatically via `EARTH_EXAGGERATION` — keep that link intact.

7. **Starship's ground track is labelled a *planned* profile.** No public live telemetry feed
   exists. Launch timing and status are live from LL2; the trajectory is computed. Do not let
   the copy imply otherwise.

---

## Gotchas that have already cost time

**JPL Horizons**
- Spacecraft ephemerides have a start *and* a moving end. Roman (`-211`) has nothing before
  `2026-Aug-30 11:59:09 TDB`, and its arc is a short-arc solution JPL re-issues as tracking
  arrives. Requesting outside the window returns an error string with no `$$SOE`/`$$EOE`
  markers. `scripts/lib/horizons.mjs` parses the window out of that error and retries inside it.
  Keep that behaviour — without it the telescope fetcher hard-fails on a schedule.
- Data is fenced between `$$SOE` and `$$EOE`. Absence of those markers *is* the error signal.
- **`START_TIME`/`STOP_TIME` go out as dates, so Horizons judges the window at midnight.** A
  `Date` of `2026-08-30T12:30Z` is inside Roman's coverage; the `2026-08-30` that `ymd()`
  actually sends is not. Every clamp comparison must be made against the truncated value, not
  the in-memory `Date` — getting this wrong makes the retry re-send an identical request and
  the fetcher fails every run. `npm run test:horizons` guards it.
- Coverage bounds appear **only in error responses**. The successful reply that ends the retry
  loop says nothing about the window, so carry the bounds across attempts or they come back
  null.

**Three.js**
- `THREE.Line` ignores `linewidth` on nearly every platform (ANGLE/D3D clamps to 1px).
  Trajectories use `Line2`/`LineMaterial`. `LineMaterial.resolution` **must** be updated on
  every resize or widths go wrong.
- A `metalness: ~0.9` material lit only by directional lights renders **black** — there is
  nothing for it to reflect. `createSpaceEnvironment()` bakes a procedural sky into a PMREM
  cubemap. Deleting it turns the Starship stack into a silhouette.
- `modelMatrix` is injected into Three's *vertex* shader prefix only, **not** the fragment
  prefix. Pass world position across as a varying. (`cameraPosition` and `viewMatrix` *are*
  available in the fragment prefix.)
- The camera view is offset 15% right on desktop so the scene clears the reading panel.
  `frameObjects()` compensates distance by `0.5 / (0.5 - bias)`. Skip the compensation and the
  subject slides out of frame — this is why the halo orbit kept getting clipped.
- `setViewOffset` is in **pixels**, so it must be rebuilt on every resize and cleared below the
  900px breakpoint.

**CSS**
- `#tabs` carries `flex: 1` (flex-basis `0%`) in the base rule, which beats `width: 100%` in the
  mobile media query. That kept the tab row on line one, squeezed to ~70px, with the buttons
  overflowing off-screen and unclickable on phones. The mobile rule now resets
  `flex: 0 0 100%`. Watch for the same trap if you add another wrapping flex child.

**Headless rendering**
- Under SwiftShader the render loop can starve the main thread, so DOM assertions need long
  timeouts (tens of seconds), not fixed sleeps. Real GPUs are instant.
- Chromium hangs on `goto` if background network calls to Google endpoints are blocked. The
  launch flags in `scripts/screenshot.mjs` disable them; keep them.

---

## Verifying a change

Run `npm run build && npm run shots` before calling any visual or layout change done. It fails
non-zero on page errors, console errors, a tab that renders no stat tiles, a missing WebGL
context, or horizontal overflow at 414px. It has caught every real bug in this project so far,
including two that were invisible on screen.

For data-layer changes, run the actual fetcher (`npm run fetch:telescopes`, etc.) and inspect
the JSON — do not assume the parse worked because the build passed.

---

## Style

Vanilla JS, ES modules, no framework. Comments explain *why*, especially where a line encodes a
non-obvious API or platform constraint — most of the comments in `scene/` and `scripts/lib/`
are load-bearing knowledge, not narration. Keep them when refactoring.
