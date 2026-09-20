/**
 * Fetches JWST + Roman trajectories and the Sun vector from JPL Horizons,
 * and writes public/data/telescopes.json.
 *
 * Runs in CI (GitHub Actions), never in the browser: Horizons has no CORS headers
 * and we do not want the client making 4 upstream calls per page view.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vectors, currentPosition, magnitude, BODIES } from './lib/horizons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/telescopes.json');

const DAY = 86400000;

/**
 * Sun-Earth L2 sits on the anti-Sun line at ~1.0004% of the Sun's distance.
 *   r/R = (m_earth+moon / 3 m_sun)^(1/3) = 0.0100038
 * Computing it from the live Sun range (rather than hardcoding 1.5e6 km) keeps
 * L2 correct as Earth moves between perihelion and aphelion.
 */
const L2_RATIO = 0.0100038;

function l2From(sun) {
  const r = magnitude(sun);
  const d = r * L2_RATIO;
  // L2 lies opposite the Sun as seen from Earth
  return { x: (-sun.x / r) * d, y: (-sun.y / r) * d, z: (-sun.z / r) * d, distance: d };
}

async function main() {
  const now = new Date();

  // --- Trajectory arcs -------------------------------------------------------
  // JWST: 10 months back + 3 forward shows a full ~6-month halo loop and where
  // it is heading. Roman: from launch to wherever its short arc currently ends.
  const [jwstArc, romanArc, sunArc] = await Promise.all([
    vectors(BODIES.jwst.id, {
      start: new Date(now.getTime() - 300 * DAY),
      stop: new Date(now.getTime() + 90 * DAY),
      step: '5d',
    }),
    vectors(BODIES.roman.id, {
      start: new Date('2026-08-30T12:30:00Z'), // just after liftoff; clamp handles the rest
      stop: new Date(now.getTime() + 120 * DAY),
      step: '1d',
    }),
    vectors(BODIES.sun.id, {
      start: new Date(now.getTime() - 300 * DAY),
      stop: new Date(now.getTime() + 90 * DAY),
      step: '5d',
    }),
  ]);

  // --- Current positions -----------------------------------------------------
  const [jwstNow, romanNow, sunNow] = await Promise.all([
    currentPosition(BODIES.jwst.id),
    currentPosition(BODIES.roman.id),
    currentPosition(BODIES.sun.id),
  ]);

  const l2 = l2From(sunNow);
  const romanRange = magnitude(romanNow);
  const jwstRange = magnitude(jwstNow);

  // Distance from each observatory to the L2 point right now.
  const toL2 = (p) => Math.hypot(p.x - l2.x, p.y - l2.y, p.z - l2.z);

  const payload = {
    generatedAt: now.toISOString(),
    frame: 'Ecliptic of J2000.0, geocentric (Horizons CENTER=500@399)',
    units: 'km',
    sun: { ...sunNow, distance: magnitude(sunNow) },
    l2,
    bodies: {
      jwst: {
        label: BODIES.jwst.label,
        naifId: BODIES.jwst.id,
        position: jwstNow,
        rangeFromEarth: jwstRange,
        rangeFromL2: toL2(jwstNow),
        phase: 'operational',
        arc: jwstArc.points,
        coverage: jwstArc.coverage,
      },
      roman: {
        label: BODIES.roman.label,
        naifId: BODIES.roman.id,
        position: romanNow,
        rangeFromEarth: romanRange,
        rangeFromL2: toL2(romanNow),
        // Roman is cruising to L2 until ~late Nov 2026. Flip to 'operational'
        // automatically once it is inside the halo neighbourhood.
        phase: toL2(romanNow) < 4e5 ? 'operational' : 'cruise',
        cruiseProgress: Math.min(1, romanRange / l2.distance),
        arc: romanArc.points,
        coverage: romanArc.coverage,
        // Surfaced so the UI can warn instead of silently drawing a stale arc.
        arcClamped: romanArc.clamped,
      },
    },
    sunArc: sunArc.points,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));

  console.log(
    `telescopes.json written\n` +
    `  JWST  ${(jwstRange / 1e6).toFixed(4)}M km from Earth, ${(toL2(jwstNow) / 1e3).toFixed(0)}k km from L2, ${jwstArc.points.length} arc pts\n` +
    `  Roman ${(romanRange / 1e6).toFixed(4)}M km from Earth, ${(toL2(romanNow) / 1e3).toFixed(0)}k km from L2, ${romanArc.points.length} arc pts` +
    (romanArc.clamped ? ' (arc clamped to available coverage)' : '') + '\n' +
    `  L2    ${(l2.distance / 1e6).toFixed(4)}M km`,
  );
}

main().catch((err) => {
  console.error('fetch-telescopes failed:', err.message);
  process.exit(1);
});
