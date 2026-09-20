/**
 * Per-program news from the Spaceflight News API (free, no key, CORS-enabled,
 * same nonprofit that runs Launch Library 2).
 * Writes public/data/news.json.
 *
 * We still fetch this server-side so every panel on the page reads from one
 * static snapshot and the site works with zero upstream calls at view time.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/news.json');

const BASE = 'https://api.spaceflightnewsapi.net/v4';

const FEEDS = {
  jwst: ['James Webb', 'JWST'],
  roman: ['Nancy Grace Roman', 'Roman Space Telescope'],
  starship: ['Starship'],
};

async function search(term, limit = 8) {
  const url = `${BASE}/articles/?search=${encodeURIComponent(term)}&limit=${limit}&ordering=-published_at`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`SNAPI HTTP ${res.status} for "${term}"`);
  const json = await res.json();
  return json.results ?? [];
}

function shape(a) {
  return {
    id: a.id,
    title: a.title,
    url: a.url,
    imageUrl: a.image_url ?? null,
    newsSite: a.news_site,
    summary: a.summary ?? '',
    publishedAt: a.published_at,
  };
}

async function main() {
  const out = {};
  for (const [key, terms] of Object.entries(FEEDS)) {
    const batches = await Promise.all(terms.map((t) => search(t)));
    const seen = new Set();
    out[key] = batches
      .flat()
      .map(shape)
      .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 10);
  }

  const payload = { generatedAt: new Date().toISOString(), source: BASE, feeds: out };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(
    'news.json written — ' +
    Object.entries(out).map(([k, v]) => `${k}:${v.length}`).join(' '),
  );
}

main().catch((err) => {
  console.error('fetch-news failed:', err.message);
  process.exit(1);
});
