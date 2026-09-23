#!/usr/bin/env node
/**
 * Render the dashboard headlessly: screenshots every tab at desktop and mobile,
 * captures console output, and asserts the page actually populated.
 *
 * This is the highest-value dev tool in the repo for a WebGL project. Two bugs
 * that were invisible to the naked eye were caught here:
 *   - a GLSL compile failure that surfaced only as `INVALID_OPERATION: useProgram`
 *   - the Starship stack rendering as a black silhouette (no environment map)
 * Neither is something you would spot by glancing at the page.
 *
 * Usage
 *   npm run build && npm run shots         # serve ./dist and capture
 *   npm run shots -- --dev                 # capture the running vite dev server
 *   npm run shots -- --url https://…       # smoke-test a deployed URL
 *   npm run shots -- --out /tmp/shots
 *
 * Exits non-zero if the page throws, or if any tab fails to populate — so it
 * works as a post-deploy smoke test in CI, not just a screenshotter.
 *
 * Requires: npm i -D playwright && npx playwright install chromium
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};

const OUT = resolve(String(flag('out') ?? join(ROOT, 'screenshots')));
const DEV = Boolean(flag('dev'));
const URL_ARG = typeof flag('url') === 'string' ? flag('url') : null;
const PORT = 8123;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** Serve ./dist so the built bundle is tested, not the dev server's transforms. */
async function serveDist() {
  const dist = join(ROOT, 'dist');
  try {
    await access(join(dist, 'index.html'));
  } catch {
    console.error('No dist/index.html — run `npm run build` first.');
    process.exit(1);
  }
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = join(dist, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, r));
  return { url: `http://localhost:${PORT}/`, close: () => server.close() };
}

/**
 * Prefer a preinstalled chromium when one is present (some sandboxes ship it at
 * a fixed path and block the download), otherwise let playwright resolve it.
 */
async function launch() {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
  let executablePath;
  for (const c of candidates) {
    try { await access(c); executablePath = c; break; } catch { /* keep looking */ }
  }
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      // Software GL so this runs on a headless box with no GPU.
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--no-sandbox',
      // Without these chromium hangs trying to reach google endpoints on a
      // network that blocks them, and `goto` never resolves.
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
      '--disable-domain-reliability', '--disable-client-side-phishing-detection',
      '--metrics-recording-only',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
    ],
  });
}

const TABS = [
  { id: 'jwst', statsSel: '#jwst-stats .stat' },
  { id: 'roman', statsSel: '#roman-stats .stat' },
  { id: 'starship', statsSel: '#starship-stats .stat' },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  let target = URL_ARG;
  let stop = () => {};
  if (!target) {
    if (DEV) {
      target = 'http://localhost:5173/';
    } else {
      const s = await serveDist();
      target = s.url;
      stop = s.close;
    }
  }

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.stack ?? String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  console.log(`→ ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const failures = [];

  // WebGL actually initialised?
  const gl = await page.evaluate(() => {
    const c = document.getElementById('stage-l2');
    if (!c) return null;
    const ctx = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!ctx) return null;
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ctx.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : ctx.RENDERER) };
  });
  if (!gl) failures.push('WebGL context was not created on #stage-l2');
  else console.log(`  GL: ${gl.renderer}`);

  for (const tab of TABS) {
    await page.click(`#tab-${tab.id}`);
    try {
      // Software rendering is slow; the render loop can starve the main thread,
      // so give this real headroom rather than a fixed sleep.
      await page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length > 0,
        tab.statsSel,
        { timeout: 40000 },
      );
    } catch {
      failures.push(`${tab.id}: no stat tiles rendered (${tab.statsSel})`);
    }
    // Let the camera flight settle before capturing.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT, `${tab.id}.png`) });
    console.log(`  ✓ ${tab.id}.png`);

    // The fixed footer once sat on top of whichever card reached the bottom of
    // the viewport. Invisible to every other check here, obvious to a reader.
    const covered = await page.evaluate(() => {
      const legal = document.getElementById('legal')?.getBoundingClientRect();
      if (!legal) return [];
      const hits = [];
      for (const card of document.querySelectorAll('.panel.is-active .card')) {
        const r = card.getBoundingClientRect();
        const h = Math.min(r.bottom, legal.bottom, innerHeight) - Math.max(r.top, legal.top);
        const w = Math.min(r.right, legal.right) - Math.max(r.left, legal.left);
        if (h > 1 && w > 1) hits.push(card.querySelector('h3')?.textContent.trim() ?? 'a card');
      }
      return hits;
    });
    if (covered.length) failures.push(`${tab.id}: footer overlaps ${covered.join(', ')}`);
  }

  // Starship has a second 3D mode worth capturing.
  await page.click('#tab-starship');
  await page.click('.seg[data-mode="profile"]');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT, 'starship-profile.png') });
  console.log('  ✓ starship-profile.png');

  // Did data actually load, or is the page showing seed/empty state?
  const freshness = await page.evaluate(
    () => document.getElementById('freshness-text')?.textContent ?? '',
  );
  console.log(`  freshness: "${freshness}"`);
  if (/unavailable/i.test(freshness)) failures.push('data snapshots failed to load');

  // Mobile breakpoint — a different layout path, so it needs its own check.
  await page.setViewportSize({ width: 414, height: 896 });
  await page.click('#tab-jwst');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, 'mobile-jwst.png') });
  console.log('  ✓ mobile-jwst.png');

  // A horizontal scrollbar at phone width is always a layout bug.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 2) failures.push(`horizontal overflow at 414px: ${overflow}px`);

  await browser.close();
  stop();

  console.log('');
  if (pageErrors.length) {
    console.log(`PAGE ERRORS (${pageErrors.length}):`);
    for (const e of pageErrors) console.log('  ' + e.split('\n')[0]);
  }
  if (consoleErrors.length) {
    console.log(`CONSOLE ERRORS (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 15)) console.log('  ' + e);
  }

  const fatal = failures.length || pageErrors.length || consoleErrors.length;
  if (fatal) {
    if (failures.length) {
      console.log(`ASSERTION FAILURES (${failures.length}):`);
      for (const f of failures) console.log('  ✗ ' + f);
    }
    console.log(`\nFAILED — screenshots in ${OUT}`);
    process.exit(1);
  }
  console.log(`PASS — screenshots in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
