import './styles.css';
import { L2Scene, EARTH_EXAGGERATION } from './scene/L2Scene.js';
import { StarshipScene } from './scene/StarshipScene.js';

/* ================================================================== *
 * Data
 *
 * Everything is a static JSON snapshot written by CI. The page makes no
 * upstream API calls: Horizons has no CORS headers, Launch Library 2 has CORS
 * disabled and a 15 req/hour cap, and neither should be in the hot path of a
 * page load anyway.
 * ================================================================== */

const DATA_VERSION = Date.now(); // cache-bust so a redeploy always shows fresh data

async function loadJSON(path, fallback) {
  try {
    const res = await fetch(`${path}?v=${DATA_VERSION}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`Could not load ${path}:`, err.message);
    return fallback;
  }
}

/* ================================================================== *
 * Formatting
 * ================================================================== */

const nf = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Kilometres in the unit that reads best at that magnitude. */
function distance(km) {
  if (km >= 1e6) return { value: nf(km / 1e6, 4), unit: 'million km' };
  if (km >= 1e4) return { value: nf(km / 1e3, 1), unit: 'thousand km' };
  return { value: nf(km, 0), unit: 'km' };
}

const MILES_PER_KM = 0.621371;

function relativeTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function utc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

function el(tag, className, html) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (html != null) n.innerHTML = html;
  return n;
}

function statTile({ label, value, unit, sub, wide }) {
  const s = el('div', `stat${wide ? ' is-wide' : ''}`);
  s.append(el('div', 'stat-label', label));
  s.append(el('div', 'stat-value', `${value}${unit ? `<span class="unit">${unit}</span>` : ''}`));
  if (sub) s.append(el('div', 'stat-sub', sub));
  return s;
}

function kvRows(container, rows) {
  container.replaceChildren();
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const row = el('div', 'row');
    row.append(el('dt', null, k));
    row.append(el('dd', null, v));
    container.append(row);
  }
}

function renderFeed(container, items, emptyMessage) {
  container.replaceChildren();
  if (!items?.length) {
    container.append(el('p', 'empty', emptyMessage));
    return;
  }
  for (const a of items.slice(0, 6)) {
    const link = el('a', 'feed-item');
    link.href = a.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.append(el('div', 'feed-title', a.title));
    const meta = el('div', 'feed-meta');
    meta.append(el('span', null, a.newsSite ?? ''));
    meta.append(el('span', 'dot', '·'));
    meta.append(el('span', null, relativeTime(a.publishedAt)));
    link.append(meta);
    container.append(link);
  }
}

/* ================================================================== *
 * Panel renderers
 * ================================================================== */

function renderJWST(tele, news) {
  const b = tele?.bodies?.jwst;
  const stats = document.getElementById('jwst-stats');
  stats.replaceChildren();
  if (!b) { stats.append(el('p', 'empty', 'Ephemeris unavailable.')); return; }

  const earth = distance(b.rangeFromEarth);
  const l2 = distance(b.rangeFromL2);

  stats.append(statTile({
    label: 'Distance from Earth', value: earth.value, unit: earth.unit,
    sub: `${nf(b.rangeFromEarth * MILES_PER_KM / 1e6, 3)} million miles`,
  }));
  stats.append(statTile({
    label: 'Offset from L2', value: l2.value, unit: l2.unit,
    sub: 'Halo radius — Webb orbits L2, it does not sit on it',
  }));
  stats.append(statTile({
    label: 'Light delay to Earth', value: nf(b.rangeFromEarth / 299792.458, 2), unit: 's',
    sub: 'One way, at c',
  }));
  stats.append(statTile({
    label: 'Orbit', value: 'L2 halo', unit: '',
    sub: '~6 month period',
  }));

  document.getElementById('jwst-location-note').textContent =
    `Position from JPL Horizons (NAIF ${b.naifId}), ecliptic J2000, geocentric. `
    + `In the 3D view Earth is drawn about ${Math.round(EARTH_EXAGGERATION)}× oversized and the spacecraft are symbolic markers — `
    + `at true scale both telescopes would be far smaller than one pixel. Positions and paths are real.`;

  kvRows(document.getElementById('jwst-mission'), [
    ['Status', 'Operational — science operations since July 2022'],
    ['Operator', 'STScI for NASA / ESA / CSA'],
    ['Aperture', '6.5 m segmented primary, 18 gold-coated beryllium segments'],
    ['Instruments', 'NIRCam · NIRSpec · MIRI · FGS/NIRISS'],
    ['Wavelengths', '0.6 – 28.5 µm (orange through mid-infrared)'],
    ['Mirror temp', 'Below ~50 K, passively cooled by the five-layer sunshield'],
    ['Launched', '25 December 2021 · Ariane 5 ECA+ from Kourou'],
  ]);

  renderFeed(document.getElementById('jwst-feed'), news?.feeds?.jwst,
    'No recent articles in the snapshot. The news fetcher populates this on the next CI run.');
}

function renderRoman(tele, news) {
  const b = tele?.bodies?.roman;
  const stats = document.getElementById('roman-stats');
  const cruise = document.getElementById('roman-cruise');
  stats.replaceChildren();
  cruise.replaceChildren();
  if (!b) { stats.append(el('p', 'empty', 'Ephemeris unavailable.')); return; }

  const inCruise = b.phase === 'cruise';
  document.getElementById('roman-phase').textContent =
    inCruise ? 'In cruise · en route to L2' : 'Operational · Sun–Earth L2 orbit';

  // Cruise progress bar — the single most informative thing about Roman today,
  // and it will visibly change every day until it arrives.
  if (inCruise) {
    const pct = Math.round((b.cruiseProgress ?? 0) * 100);
    const track = el('div', 'cruise-track');
    const fill = el('div', 'cruise-fill');
    fill.style.width = '0%';
    track.append(fill);
    cruise.append(track);
    const meta = el('div', 'cruise-meta');
    meta.append(el('span', null, 'Launch'));
    meta.append(el('span', null, `<strong>${pct}%</strong> of the way to L2`));
    meta.append(el('span', null, 'L2 insertion'));
    cruise.append(meta);
    requestAnimationFrame(() => { fill.style.width = `${pct}%`; });
  }

  const earth = distance(b.rangeFromEarth);
  const toGo = distance(Math.max(0, (tele.l2?.distance ?? 1.5e6) - b.rangeFromEarth));

  stats.append(statTile({
    label: 'Distance from Earth', value: earth.value, unit: earth.unit,
    sub: `${nf(b.rangeFromEarth * MILES_PER_KM / 1e6, 3)} million miles`,
  }));
  stats.append(statTile({
    label: inCruise ? 'Still to travel' : 'Offset from L2',
    value: inCruise ? toGo.value : distance(b.rangeFromL2).value,
    unit: inCruise ? toGo.unit : distance(b.rangeFromL2).unit,
    sub: inCruise ? 'Radial, to the L2 distance' : 'Halo radius',
  }));
  stats.append(statTile({
    label: 'Days since launch',
    value: nf(Math.floor((Date.now() - Date.parse('2026-08-30T11:26:04Z')) / 86400000)),
    unit: 'd', sub: 'Launched 30 Aug 2026, 11:26 UTC',
  }));
  stats.append(statTile({
    label: 'Light delay to Earth', value: nf(b.rangeFromEarth / 299792.458, 2), unit: 's',
    sub: 'One way, at c',
  }));

  const note = document.getElementById('roman-location-note');
  const warn = b.arcClamped
    ? ' Roman\'s trajectory is a short-arc solution that JPL re-issues as tracking comes in, '
      + `so the plotted path ends where the current arc ends (${b.coverage?.notAfter ?? 'see Horizons'}) rather than at L2.`
    : '';
  note.textContent =
    `Position from JPL Horizons (NAIF ${b.naifId}), ecliptic J2000, geocentric.${warn}`;
  note.classList.toggle('is-warn', Boolean(b.arcClamped));

  kvRows(document.getElementById('roman-mission'), [
    ['Status', inCruise ? 'Commissioning, in cruise to L2' : 'Operational'],
    ['Objective', 'Dark energy, dark matter, exoplanet microlensing, infrared surveys'],
    ['Aperture', '2.4 m — Hubble-class mirror, ~100× Hubble\'s field of view'],
    ['Instruments', 'Wide Field Instrument · Coronagraph technology demonstration'],
    ['Wavelengths', '0.48 – 2.30 µm (blue through near-infrared)'],
    ['Destination', 'Sun–Earth L2 halo orbit, ~3 month cruise'],
    ['Launched', '30 August 2026 · Falcon Heavy from KSC LC-39A'],
    ['Planned life', '5 years primary; a precise September 2026 burn extended the propellant-limited lifetime'],
  ]);

  renderFeed(document.getElementById('roman-feed'), news?.feeds?.roman,
    'No recent articles in the snapshot. The news fetcher populates this on the next CI run.');
}

function renderStarship(ship, news) {
  const next = ship?.next;
  const stats = document.getElementById('starship-stats');
  stats.replaceChildren();

  document.getElementById('starship-status').textContent =
    next?.status?.name ? `Next flight · ${next.status.name}` : 'Next flight';

  if (next) {
    stats.append(statTile({ label: 'Vehicle', value: next.rocket ?? '—', unit: '', wide: true }));
    stats.append(statTile({
      label: 'Launch site', value: next.pad?.name ?? '—', unit: '',
      sub: next.pad?.location ?? '',
    }));
    stats.append(statTile({
      label: 'Target orbit', value: next.mission?.orbit ?? '—', unit: '',
      sub: next.mission?.name ?? '',
    }));
    stats.append(statTile({
      label: 'Launch window (UTC)', value: utc(next.net), unit: '', wide: true,
      sub: next.windowEnd ? `Window closes ${utc(next.windowEnd)}` : '',
    }));
  } else {
    stats.append(el('p', 'empty', 'No upcoming Starship flight in the snapshot.'));
  }

  kvRows(document.getElementById('starship-mission'), [
    ['Mission', next?.mission?.name ?? '—'],
    ['Type', next?.mission?.type ?? '—'],
    ['Status', next?.status?.description ?? next?.status?.name ?? '—'],
    ['Stack', '124.4 m tall · 9 m diameter · 33 Raptors on the booster'],
    ['Payload to LEO', '~100 t (published figure for the v3 stack)'],
  ]);

  document.getElementById('starship-desc').textContent = next?.mission?.description ?? '';

  // Flight profile timeline
  const tl = document.getElementById('starship-timeline');
  tl.replaceChildren();
  const profile = ship?.profile ?? [];
  if (!profile.length) {
    tl.append(el('p', 'empty', 'No published timeline in the snapshot.'));
  } else {
    for (const step of profile) {
      const li = el('li');
      const sign = step.t < 0 ? '−' : '+';
      const a = Math.abs(step.t);
      const hh = String(Math.floor(a / 3600)).padStart(2, '0');
      const mm = String(Math.floor((a % 3600) / 60)).padStart(2, '0');
      const ss = String(a % 60).padStart(2, '0');
      li.append(el('div', 't-time', `T${sign}${hh}:${mm}:${ss}`));
      li.append(el('div', 't-label', step.label));
      tl.append(li);
    }
  }

  renderFeed(document.getElementById('starship-feed'), news?.feeds?.starship,
    'No recent articles in the snapshot. The news fetcher populates this on the next CI run.');

  return next?.net ?? null;
}

/* ---------------------------- Countdown ---------------------------- */

function startCountdown(netIso) {
  const root = document.getElementById('starship-countdown');
  root.replaceChildren();
  if (!netIso) {
    root.append(el('p', 'empty', 'No scheduled launch time available.'));
    return () => {};
  }

  const units = ['Days', 'Hours', 'Minutes', 'Seconds'].map((label) => {
    const box = el('div', 'cd-unit');
    const num = el('div', 'cd-num', '--');
    box.append(num);
    box.append(el('div', 'cd-lab', label));
    root.append(box);
    return num;
  });

  const target = Date.parse(netIso);
  const tick = () => {
    let ms = target - Date.now();
    const past = ms < 0;
    root.classList.toggle('is-past', past);
    ms = Math.abs(ms);
    const d = Math.floor(ms / 86400000);
    const h = Math.floor(ms / 3600000) % 24;
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    const vals = [d, h, m, s];
    units.forEach((n, i) => {
      const t = i === 0 ? String(vals[i]) : String(vals[i]).padStart(2, '0');
      if (n.textContent !== t) n.textContent = t;
    });
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

/* ================================================================== *
 * Boot
 * ================================================================== */

const canvasL2 = document.getElementById('stage-l2');
const canvasShip = document.getElementById('stage-starship');

let l2Scene = null;
let shipScene = null;
let activeTab = 'jwst';
let stopCountdown = () => {};

function selectTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;

  for (const btn of document.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.panel')) {
    const on = p.id === `panel-${tab}`;
    p.classList.toggle('is-active', on);
    p.hidden = !on;
  }

  const ship = tab === 'starship';
  canvasL2.hidden = ship;
  canvasShip.hidden = !ship;

  if (ship) {
    shipScene?.resize();
  } else {
    l2Scene?.resize();
    l2Scene?.applyFocus(tab);
  }
  history.replaceState(null, '', `#${tab}`);
}

async function boot() {
  // Scenes first so the canvas is never blank while data loads.
  l2Scene = new L2Scene(canvasL2);
  shipScene = new StarshipScene(canvasShip);

  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (activeTab === 'starship') shipScene.render(dt);
    else l2Scene.render(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const [tele, ship, news] = await Promise.all([
    loadJSON('/data/telescopes.json', null),
    loadJSON('/data/starship.json', null),
    loadJSON('/data/news.json', { feeds: {} }),
  ]);

  if (tele) l2Scene.setData(tele);
  if (ship) shipScene.setData(ship);

  renderJWST(tele, news);
  renderRoman(tele, news);
  const net = renderStarship(ship, news);
  stopCountdown();
  stopCountdown = startCountdown(net);

  // Freshness indicator. The seeded snapshots ship with the repo; once CI runs,
  // generatedAt moves and `seeded` disappears.
  const stamp = tele?.generatedAt ?? ship?.generatedAt;
  const fresh = document.getElementById('freshness');
  const text = document.getElementById('freshness-text');
  if (stamp) {
    const seeded = tele?.seeded || ship?.seeded;
    text.textContent = seeded ? `seed data · ${relativeTime(stamp)}` : `updated ${relativeTime(stamp)}`;
    fresh.classList.toggle('is-stale', Boolean(seeded) || (Date.now() - Date.parse(stamp)) > 3 * 3600_000);
    fresh.title = `Snapshot generated ${utc(stamp)}`;
  } else {
    text.textContent = 'data unavailable';
    fresh.classList.add('is-stale');
  }

  l2Scene.applyFocus('jwst');
}

/* ---------------------------- Events ---------------------------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) selectTab(btn.dataset.tab);
});

// Arrow-key navigation between tabs, per the ARIA tabs pattern.
document.getElementById('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...document.querySelectorAll('.tab')];
  const i = tabs.findIndex((t) => t.dataset.tab === activeTab);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  selectTab(next.dataset.tab);
});

document.querySelector('.segmented')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  for (const s of document.querySelectorAll('.seg')) s.classList.toggle('is-active', s === btn);
  shipScene?.setMode(btn.dataset.mode);
  document.getElementById('starship-view-note').textContent = btn.dataset.mode === 'vehicle'
    ? 'The stack, drawn to published v3 proportions: 124.4 m tall, 9 m diameter.'
    : 'Planned ground track, computed from the launch site and orbital inclination. '
      + 'There is no public live telemetry feed for Starship — launch timing and status are live, this path is the published plan.';
});

// Deep link support: /#roman opens that tab.
const initial = location.hash.replace('#', '');
if (['jwst', 'roman', 'starship'].includes(initial) && initial !== 'jwst') {
  // selectTab runs after boot sets up the scenes
  queueMicrotask(() => selectTab(initial));
}

boot();
