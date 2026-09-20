/**
 * Prints what the fetchers actually produced, as GitHub step-summary markdown.
 *
 * HANDOFF.md calls a deploy that goes out with stale data and no visible error
 * this architecture's main failure mode: `continue-on-error` keeps a failed
 * fetcher from sinking the deploy, so a snapshot can quietly stop advancing
 * while every run stays green. Step outcomes alone do not catch that — a
 * fetcher can exit 0 having written a thinner payload than yesterday. This
 * reports the contents, so the Actions summary shows what shipped.
 *
 * Reads only; never fails the job.
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = [];
const say = (s = '') => out.push(s);

async function load(name) {
  try {
    return JSON.parse(await readFile(resolve(ROOT, 'public/data', name), 'utf8'));
  } catch (err) {
    say(`- \`${name}\` — **unreadable**: ${err.message}`);
    return null;
  }
}

const ageOf = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  return Number.isFinite(h) ? `${h.toFixed(1)}h old` : 'unknown age';
};
const mag = (p) => Math.hypot(p.x, p.y, p.z);

say('### Data snapshot');
say();

const tel = await load('telescopes.json');
if (tel) {
  say(`**telescopes.json** — ${ageOf(tel.generatedAt)}${tel.seeded ? ' · ⚠️ SEED DATA, fetcher did not run' : ''}`);
  say();
  say('| body | range from Earth | range from L2 | arc pts | span | end-clamped | coverage ends |');
  say('|---|---|---|---|---|---|---|');
  for (const [key, b] of Object.entries(tel.bodies ?? {})) {
    const arc = b.arc ?? [];
    const span = arc.length
      ? `${arc[0].t.slice(0, 10)} → ${arc.at(-1).t.slice(0, 10)}`
      : '—';
    say(`| ${key} | ${(b.rangeFromEarth / 1e6).toFixed(4)}M km | `
      + `${(b.rangeFromL2 / 1e3).toFixed(0)}k km | ${arc.length} | ${span} | `
      + `${b.arcClamped ? '**yes**' : 'no'} | ${b.coverage?.notAfter ?? '—'} |`);
  }
  say();
  // Geometry sanity: JWST's halo should sweep a wide range of L2 offsets rather
  // than sitting at one radius, and the arc should not be a near-straight line.
  const j = tel.bodies?.jwst;
  if (j?.arc?.length && tel.l2) {
    const offs = j.arc.map((p) => Math.hypot(p.x - tel.l2.x, p.y - tel.l2.y, p.z - tel.l2.z));
    const gap = Math.hypot(
      j.arc[0].x - j.arc.at(-1).x, j.arc[0].y - j.arc.at(-1).y, j.arc[0].z - j.arc.at(-1).z);
    say(`JWST halo: L2 offset ranges ${(Math.min(...offs) / 1e3).toFixed(0)}k–`
      + `${(Math.max(...offs) / 1e3).toFixed(0)}k km over ${j.arc.length} points; `
      + `first-to-last gap ${(gap / 1e3).toFixed(0)}k km.`);
    say();
  }
  say(`L2 at ${(tel.l2?.distance / 1e6).toFixed(4)}M km · Sun at `
    + `${(mag(tel.sun ?? { x: 0, y: 0, z: 0 }) / 1e6).toFixed(3)}M km · `
    + `sunArc ${tel.sunArc?.length ?? 0} pts`);
  say();
}

const ship = await load('starship.json');
if (ship) {
  say(`**starship.json** — ${ageOf(ship.generatedAt)} · source \`${ship.source}\``
    + `${ship.stale ? ' · ⚠️ DEV MIRROR, data is stale' : ''}`);
  say();
  say(`- next: ${ship.next ? `**${ship.next.name}** @ ${ship.next.net} (${ship.next.status?.name ?? '?'})` : '**none**'}`);
  say(`- upcoming: ${ship.upcoming?.length ?? 0} · previous: ${ship.previous?.length ?? 0}`);
  const o = ship.outcomes ?? {};
  say(`- outcomes across returned flights: ${o.success ?? 0} success / ${o.failure ?? 0} failure / ${o.other ?? 0} other`);
  say();
}

const news = await load('news.json');
if (news) {
  const feeds = news.feeds ?? {};
  const counts = Object.entries(feeds).map(([k, v]) => `${k}:${v.length}`).join(' · ');
  const empty = Object.entries(feeds).filter(([, v]) => !v.length).map(([k]) => k);
  say(`**news.json** — ${ageOf(news.generatedAt)}`);
  say();
  say(`- articles per feed: ${counts || 'none'}`);
  if (empty.length) say(`- ⚠️ empty feeds: ${empty.join(', ')}`);
  const newest = Object.values(feeds).flat()
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))[0];
  if (newest) say(`- newest: "${newest.title}" (${newest.newsSite}, ${newest.publishedAt?.slice(0, 10)})`);
  say();
}

console.log(out.join('\n'));
