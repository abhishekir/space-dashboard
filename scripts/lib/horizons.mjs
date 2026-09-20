/**
 * Minimal JPL Horizons API client.
 *
 * Everything here returns vectors in **Ecliptic of J2000.0, Earth-centered (500@399)**.
 * That is Horizons' default REF_PLANE for VECTORS output and it is verified by the
 * Sun's geocentric Z staying ~0 (see scripts/verify-frame.mjs).
 *
 * Hard-won details this client handles, each confirmed against the live API:
 *
 *  1. Spacecraft ephemerides have a START. Roman (-211) has no ephemeris before
 *     2026-Aug-30 11:59:09 TDB (33 min after liftoff). Asking earlier returns an
 *     error string, not data.
 *  2. Spacecraft ephemerides have an END. Roman's arc ran only to 2026-Oct-12 when
 *     this was written, because short-arc solutions are re-issued as tracking comes
 *     in. Asking past the end returns an error. THIS WILL BITE YOU on a schedule.
 *  3. The response is plain text with data fenced between $$SOE and $$EOE.
 *     An error response has neither marker.
 */

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/** NAIF/SPK ids. Confirmed via the Horizons lookup API. */
export const BODIES = {
  jwst: { id: '-170', label: 'James Webb Space Telescope' },
  roman: { id: '-211', label: 'Nancy Grace Roman Space Telescope' },
  sun: { id: '10', label: 'Sun' },
  moon: { id: '301', label: 'Moon' },
};

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function buildUrl(params) {
  const qs = new URLSearchParams({
    format: 'text',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: '500@399', // geocentric
    OBJ_DATA: 'NO',
    CSV_FORMAT: 'YES',
    VEC_TABLE: '1', // position only; we don't need velocity for rendering
    OUT_UNITS: 'KM-S',
    ...params,
  });
  return `${API}?${qs}`;
}

/**
 * Horizons reports its coverage window inside the error text, e.g.
 *   "No ephemeris for target ... prior to A.D. 2026-AUG-30 11:59:09.1827 TDB"
 *   "No ephemeris for target ... after A.D. 2026-OCT-12 12:58:00.0000 TDB"
 * Parse those so callers can retry inside the real window instead of failing.
 */
function parseCoverageError(text) {
  const before = text.match(/prior to A\.D\.\s+([0-9]{4}-[A-Z]{3}-[0-9]{2}\s+[0-9:.]+)/i);
  const after = text.match(/after A\.D\.\s+([0-9]{4}-[A-Z]{3}-[0-9]{2}\s+[0-9:.]+)/i);
  return {
    notBefore: before ? tidy(before[1]) : null,
    notAfter: after ? tidy(after[1]) : null,
  };
}

/**
 * Horizons shouts its months and carries 4 fractional-second digits
 * ("2026-OCT-12 12:58:00.0000"). These strings are rendered straight into prose
 * on the Roman panel, so drop the fraction and title-case the month to match the
 * form scripts/make-seed.mjs stores. Nothing below minute resolution is shown.
 */
function tidy(s) {
  return s
    .replace(/\.[0-9]+$/, '')
    .replace(/-([A-Z]{3})-/, (_, m) => `-${m[0]}${m.slice(1).toLowerCase()}-`);
}

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** "2026-AUG-30 11:59:09.1827" -> Date (treated as UTC; TDB/UTC differ by ~70s, irrelevant here) */
function parseHorizonsDate(s) {
  const m = s.match(/([0-9]{4})-([A-Z]{3})-([0-9]{2})\s+([0-9]{2}):([0-9]{2}):([0-9.]+)/i);
  if (!m) return null;
  return new Date(Date.UTC(
    +m[1], MONTHS[m[2].toUpperCase()], +m[3], +m[4], +m[5], Math.floor(+m[6]),
  ));
}

async function rawQuery(params) {
  const url = buildUrl(params);
  const res = await fetch(url, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`Horizons HTTP ${res.status} for ${params.COMMAND}`);
  return res.text();
}

/**
 * Fetch a position-vector time series.
 *
 * @param {string} command  NAIF id, e.g. '-170'
 * @param {object} opts
 * @param {Date|string} opts.start
 * @param {Date|string} opts.stop
 * @param {string} opts.step   Horizons step, e.g. '1d', '6h'
 * @param {boolean} opts.clamp Retry inside the reported coverage window on a range error.
 * @returns {Promise<{points: Array<{t: string, x: number, y: number, z: number}>,
 *                    coverage: {notBefore: string|null, notAfter: string|null},
 *                    clamped: boolean, clampedStart: boolean, clampedEnd: boolean}>}
 */
