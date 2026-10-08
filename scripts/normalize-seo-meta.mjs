import fs from 'node:fs/promises';
import path from 'node:path';
import { writeChanged } from './lib/seo.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ORIGIN = 'https://6ixo.com';
const SOCIAL_IMAGE = `${ORIGIN}/assets/og-image-v2.png`;
const ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
const ASSET_VERSION = '2026080301';

const sitemap = await fs.readFile(path.join(ROOT, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim());

const pageFile = (pathname) => pathname === '/' ? 'index.html' : path.join(pathname.slice(1), 'index.html');
const getMeta = (html, attribute, value) => {
  const tag = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0])
    .find((candidate) => new RegExp(`\\b${attribute}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(candidate));
  return tag?.match(/\bcontent=(["'])([\s\S]*?)\1/i)?.[2] ?? '';
};

const hasMeta = (html, attribute, value) => new RegExp(`<meta\\b[^>]*\\b${attribute}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i').test(html);
const htmlAttr = (value) => String(value).replaceAll('"', '&quot;');

for (const pageUrl of urls) {
  const parsed = new URL(pageUrl);
  // Listing templates already emit their complete metadata. Avoid rewriting them between builds.
  if (/^\/listings?\//.test(parsed.pathname)) continue;
  const filename = path.join(ROOT, pageFile(parsed.pathname));
  let html = await fs.readFile(filename, 'utf8');
  // A metadata refresh must never make retired or intentionally excluded pages indexable.
  if (/\b(noindex|none)\b/i.test(getMeta(html, 'name', 'robots'))) continue;

  html = html.replace(/<script\s+src=(["'])\/firebase-analytics\.js([^"']*)\1><\/script>/gi, '<script defer src=$1/firebase-analytics.js$2$1></script>');
  html = html.replace(/\/firebase-analytics\.js\?v=\d+/g, `/firebase-analytics.js?v=${ASSET_VERSION}`);
  html = html.replaceAll('/assets/6ixo-logo.png', '/icon-192.png');
  html = html.replaceAll('src="assets/6ixo-logo.png"', 'src="/icon-192.png"');
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const isVisibleLogo = /\bsrc=["'][^"']*icon-192\.png/i.test(tag);
    let optimized = tag;
    const highPriority = /\bfetchpriority=["']high["']/i.test(tag);
    if (highPriority) optimized = optimized.replace(/\bloading=["']lazy["']/i, 'loading="eager"');
    if (!isVisibleLogo && !highPriority && !/\bloading=/i.test(optimized)) optimized = optimized.replace(/^<img\b/i, '<img loading="lazy"');
    if (!/\bdecoding=/i.test(optimized)) optimized = optimized.replace(/^<img\b/i, '<img decoding="async"');
    return optimized;
  });

  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? '6ixo';
  const description = getMeta(html, 'name', 'description');
  const imageAlt = `${title.replace(/\s*\|\s*6ixo.*$/i, '')} on the 6ixo worldwide marketplace`;

  if (hasMeta(html, 'name', 'robots')) {
    html = html.replace(/<meta\b(?=[^>]*\bname=["']robots["'])[^>]*>/i, `<meta name="robots" content="${ROBOTS}">`);
  }

  const additions = [];
  const ensureMeta = (attribute, name, content) => {
    if (!hasMeta(html, attribute, name)) additions.push(`    <meta ${attribute}="${name}" content="${htmlAttr(content)}">`);
  };

  ensureMeta('name', 'robots', ROBOTS);
  ensureMeta('property', 'og:type', 'website');
  ensureMeta('property', 'og:site_name', '6ixo');
  ensureMeta('property', 'og:locale', 'en_US');
  ensureMeta('property', 'og:url', pageUrl);
  ensureMeta('property', 'og:title', title);
  ensureMeta('property', 'og:description', description);
  ensureMeta('property', 'og:image', SOCIAL_IMAGE);
  if (getMeta(html, 'property', 'og:image') === SOCIAL_IMAGE) {
    ensureMeta('property', 'og:image:width', '1730');
    ensureMeta('property', 'og:image:height', '909');
  }
  ensureMeta('property', 'og:image:alt', imageAlt);
  ensureMeta('name', 'twitter:card', 'summary_large_image');
  ensureMeta('name', 'twitter:title', title);
  ensureMeta('name', 'twitter:description', description);
  ensureMeta('name', 'twitter:image', SOCIAL_IMAGE);
  ensureMeta('name', 'twitter:image:alt', imageAlt);

  if (!/<link\b(?=[^>]*\brel=["']icon["'])(?=[^>]*\bsizes=["']192x192["'])[^>]*>/i.test(html)) {
    additions.push('    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=202603040620">');
  }
  if (!hasMeta(html, 'name', 'theme-color')) additions.push('    <meta name="theme-color" content="#0b1b3a">');

  if (additions.length) html = html.replace(/\s*<\/head>/i, `\n${additions.join('\n')}\n</head>`);
  await writeChanged(filename, html);
}

console.log(`Normalized SEO metadata for ${urls.length} pages.`);
