/**
 * Offline regression test for the Horizons coverage-window clamp.
 *
 * This path is the most intricate code in the repo and it cannot be exercised
 * from a sandbox with no route to ssd.jpl.nasa.gov, which is how it shipped
 * broken: the clamp compared a full timestamp against a window Horizons had
 * judged at day resolution, so the retry re-sent an identical request until the
 * attempt budget ran out and every telescope fetch hard-failed.
 *
 * Stubs globalThis.fetch with a server that enforces a coverage window the way
 * Horizons does, then asserts the state machine's observable behaviour.
 * Run: npm run test:horizons
 */
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
                 JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function parseHz(s) {
  const m = s.match(/([0-9]{4})-([A-Z]{3})-([0-9]{2})\s+([0-9]{2}):([0-9]{2}):([0-9.]+)/i);
  return new Date(Date.UTC(+m[1], MONTHS[m[2].toUpperCase()], +m[3], +m[4], +m[5], Math.floor(+m[6])));
}

/** Stand in for Horizons over one coverage window. Returns the request count. */
function stubHorizons({ notBefore, notAfter }) {
  const state = { requests: 0, windows: [] };
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const s = u.searchParams.get('START_TIME');
    const e = u.searchParams.get('STOP_TIME');
    state.requests += 1;
    state.windows.push(`${s}..${e}`);
    const body = (b) => ({ ok: true, status: 200, text: async () => b });
    // Horizons judges the window at the resolution it was given: a date-only
    // START_TIME means midnight, which is what makes the launch-day case bite.
    if (new Date(`${s}T00:00:00Z`) < parseHz(notBefore)) {
      return body(`No ephemeris for target "x" prior to A.D. ${notBefore} TDB`);
    }
    if (new Date(`${e}T00:00:00Z`) > parseHz(notAfter)) {
      return body(`No ephemeris for target "x" after A.D. ${notAfter} TDB`);
    }
    return body('$$SOE\n2461284.5, A.D. 2026-Sep-01 00:00:00.0000, 1.0E+05, 2.0E+05, 3.0E+05,\n$$EOE');
  };
  return state;
}

const { vectors } = await import('./lib/horizons.mjs');

// Roman's real request as fetch-telescopes.mjs issues it: opens just after
// liftoff and runs 120 days past today, so both ends fall outside the arc.
const ROMAN_REQUEST = {
  start: new Date('2026-08-30T12:30:00Z'),
  stop: new Date('2027-01-18T00:00:00Z'),
  step: '1d',
};

const LAUNCH = '2026-AUG-30 11:59:09.1827';

const cases = [
  {
    name: 'Roman in cruise — short arc, both ends clamped',
    window: { notBefore: LAUNCH, notAfter: '2026-OCT-12 12:58:00.0000' },
    expect: {
      clamped: true,
      clampedStart: true,
      clampedEnd: true,
      // Carried out of the error responses; the successful reply never says it.
      notAfter: '2026-Oct-12 12:58:00',
      notBefore: '2026-Aug-30 11:59:09',
    },
  },
  {
    name: 'Roman after L2 arrival — long arc, only the launch day clamps',
    window: { notBefore: LAUNCH, notAfter: '2027-DEC-31 00:00:00.0000' },
    // arcClamped drives a UI warning about the path stopping short of L2.
    // A start clamp is routine for any post-launch craft and must not raise it,
    // or the warning can never clear itself once JPL issues a full arc.
    expect: { clamped: false, clampedStart: true, clampedEnd: false, notAfter: null },
  },
  {
    name: 'JWST — request sits inside the window, nothing to clamp',
    window: { notBefore: '2021-DEC-25 13:20:00.0000', notAfter: '2031-SEP-06 23:59:00.0000' },
    expect: { clamped: false, clampedStart: false, clampedEnd: false, notAfter: null },
  },
];

let failures = 0;

for (const c of cases) {
  const state = stubHorizons(c.window);
  let got;
  try {
    got = await vectors('-211', ROMAN_REQUEST);
  } catch (err) {
    console.error(`✗ ${c.name}\n    threw: ${err.message}`);
    failures += 1;
    continue;
  }

  const actual = {
    clamped: got.clamped,
    clampedStart: got.clampedStart,
    clampedEnd: got.clampedEnd,
    notAfter: got.coverage.notAfter,
    ...('notBefore' in c.expect ? { notBefore: got.coverage.notBefore } : {}),
  };

  const bad = Object.entries(c.expect).filter(([k, v]) => actual[k] !== v);

  // Every retry must narrow the window. Identical consecutive requests are the
  // exact signature of the bug this file exists to catch.
  const repeated = state.windows.length !== new Set(state.windows).size;

  if (bad.length || repeated) {
    failures += 1;
    console.error(`✗ ${c.name}`);
    for (const [k, v] of bad) console.error(`    ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
    if (repeated) console.error(`    re-sent an identical window: ${state.windows.join(' -> ')}`);
  } else {
    console.log(`✓ ${c.name}  (${state.requests} request${state.requests === 1 ? '' : 's'}: ${state.windows.join(' -> ')})`);
  }
}

// --- transient HTTP handling -----------------------------------------------
// The first CI run died on a 503 from the Sun query 0.4s in, with no retry.
const OK_BODY = '$$SOE\n2461284.5, A.D. 2026-Sep-01 00:00:00.0000, 1.0E+05, 2.0E+05, 3.0E+05,\n$$EOE';

/** Replies with `statuses` in order, then 200s forever. Returns the call count. */
function stubStatuses(statuses) {
  const state = { requests: 0 };
  globalThis.fetch = async () => {
    const s = statuses[state.requests];
    state.requests += 1;
    if (s === undefined || s === 200) {
      return { ok: true, status: 200, text: async () => OK_BODY };
    }
    if (s === 'throw') throw new Error('socket hang up');
    return { ok: false, status: s, text: async () => '' };
  };
  return state;
}

const WIDE = { start: new Date('2026-09-01T00:00:00Z'), stop: new Date('2026-09-05T00:00:00Z') };

const transient = [
  { name: '503 then success — retried, not surfaced', statuses: [503], throws: false, requests: 2 },
  { name: '429 then success — retried, not surfaced', statuses: [429], throws: false, requests: 2 },
  { name: 'network throw then success — retried', statuses: ['throw'], throws: false, requests: 2 },
  { name: '503 every time — gives up after 3', statuses: [503, 503, 503], throws: true, requests: 3 },
  // A malformed request is not transient; retrying only hammers JPL.
  { name: '400 — fails immediately, no retry', statuses: [400], throws: true, requests: 1 },
];

for (const c of transient) {
  const state = stubStatuses(c.statuses);
  let threw = false;
  try {
    await vectors('-170', WIDE);
  } catch {
    threw = true;
  }
  const bad = [];
  if (threw !== c.throws) bad.push(`expected ${c.throws ? 'a throw' : 'success'}, got the opposite`);
  if (state.requests !== c.requests) bad.push(`expected ${c.requests} request(s), made ${state.requests}`);
  if (bad.length) {
    failures += 1;
    console.error(`✗ ${c.name}`);
    for (const b of bad) console.error(`    ${b}`);
  } else {
    console.log(`✓ ${c.name}  (${state.requests} request${state.requests === 1 ? '' : 's'})`);
  }
}

const total = cases.length + transient.length;
if (failures) {
  console.error(`\nFAIL — ${failures} of ${total} cases`);
  process.exit(1);
}
console.log(`\nPASS — ${total} cases`);
