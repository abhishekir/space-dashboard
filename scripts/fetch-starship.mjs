/**
 * Fetches Starship launch data from The Space Devs' Launch Library 2.
 * Writes public/data/starship.json.
 *
 * Rate limits (why this MUST run in CI, not the browser):
 *   - 15 requests/hour unauthenticated, per IP
 *   - 30/hour with a free API key (set LL2_API_KEY)
 *   - CORS is disabled, so a browser fetch fails outright
 *
 * Set LL2_DEV=1 to use lldev.thespacedevs.com: no rate limit, stale data.
 * Use that while iterating so you do not burn the real quota.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/starship.json');

const BASE = process.env.LL2_DEV
  ? 'https://lldev.thespacedevs.com/2.3.0'
  : 'https://ll.thespacedevs.com/2.3.0';

const headers = { Accept: 'application/json' };
if (process.env.LL2_API_KEY) headers.Authorization = `Token ${process.env.LL2_API_KEY}`;

async function ll2(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 429) {
    throw new Error('LL2 rate limit hit (15/hr unauthenticated). Set LL2_API_KEY or LL2_DEV=1.');
  }
  if (!res.ok) throw new Error(`LL2 HTTP ${res.status} on ${path}`);
  return res.json();
}

/** Trim LL2's very large launch objects down to what the UI actually renders. */
function shape(l) {
  return {
    id: l.id,
    name: l.name,
    net: l.net,
    netPrecision: l.net_precision?.name ?? null,
    windowStart: l.window_start,
    windowEnd: l.window_end,
    status: {
      name: l.status?.name ?? null,
      abbrev: l.status?.abbrev ?? null,
      description: l.status?.description ?? null,
    },
    rocket: l.rocket?.configuration?.full_name ?? l.rocket?.configuration?.name ?? null,
    pad: {
      name: l.pad?.name ?? null,
      location: l.pad?.location?.name ?? null,
      latitude: l.pad?.latitude != null ? Number(l.pad.latitude) : null,
      longitude: l.pad?.longitude != null ? Number(l.pad.longitude) : null,
    },
    mission: {
      name: l.mission?.name ?? null,
      description: l.mission?.description ?? null,
      type: l.mission?.type ?? null,
      orbit: l.mission?.orbit?.name ?? null,
    },
    image: l.image?.image_url ?? null,
    webcast: (l.vid_urls ?? []).map((v) => ({ title: v.title, url: v.url }))[0] ?? null,
    failreason: l.failreason || null,
  };
}

async function main() {
  // `search` matches mission/rocket/provider text. Starship flights are all
  // named "Starship Flight N" (previously "Starship Integrated Flight Test N").
  const [upcoming, previous] = await Promise.all([
    ll2('/launches/upcoming/?search=Starship&limit=5&mode=detailed'),
    ll2('/launches/previous/?search=Starship&limit=12&mode=detailed&ordering=-net'),
  ]);

  const up = (upcoming.results ?? []).map(shape);
  const prev = (previous.results ?? []).map(shape);

  // Flight-record tally from the flights we can see. Labeled as such in the UI:
  // it counts what LL2 returns, not SpaceX's own official record.
  const outcomes = prev.reduce(
    (acc, l) => {
      const s = (l.status.abbrev || '').toLowerCase();
      if (s === 'success') acc.success += 1;
      else if (s.includes('fail')) acc.failure += 1;
      else acc.other += 1;
      return acc;
    },
    { success: 0, failure: 0, other: 0 },
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    source: BASE,
    stale: Boolean(process.env.LL2_DEV),
    next: up[0] ?? null,
    upcoming: up,
    previous: prev,
    outcomes,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(
    `starship.json written — next: ${payload.next?.name ?? 'none'} @ ${payload.next?.net ?? '—'}; ` +
    `${prev.length} previous flights`,
  );
}

main().catch((err) => {
  console.error('fetch-starship failed:', err.message);
  process.exit(1);
});