export async function vectors(command, { start, stop, step = '1d', clamp = true } = {}) {
  let startD = new Date(start);
  let stopD = new Date(stop);
  let clampedStart = false;
  let clampedEnd = false;
  // Coverage is only ever stated in an ERROR response. The successful reply that
  // ends this loop says nothing about the window, so carry it across attempts —
  // reading it off the success text yields nulls.
  const coverage = { notBefore: null, notAfter: null };
  let lastError = '';

  for (let attempt = 0; attempt < 4; attempt++) {
    // What actually goes on the wire. ymd() truncates to midnight, and every
    // comparison below has to be made against these, not against startD/stopD.
    const sentStart = ymd(startD);
    const sentStop = ymd(stopD);

    const text = await rawQuery({
      COMMAND: command,
      START_TIME: sentStart,
      STOP_TIME: sentStop,
      STEP_SIZE: step,
    });

    const soe = text.indexOf('$$SOE');
    const eoe = text.indexOf('$$EOE');

    if (soe !== -1 && eoe !== -1) {
      const body = text.slice(soe + 5, eoe).trim();
      const points = body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          // jd, "A.D. YYYY-Mon-DD HH:MM:SS.ssss", X, Y, Z,
          const parts = line.split(',').map((s) => s.trim());
          const cal = parts[1].replace(/^A\.D\.\s*/, '');
          const t = parseHorizonsDate(cal);
          return {
            t: t ? t.toISOString() : cal,
            x: Number(parts[2]),
            y: Number(parts[3]),
            z: Number(parts[4]),
          };
        })
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));

      if (!points.length) throw new Error(`Horizons returned an empty table for ${command}`);
      // `clamped` means the END was pulled in — that is what the UI warns about.
      // A start clamp is routine for any post-launch spacecraft and is not a
      // short-arc signal, so it must not raise the warning on its own.
      return { points, coverage, clamped: clampedEnd, clampedStart, clampedEnd };
    }

    // No data markers => range/coverage error. Try to recover.
    const cov = parseCoverageError(text);
    if (!clamp || (!cov.notBefore && !cov.notAfter)) {
      const snippet = text.replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`Horizons returned no ephemeris for ${command}: ${snippet}`);
    }
    lastError = text.replace(/\s+/g, ' ').slice(0, 300);
    if (cov.notBefore) coverage.notBefore = cov.notBefore;
    if (cov.notAfter) coverage.notAfter = cov.notAfter;

    const prevStart = startD.getTime();
    const prevStop = stopD.getTime();

    if (cov.notBefore) {
      const lim = parseHorizonsDate(cov.notBefore);
      // Compare against the truncated value we sent: startD may sit inside the
      // window (12:30) while the date we sent (00:00) does not, which is exactly
      // the case for Roman, whose ephemeris begins 11:59:09 on its launch day.
      // +1 day so the first sample is safely inside the window.
      if (lim && lim >= new Date(`${sentStart}T00:00:00Z`)) {
        startD = new Date(lim.getTime() + 86400000);
        clampedStart = true;
      }
    }
    if (cov.notAfter) {
      const lim = parseHorizonsDate(cov.notAfter);
      if (lim && lim <= new Date(`${sentStop}T00:00:00Z`)) {
        stopD = new Date(lim.getTime() - 86400000);
        clampedEnd = true;
      }
    }

    if (startD.getTime() === prevStart && stopD.getTime() === prevStop) {
      // Nothing moved, so the next attempt would re-send an identical request.
      // Fail loudly with what Horizons actually said rather than spinning.
      throw new Error(
        `Horizons rejected ${command} for ${sentStart}..${sentStop} and the window `
        + `did not move: ${lastError}`,
      );
    }
    if (startD >= stopD) {
      throw new Error(`Horizons coverage for ${command} is empty after clamping`);
    }
  }
  throw new Error(`Horizons: could not find a valid window for ${command}: ${lastError}`);
}

/** Single current position. Uses a 2-day window and takes the first row. */
export async function currentPosition(command) {
  const now = new Date();
  const { points, coverage, clamped } = await vectors(command, {
    start: new Date(now.getTime() - 86400000),
    stop: new Date(now.getTime() + 86400000),
    step: '1d',
  });
  // pick the sample nearest to now
  let best = points[0];
  let bestDt = Infinity;
  for (const p of points) {
    const dt = Math.abs(new Date(p.t) - now);
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  return { ...best, coverage, clamped };
}

export function magnitude(p) {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}
