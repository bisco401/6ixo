import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ORIGIN = 'https://6ixo.com';
const errors = [];
const warnings = [];

const decode = (value = '') => value
  .replaceAll('&amp;', '&')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>');

const attr = (html, element, name, value, wanted = 'content') => {
  const tags = [...html.matchAll(new RegExp(`<${element}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
  const selected = tags.find((tag) => new RegExp(`\\b${name}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(tag));
  return selected?.match(new RegExp(`\\b${wanted}=["']([^"']*)["']`, 'i'))?.[1] ?? '';
};

const count = (html, regex) => [...html.matchAll(regex)].length;
const pageFile = (pathname) => pathname === '/' ? 'index.html' : path.join(pathname.slice(1), 'index.html');

const sitemapXml = await fs.readFile(path.join(ROOT, 'sitemap.xml'), 'utf8');
const robotsTxt = await fs.readFile(path.join(ROOT, 'robots.txt'), 'utf8');
const urls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decode(match[1].trim()));

try {
  const indexNowConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'indexnow.config.json'), 'utf8'));
  const indexNowOrigin = new URL(indexNowConfig.origin);
  const keyFile = String(indexNowConfig.keyFile || '');
  if (indexNowOrigin.origin !== ORIGIN || indexNowConfig.origin !== ORIGIN) {
    errors.push(`IndexNow origin must be ${ORIGIN}`);
  }
  if (path.basename(keyFile) !== keyFile || !/^[A-Za-z0-9-]{8,128}\.txt$/.test(keyFile)) {
    errors.push('IndexNow keyFile must be a valid root-level .txt filename');
  } else {
    const key = (await fs.readFile(path.join(ROOT, keyFile), 'utf8')).trim();
    if (key !== keyFile.slice(0, -4)) errors.push('IndexNow key file name and contents do not match');
  }
  if (indexNowConfig.endpoint !== 'https://api.indexnow.org/indexnow') {
    errors.push('IndexNow endpoint must be https://api.indexnow.org/indexnow');
  }
} catch (error) {
  errors.push(`Invalid IndexNow configuration: ${error.message}`);
}

if (!urls.length) errors.push('sitemap.xml contains no URLs');
if (!robotsTxt.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) errors.push('robots.txt does not advertise the canonical sitemap');
if (new Set(urls).size !== urls.length) errors.push('sitemap.xml contains duplicate URLs');

const seenTitles = new Map();
const seenDescriptions = new Map();
const seenCanonicals = new Map();
const linksByPage = new Map();
const structuredTypesByPage = new Map();

