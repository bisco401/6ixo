import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ORIGIN, decode, escapeHtml, pageFile, meta, writeChanged, crawlAllowed } from './lib/seo.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export async function generateSitemap(root = ROOT, date = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const sitemapFile = path.join(root, 'sitemap.xml'), stateFile = path.join(root, 'data/seo-page-state.json');
  const oldXml = await fs.readFile(sitemapFile, 'utf8');
  const priorDates = new Map([...oldXml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map(m => [decode(m[1]), m[2]]));
  const oldUrls = [...oldXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => decode(m[1]));
  let state = {};
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data/generated-listing-pages.json'), 'utf8'));
  const listingByUrl = new Map(manifest.listings.map(l => [l.url, l]));
  const urls = [...new Set([...oldUrls.filter(url => !new URL(url).pathname.startsWith('/listing')), ...manifest.listings.map(l => l.url), ...(manifest.indexes || []).map(i => i.url)])].sort();
  const robots = await fs.readFile(path.join(root, 'robots.txt'), 'utf8');
  const nextState = {}, entries = [];
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN || parsed.search || parsed.hash) throw new Error(`Invalid canonical URL: ${url}`);
    const html = await fs.readFile(path.join(root, pageFile(parsed.pathname)), 'utf8');
    const directives = meta(html, 'name', 'robots').toLowerCase().split(/[\s,]+/);
    if (directives.includes('noindex') || directives.includes('none')) continue;
    if (!crawlAllowed(url, robots)) throw new Error(`Indexable page is blocked by robots.txt: ${url}`);
    if (meta(html, 'rel', 'canonical', 'href', 'link') !== url) throw new Error(`Canonical does not match sitemap URL: ${url}`);
    const hash = crypto.createHash('sha256').update(html).digest('hex');
    const previous = state[url];
    const lastmod = previous?.hash === hash ? previous.lastmod : previous ? today : priorDates.get(url) || today;
    nextState[url] = { hash, lastmod };
    const images = listingByUrl.get(url)?.images || [];
    entries.push(`  <url><loc>${escapeHtml(url)}</loc><lastmod>${lastmod}</lastmod>${images.map(image => `<image:image><image:loc>${escapeHtml(image)}</image:loc></image:image>`).join('')}</url>`);
  }
  if (entries.length > 50000) throw new Error('Split the sitemap before exceeding 50,000 URLs.');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${entries.join('\n')}\n</urlset>\n`;
  if (Buffer.byteLength(xml) > 50 * 1024 * 1024) throw new Error('Sitemap exceeds 50 MB.');
  await writeChanged(sitemapFile, xml);
  await writeChanged(stateFile, JSON.stringify(nextState, null, 2) + '\n');
  console.log(`Generated sitemap for ${entries.length} canonical pages, including listing images. Unchanged pages retain their lastmod.`);
  return nextState;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateSitemap();