for (const url of urls) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    errors.push(`Invalid sitemap URL: ${url}`);
    continue;
  }
  if (parsed.origin !== ORIGIN || parsed.search || parsed.hash) {
    errors.push(`Sitemap URL must be a clean canonical URL on ${ORIGIN}: ${url}`);
    continue;
  }

  const relativeFile = pageFile(parsed.pathname);
  const absoluteFile = path.join(ROOT, relativeFile);
  let html;
  try {
    html = await fs.readFile(absoluteFile, 'utf8');
  } catch {
    errors.push(`${url} maps to missing file ${relativeFile}`);
    continue;
  }

  const label = parsed.pathname;
  const title = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '');
  const description = decode(attr(html, 'meta', 'name', 'description'));
  const robots = decode(attr(html, 'meta', 'name', 'robots')).toLowerCase();
  const canonical = decode(attr(html, 'link', 'rel', 'canonical', 'href'));
  const h1Count = count(html, /<h1\b/gi);
  const localLinks = new Set();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    try {
      const linked = new URL(decode(match[1]), url);
      if (linked.origin === ORIGIN) localLinks.add(`${linked.origin}${linked.pathname}`);
    } catch {}
  }
  linksByPage.set(url, localLinks);

  if (!/^<!doctype html>/i.test(html.trimStart())) errors.push(`${label}: missing HTML5 doctype`);
  if (!/<html\b[^>]*\blang=["'][^"']+["']/i.test(html)) errors.push(`${label}: missing html lang attribute`);
  if (!title) errors.push(`${label}: missing title`);
  if (title.length > 65) warnings.push(`${label}: title is ${title.length} characters`);
  if (!description) errors.push(`${label}: missing meta description`);
  if (description.length < 70 || description.length > 165) warnings.push(`${label}: meta description is ${description.length} characters`);
  if (!robots.includes('index') || !robots.includes('follow')) errors.push(`${label}: robots meta must explicitly allow indexing and following`);
  if (!robots.includes('max-image-preview:large')) errors.push(`${label}: robots meta must allow large image previews`);
  if (canonical !== url) errors.push(`${label}: canonical is ${canonical || 'missing'}, expected ${url}`);
  if (h1Count !== 1) errors.push(`${label}: expected exactly one h1, found ${h1Count}`);

  for (const [key, type, name] of [
    ['og:type', 'property', 'og:type'],
    ['og:site_name', 'property', 'og:site_name'],
    ['og:url', 'property', 'og:url'],
    ['og:title', 'property', 'og:title'],
    ['og:description', 'property', 'og:description'],
    ['og:image', 'property', 'og:image'],
    ['og:image:alt', 'property', 'og:image:alt'],
    ['twitter:card', 'name', 'twitter:card'],
    ['twitter:title', 'name', 'twitter:title'],
    ['twitter:description', 'name', 'twitter:description'],
    ['twitter:image', 'name', 'twitter:image'],
    ['twitter:image:alt', 'name', 'twitter:image:alt']
  ]) {
    if (!attr(html, 'meta', type, name)) errors.push(`${label}: missing ${key}`);
  }
  if (decode(attr(html, 'meta', 'property', 'og:url')) !== url) errors.push(`${label}: og:url must match canonical`);

  const jsonBlocks = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (!jsonBlocks.length) errors.push(`${label}: missing JSON-LD structured data`);
  const structuredTypes = new Set();
  const collectStructuredTypes = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(collectStructuredTypes);
      return;
    }
    const type = value['@type'];
    if (Array.isArray(type)) type.forEach((entry) => structuredTypes.add(String(entry)));
    else if (type) structuredTypes.add(String(type));
    Object.values(value).forEach(collectStructuredTypes);
  };
  for (const [, rawJson] of jsonBlocks) {
    try {
      collectStructuredTypes(JSON.parse(rawJson));
    } catch (error) {
      errors.push(`${label}: invalid JSON-LD (${error.message})`);
    }
  }
  structuredTypesByPage.set(url, structuredTypes);

  for (const [kind, value, registry] of [
    ['title', title.toLowerCase(), seenTitles],
    ['description', description.toLowerCase(), seenDescriptions],
    ['canonical', canonical, seenCanonicals]
  ]) {
    if (!value) continue;
    if (registry.has(value)) errors.push(`${label}: duplicate ${kind} also used by ${registry.get(value)}`);
    else registry.set(value, label);
  }
}

for (const url of urls) {
  const pathname = new URL(url).pathname;
  const types = structuredTypesByPage.get(url) || new Set();
  if (pathname === '/') {
    if (!types.has('Organization')) errors.push('/: JSON-LD must identify the Organization');
    if (!types.has('WebSite')) errors.push('/: JSON-LD must identify the WebSite');
  } else {
    if (!types.has('BreadcrumbList')) errors.push(`${pathname}: JSON-LD must include breadcrumbs`);
    if (!types.has('WebPage') && !types.has('CollectionPage')) errors.push(`${pathname}: JSON-LD must describe the page`);
    const hasInboundLink = [...linksByPage.entries()].some(([source, links]) => source !== url && links.has(url));
    if (!hasInboundLink) errors.push(`${pathname}: no crawlable internal link points to this sitemap URL`);
  }
}

const disallowedPrefixes = [...robotsTxt.matchAll(/^Disallow:\s*([^*$\s][^*$]*)$/gmi)]
  .map((match) => match[1].trim())
  .filter(Boolean);
for (const url of urls) {
  const pathname = new URL(url).pathname;
  if (disallowedPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    errors.push(`${pathname}: sitemap URL is blocked by robots.txt`);
  }
}

const sitemapDates = [...sitemapXml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]);
const today = new Date().toISOString().slice(0, 10);
for (const date of sitemapDates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.push(`Invalid sitemap lastmod: ${date}`);
  if (date > today) errors.push(`Sitemap lastmod is in the future: ${date}`);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`FAIL ${error}`);

if (errors.length) {
  console.error(`\nSEO audit failed with ${errors.length} error(s) and ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`SEO audit passed for ${urls.length} indexable pages with ${warnings.length} warning(s).`);
