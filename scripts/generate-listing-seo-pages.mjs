import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import integrity from './lib/listing-integrity.cjs';
import { ORIGIN, ROBOTS, clean, decode, escapeHtml as esc, jsonLd, truncate, slugify, httpUrl, pageFile, parseCsv, writeChanged } from './lib/seo.mjs';
import { searchGroups, countryGroups } from './lib/marketplace-search.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE_SIZE = 36;
const IMAGE = `${ORIGIN}/assets/og-image-v2.png`;
const CATEGORIES = {
  electronics: ['Electronics', '/electronics/'], vehicles: ['Cars for sale', '/cars-for-sale/'],
  'auto-parts': ['Auto parts', '/auto-parts/'], 'car-rentals': ['Car rentals', '/car-rentals/'],
  'short-term-rentals': ['Short-term rentals', '/short-term-rentals/'],
  'real-estate': ['Real estate', '/real-estate/'], services: ['Services', '/services/'],
  jobs: ['Jobs', '/jobs/'], fashion: ['Fashion', '/fashion/'], community: ['Community', '/community/'],
  'buy-and-sell': ['Buy and sell', '/buy-and-sell/']
};
const text = value => decode(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\s*(?:br\s*\/?|\/p|\/li|\/div)\s*>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/&nbsp;/gi, ' ').trim();
const parseAttributes = value => { try { return typeof value === 'string' ? JSON.parse(value || '{}') : value || {}; } catch { return {}; } };
const categoryKey = row => {
  if (row.app_category === 'vehicles') {
    if (/part|accessor|tires|rims/.test(row.app_subcategory)) return 'auto-parts';
    if (/rental/.test(row.app_subcategory)) return 'car-rentals';
    if (/repair|detailing/.test(row.app_subcategory)) return 'services';
    return 'vehicles';
  }
  if (row.app_category === 'real_estate') return row.app_subcategory === 'for_rent_short' ? 'short-term-rentals' : 'real-estate';
  if (['clothing', 'fashion'].includes(row.app_category)) return 'fashion';
  return CATEGORIES[row.app_category] ? row.app_category : 'buy-and-sell';
};

export function schemaEntity(listing) {
  const isProduct = ['electronics', 'vehicles', 'auto-parts', 'fashion', 'buy-and-sell'].includes(listing.categoryKey);
  const type = isProduct ? (listing.categoryKey === 'vehicles' ? ['Product', 'Vehicle'] : 'Product') : ['services', 'car-rentals', 'short-term-rentals'].includes(listing.categoryKey) ? 'Service' : 'Thing';
  const entity = { '@type': type, '@id': `${listing.url}#listing`, name: listing.title, description: listing.description, image: listing.imageUrls, url: listing.url };
  if (!isProduct) return entity;
  entity.sku = listing.id;
  entity.category = listing.categoryLabel;
  if (listing.details.length) entity.additionalProperty = listing.details.map(({ label, value }) => ({ '@type': 'PropertyValue', name: label, value }));
  const condition = clean(listing.condition).toLowerCase().replaceAll('_', ' ');
  const conditionUrl = /^(new|brand new)$/.test(condition) ? 'https://schema.org/NewCondition' : /^(used|pre owned|like new|good|fair)$/.test(condition) ? 'https://schema.org/UsedCondition' : /^(refurbished|renewed)$/.test(condition) ? 'https://schema.org/RefurbishedCondition' : '';
  if (conditionUrl) entity.itemCondition = conditionUrl;
  if (listing.priceValue !== null && Number.isFinite(listing.priceValue) && listing.priceValue >= 0 && /^[A-Z]{3}$/.test(listing.currency)) {
    entity.offers = { '@type': 'Offer', url: listing.url, price: listing.priceValue, priceCurrency: listing.currency };
    if (listing.source_availability === 'active') entity.offers.availability = 'https://schema.org/InStock';
    if (conditionUrl) entity.offers.itemCondition = conditionUrl;
    if (listing.seller && !/^(unknown|seller)$/i.test(listing.seller) && !/kijiji/i.test(listing.source_site)) entity.offers.seller = { '@type': 'Person', name: listing.seller };
  }
  return entity;
}

function head({ title, description, url, image = IMAGE, imageAlt = title, schema, noindex = false }) {
  return `<!DOCTYPE html>\n<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title><meta name="description" content="${esc(description)}">
  <meta name="robots" content="${noindex ? 'noindex, follow' : ROBOTS}"><link rel="canonical" href="${url}">
  <meta property="og:type" content="website"><meta property="og:site_name" content="6ixo"><meta property="og:locale" content="en_US"><meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="${esc(image)}"><meta property="og:image:alt" content="${esc(imageAlt)}">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(image)}"><meta name="twitter:image:alt" content="${esc(imageAlt)}">
  <link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#0b1b3a">
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&amp;display=swap"><link rel="stylesheet" href="/assets/marketplace-category.css">
  <script defer src="/firebase-analytics.js?v=2026080301"></script>${schema ? `<script type="application/ld+json">${jsonLd(schema)}</script>` : ''}
</head><body><a class="skip-link" href="#main">Skip to content</a>
<header class="page-shell"><nav class="site-nav" aria-label="Primary navigation"><a class="brand" href="/"><img src="/icon-192.png" alt="" width="54" height="54" decoding="async"><span>6ixo</span></a><div class="nav-links"><a href="/listings/">All listings</a><a href="/buy-and-sell/">Categories</a><a class="nav-cta" href="/?open=post-ad">Post an ad</a></div></nav></header>`;
}
const footer = '</main><footer class="site-footer"><div class="page-shell footer-inner"><span>© 2026 6ixo Marketplace</span><div class="footer-links"><a href="/listings/">Listings</a><a href="/about/">About</a><a href="/safety/">Safety</a><a href="/privacy/">Privacy</a></div></div></footer></body></html>\n';
const breadcrumbs = entries => ({ '@type': 'BreadcrumbList', itemListElement: [['6ixo', '/'], ...entries].map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${ORIGIN}${url}` })) });
const cards = listings => listings.map(l => `<article class="listing-index-card"><a href="${new URL(l.url).pathname}"><img src="${esc(l.imageUrls[0])}" alt="${esc(l.title)}" loading="lazy" decoding="async"><div><span>${esc(l.categoryLabel)}</span><h3>${esc(l.title)}</h3><strong>${esc(l.priceText || 'Contact seller for price')}</strong><p>${esc(l.location)}</p></div></a></article>`).join('\n');
const itemList = (listings, id) => ({ '@type': 'ItemList', '@id': id, numberOfItems: listings.length, itemListElement: listings.map((l, i) => ({ '@type': 'ListItem', position: i + 1, name: l.title, url: l.url })) });
const listingDetails = row => {
  const attributes = parseAttributes(row.attributes);
  const details = Array.isArray(attributes.details) ? attributes.details.filter(d => d && clean(d.label) && clean(d.value)).map(d => ({ label: clean(d.label), value: clean(d.value) })) : [];
  for (const [field, label] of [['make', 'Make'], ['model', 'Model'], ['trim', 'Trim'], ['year', 'Year'], ['mileage_km', 'Mileage (km)'], ['transmission', 'Transmission'], ['color', 'Color'], ['condition', 'Condition']]) {
    if (clean(row[field]) && !details.some(d => d.label.toLowerCase() === label.toLowerCase())) details.push({ label, value: clean(row[field]) });
  }
  return details.filter(d => !/^(phone|email|contact|address|latitude|longitude)$/i.test(d.label));
};

export async function generate(root = ROOT) {
  const manifestFile = path.join(root, 'data/generated-listing-pages.json');
  let previous = { listings: [], indexes: [] };
  try { previous = JSON.parse(await fs.readFile(manifestFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const previousById = new Map(previous.listings.map(l => [l.id, l]));
  const rowById = new Map();
  for (const feed of ['scraped-listings.csv', 'jamaica-listings.csv', 'dubai-listings.csv', 'guyana-listings.csv', 'kenya-listings.csv']) {
    let contents;
    try { contents = await fs.readFile(path.join(root, 'data', feed), 'utf8'); } catch (e) { if (e.code === 'ENOENT' && feed !== 'scraped-listings.csv') continue; throw e; }
    // Country feeds are authoritative overrides, including rejected/sold records.
    for (const row of parseCsv(contents)) if (clean(row.id)) rowById.set(clean(row.id), row);
  }
  const rows = [...rowById.values()];
  const readOptionalJson = async name => { try { return JSON.parse(await fs.readFile(path.join(root, 'data', name), 'utf8')).listings || {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
  const availability = await readOptionalJson('listing-availability.json');
  const repairs = await readOptionalJson('listing-integrity-repairs.json');
  rows.sort((a, b) => (Date.parse(b.scraped_at) || 0) - (Date.parse(a.scraped_at) || 0));
  const seen = new Set(), usedSlugs = new Set(), titles = new Set(), descriptions = new Set(), listings = [];
  for (const original of rows) {
    if (clean(original.status).toLowerCase() !== 'published') continue;
    if (/^(hidden|suppressed|removed|no_source_photo)$/.test(clean(original.sync_visibility).toLowerCase()) || /^(unavailable|removed|sold|expired|gone)$/.test(clean(original.source_availability).toLowerCase())) continue;
    const sourceKey = integrity.key(original.source_url || '');
    if (/^(sold|unavailable|removed|expired|gone)$/.test(clean(availability[sourceKey]?.availability))) continue;
    const repair = repairs[sourceKey] || {};
    const corrected = { ...original, ...(repair.replacementCity ? { city: repair.replacementCity } : {}), ...(repair.images?.length ? { image_files: '', image_urls: repair.images.join('|') } : {}) };
    const row = { ...corrected, ...integrity.classify(corrected) };
    row.id = clean(row.id); row.title = clean(text(row.title)); row.description = text(row.description);
    if (!row.id || !row.title || clean(row.description).length < 30) continue;
    const sourceUrl = httpUrl(row.source_url);
    const keys = [`id:${row.id}`, ...(sourceUrl ? [`url:${integrity.key(sourceUrl)}`] : [])];
    if (row.phone && row.city) keys.push(`content:${row.title.toLowerCase()}|${row.phone}|${row.city.toLowerCase()}|${row.country.toLowerCase()}`);
    if (keys.some(key => seen.has(key))) continue;
    const imageUrls = [];
    for (const raw of clean(row.image_files || row.image_urls).split('|')) {
      const image = raw.trim().replace(/^\.\//, '').replace(/^\//, '');
      if (/placeholder|photoapparat|map\d*\.craigslist\.org|\{\{/i.test(image)) continue;
      if (image.startsWith('data/') && !image.split('/').includes('..')) {
        try { const stat = await fs.stat(path.join(root, image)); if (stat.isFile() && stat.size > 1024) imageUrls.push(`${ORIGIN}/${image.split('/').map(encodeURIComponent).join('/')}`); } catch {}
      } else { const url = httpUrl(raw) || httpUrl(raw.startsWith('//') ? `https:${raw}` : ''); if (url) imageUrls.push(url); }
    }
    if (!imageUrls.length) continue;
    keys.forEach(key => seen.add(key));
    const shortId = row.id.replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase() || crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 10);
    let slug = previousById.get(row.id)?.slug || `${slugify(row.title)}-${shortId}`;
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Invalid previous listing slug: ${slug}`);
    if (usedSlugs.has(slug)) slug += `-${crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 8)}`;
    usedSlugs.add(slug);
    const key = categoryKey(row), [categoryLabel, route] = CATEGORIES[key];
    const location = [clean(row.city), clean(row.country)].filter(Boolean).join(', ');
    let seoTitle = `${truncate(`${row.title}${location ? ` in ${location}` : ''}`, 57)} | 6ixo`;
    if (titles.has(seoTitle.toLowerCase())) seoTitle = `${truncate(row.title, 45)} ${shortId} | 6ixo`;
    titles.add(seoTitle.toLowerCase());
    // Match the published display price, including imports whose numeric field supplied cents.
    const rawPrice = clean(row.price_value), displayPrice = Number(clean(row.price_text).replace(/[^0-9.]/g, ''));
    let priceValue = rawPrice ? Number(rawPrice) : null;
    if (Number.isFinite(priceValue) && displayPrice > 0 && priceValue / displayPrice > 90 && priceValue / displayPrice < 110) priceValue /= 100;
    if (!Number.isFinite(priceValue)) priceValue = null;
    const currency = clean(row.currency).toUpperCase();
    const priceText = clean(row.price_text) || (priceValue !== null ? `${currency} ${priceValue}`.trim() : '');
    let description = truncate(`${row.title}${location ? ` in ${location}` : ''}${priceText ? `, ${priceText}` : ''}. ${row.description} View photos and listing details on 6ixo.`, 160);
    if (descriptions.has(description.toLowerCase())) description = truncate(`Listing ${shortId}: ${description}`, 160);
    descriptions.add(description.toLowerCase());
    listings.push({ ...row, shortId, slug, url: `${ORIGIN}/listing/${slug}/`, sourceUrl, categoryKey: key, categoryLabel, route, location, priceValue, priceText, currency, imageUrls: [...new Set(imageUrls)].slice(0, 12), seoTitle, metaDescription: description, details: listingDetails(row) });
  }
  if (!listings.length && previous.listings.length) throw new Error('Refusing to retire every listing after an empty or invalid feed.');
  for (const l of listings) {
    const related = listings.filter(other => other.id !== l.id && other.categoryKey === l.categoryKey && other.country === l.country).slice(0, 3);
    const categoryIndex = `/listings/${l.categoryKey}/`;
    const schema = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', '@id': `${l.url}#page`, url: l.url, name: l.title, description: l.metaDescription, isPartOf: { '@id': `${ORIGIN}/#website` }, mainEntity: { '@id': `${l.url}#listing` }, inLanguage: 'en' }, schemaEntity(l), breadcrumbs([['Listings', '/listings/'], [l.categoryLabel, categoryIndex], [l.title, `/listing/${l.slug}/`]])] };
    const gallery = l.imageUrls.map((image, i) => `<img src="${esc(image)}" alt="${esc(l.title)}${i ? `, photo ${i + 1}` : ''}" loading="${i ? 'lazy' : 'eager'}" ${i ? '' : 'fetchpriority="high"'} decoding="async">`).join('');
    const facts = [['Price', l.priceText || 'Contact seller for price'], ['Location', l.location || 'See source listing'], ...l.details.map(d => [d.label, d.value])];
    const html = head({ title: l.seoTitle, description: l.metaDescription, url: l.url, image: l.imageUrls[0], imageAlt: l.title, schema }) + `<main id="main" class="page-shell listing-detail-page">
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Marketplace</a> / <a href="/listings/">Listings</a> / <a href="${categoryIndex}">${esc(l.categoryLabel)}</a></nav>
<section class="listing-detail-hero"><div class="listing-gallery">${gallery}</div><div class="listing-summary"><p class="eyebrow">${esc(l.categoryLabel)}</p><h1>${esc(l.title)}</h1><p class="listing-price">${esc(l.priceText || 'Contact seller for price')}</p><p class="listing-location">${esc(l.location)}</p><div class="hero-actions">${l.sourceUrl ? `<a class="button" href="${esc(l.sourceUrl)}" rel="ugc nofollow noopener" target="_blank">View original listing and contact seller</a>` : ''}<a class="button secondary" href="${l.route}">Browse on 6ixo</a></div></div></section>
<section class="section listing-copy"><div><p class="eyebrow">Listing details</p><h2>About this listing</h2>${l.description.split(/\n+/).filter(clean).map(p => `<p>${esc(p)}</p>`).join('')}</div><dl class="listing-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>
<section class="listing-source-note"><h2>Confirm the details with the seller</h2><p>This is an imported listing. Confirm availability, condition, seller identity and the complete price with the original seller before making payment.</p></section>
${related.length ? `<section class="section"><h2>Similar ${esc(l.categoryLabel.toLowerCase())} listings</h2><div class="listing-index-grid">${cards(related)}</div><p><a href="${categoryIndex}">See all ${esc(l.categoryLabel.toLowerCase())} listings</a></p></section>` : ''}` + footer;
    await writeChanged(path.join(root, 'listing', l.slug, 'index.html'), html);
  }
  const activeUrls = new Set(listings.map(l => l.url));
  const retired = new Map([...(previous.retired || []), ...previous.listings.filter(l => !activeUrls.has(l.url))].map(l => [l.url, l]));
  for (const url of activeUrls) retired.delete(url);
  for (const l of retired.values()) {
    if (!/^[a-z0-9-]+$/.test(l.slug)) continue;
    await writeChanged(path.join(root, 'listing', l.slug, 'index.html'), head({ title: 'Listing Unavailable | 6ixo', description: 'This listing is no longer available. Browse current marketplace listings, compare photos and prices, and find similar items on 6ixo.', url: l.url, noindex: true }) + '<main id="main" class="page-shell"><section class="hero"><div><h1>This listing is no longer available</h1><p>The seller may have removed or updated the listing.</p><a class="button" href="/listings/">Browse current listings</a></div></section>' + footer);
  }
  const allCategoryGroups = Object.entries(CATEGORIES).map(([key, [name, route]]) => ({ key, name, route, base: `/listings/${key}/`, items: listings.filter(l => l.categoryKey === key) }));
  const categoryGroups = allCategoryGroups.filter(g => g.items.length);
  const countries = [...new Set(listings.map(l => clean(l.country)).filter(Boolean))].sort();
  const topics = searchGroups(listings);
  const localGroups = countryGroups(listings, categoryGroups, topics);
  const groups = [{ name: 'Marketplace', base: '/listings/', items: listings }, ...categoryGroups, ...localGroups, ...topics];
  const indexes = [];
  const countryCategoryPage = (key, country) => key === 'vehicles'
    ? topics.find(g => g.slug === 'cars-for-sale' && g.place === country) || localGroups.find(g => g.categoryKey === key && g.country === country)
    : localGroups.find(g => g.categoryKey === key && g.country === country);
  const filters = group => `<nav class="listing-filters" aria-label="Browse listings by category"><a href="/listings/">All listings</a>${topics.filter(g => !g.place).map(g => `<a href="${g.base}">${esc(g.name)} (${g.items.length})</a>`).join('')}${categoryGroups.map(g => `<a href="${g.base}">${esc(g.name)} (${g.items.length})</a>`).join('')}</nav><nav class="listing-filters" aria-label="Browse listings by country">${countries.map(country => {
    const local = group.key ? countryCategoryPage(group.key, country) : localGroups.find(g => g.countryHub && g.country === country);
    return local ? `<a href="${local.base}">${esc(country)}</a>` : '';
  }).join('')}</nav>`;
  for (const group of groups) {
    const pages = Math.max(1, Math.ceil(group.items.length / PAGE_SIZE)), href = page => page === 1 ? group.base : `${group.base}page/${page}/`;
    for (let page = 1; page <= pages; page++) {
      const subset = group.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), pathname = href(page), url = `${ORIGIN}${pathname}`;
      const pageSuffix = page > 1 ? `, Page ${page}` : '';
      const title = `${truncate(group.title || group.heading || `${group.name} Listings`, 57 - pageSuffix.length)}${pageSuffix} | 6ixo`;
      const description = truncate(`${page > 1 ? `Page ${page}: ` : ''}${group.description || (group.place
        ? `Browse ${group.name.toLowerCase()} in ${group.place}. Compare ${group.items.length} ${group.items.length === 1 ? 'listing' : 'listings'} with prices, photos and details. Contact sellers on 6ixo.`
        : `Browse ${group.name.toLowerCase()} worldwide. Compare ${group.items.length} published listings with prices, photos and locations. Contact sellers on 6ixo.`)}`, 160);
      const pageCrumbs = group.breadcrumbs || (pathname !== '/listings/' ? [[group.heading || group.name, group.base]] : []);
      const schema = { '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', '@id': `${url}#page`, url, name: title, description, isPartOf: { '@id': `${ORIGIN}/#website` }, mainEntity: { '@id': `${url}#list` }, ...(group.country ? { spatialCoverage: { '@type': 'Country', name: group.country } } : {}), inLanguage: 'en' }, breadcrumbs([['Listings', '/listings/'], ...pageCrumbs, ...(page > 1 ? [[`Page ${page}`, pathname]] : [])]), itemList(subset, `${url}#list`)] };
      const pagination = pages > 1 ? `<nav class="listing-pagination" aria-label="Listing pages">${page > 1 ? `<a href="${href(page - 1)}" rel="prev">Previous</a>` : ''}${Array.from({ length: pages }, (_, i) => i + 1).map(p => p === page ? `<span aria-current="page">${p}</span>` : `<a href="${href(p)}" aria-label="Page ${p}">${p}</a>`).join('')}${page < pages ? `<a href="${href(page + 1)}" rel="next">Next</a>` : ''}</nav>` : '';
      const topicLinks = group.links?.length ? `<nav class="listing-filters" aria-label="${esc(group.name)} by location">${group.links.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}</nav>` : '';
      const guide = group.guide && page === 1 ? `<section class="section"><h2>${esc(group.guideTitle)}</h2><div class="card-grid">${group.guide.map(([heading, copy]) => `<article class="card"><h3>${esc(heading)}</h3><p>${esc(copy)}</p></article>`).join('')}</div><h2>Keep exploring</h2><div class="related-grid">${group.related.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}</div></section>` : '';
      const count = group.items.length ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, group.items.length)} of ${group.items.length} listings. Confirm availability with the seller.` : 'No matching listings are published right now. Browse related categories or post your own ad.';
      await writeChanged(path.join(root, pageFile(pathname)), head({ title, description, url, schema }) + `<main id="main" class="page-shell"><section class="listing-index-hero"><p class="eyebrow">Browse published ads</p><h1>${esc(group.heading || `${group.name} listings`)}${page > 1 ? `, page ${page}` : ''}</h1><p>${esc(group.intro || description)}</p>${group.postRoute ? `<div class="hero-actions"><a class="button" href="#current-listings">Browse listings</a><a class="button secondary" href="${group.postRoute}">${esc(group.postLabel)}</a></div>` : ''}</section>${group.guide || group.focused ? topicLinks : filters(group)}<p>${esc(count)}</p><section id="current-listings" class="listing-index-grid" aria-label="Current listings">${cards(subset)}</section>${pagination}${guide}` + footer);
      indexes.push({ url });
    }
  }
  const indexUrls = new Set(indexes.map(i => i.url));
  const previousIndexUrls = new Set((previous.indexes || []).map(i => i.url));
  for (const old of previous.indexes || []) if (!indexUrls.has(old.url)) {
    const pathname = new URL(old.url).pathname;
    if (!pathname.startsWith('/listings/') && !/^\/(apartments-for-rent|phones-for-sale|cars-for-sale|events)\//.test(pathname)) continue;
    await writeChanged(path.join(root, pageFile(pathname)), head({ title: 'Browse Current Listings | 6ixo', description: 'This listing page has changed. Browse current marketplace listings with photos, prices and locations on 6ixo.', url: old.url, noindex: true }) + '<main id="main" class="page-shell"><section class="hero"><div><h1>Browse the latest listings</h1><a class="button" href="/listings/">See current listings</a></div></section>' + footer);
  }
  // Give existing category and local guides actual inventory and crawlable detail links.
  const sitemap = await fs.readFile(path.join(root, 'sitemap.xml'), 'utf8');
  const guideUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]));
  for (const [key, [name, route]] of Object.entries(CATEGORIES)) {
    const guides = countries.map(country => countryCategoryPage(key, country)).filter(Boolean).map(g => [g.base, g.country]);
    const legacyGuides = guideUrls.filter(url => url.pathname.startsWith(route) && url.pathname.split('/').filter(Boolean).length === 2 && !indexUrls.has(url.href) && !previousIndexUrls.has(url.href));
    for (const url of legacyGuides) {
      const place = url.pathname.split('/').filter(Boolean).at(-1).split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
      guides.push([url.pathname, `${place} guide`]);
    }
    const file = path.join(root, pageFile(route));
    let html;
    try { html = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    html = html.replace(/\s*<!-- LOCAL GUIDES: START -->[\s\S]*?<!-- LOCAL GUIDES: END -->/g, '');
    const section = guides.length ? `\n<!-- LOCAL GUIDES: START -->\n<section class="section" aria-labelledby="destination-guides"><h2 id="destination-guides">${esc(name)} by country</h2><div class="related-grid">${guides.map(([href, country]) => `<a href="${href}">${esc(country)}</a>`).join('')}</div></section>\n<!-- LOCAL GUIDES: END -->\n` : '';
    await writeChanged(file, html.replace('</main>', section + '</main>'));
  }
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const pathname = new URL(match[1]).pathname;
    if (pathname.startsWith('/listing') || indexUrls.has(`${ORIGIN}${pathname}`)) continue;
    const category = allCategoryGroups.find(g => g.route === `/${pathname.split('/')[1]}/`);
    if (!category) continue;
    const local = pathname.split('/').filter(Boolean)[1];
    const selected = category.items.filter(l => !local || slugify(l.country) === local || slugify(l.city) === local).slice(0, 6);
    const file = path.join(root, pageFile(pathname));
    let html = await fs.readFile(file, 'utf8');
    html = html.replace(/\s*<!-- CURRENT INVENTORY: START -->[\s\S]*?<!-- CURRENT INVENTORY: END -->/g, '');
    if (selected.length) {
      const localPage = local ? countryCategoryPage(category.key, selected[0].country) : null;
      const section = `\n<!-- CURRENT INVENTORY: START -->\n<section class="section" aria-labelledby="current-inventory"><h2 id="current-inventory">Browse current ${esc(category.name.toLowerCase())} listings</h2><div class="listing-index-grid">${cards(selected)}</div><p><a href="${localPage?.base || category.base}">See all ${esc(category.name.toLowerCase())} listings${localPage ? ` in ${esc(localPage.country)}` : ''}</a></p></section><script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', ...itemList(selected, `${ORIGIN}${pathname}#inventory`) })}</script>\n<!-- CURRENT INVENTORY: END -->\n`;
      html = html.replace('</main>', section + '</main>');
    }
    await writeChanged(file, html);
  }
  // Every current country is visible from home and remains in sync with the ads.
  const homeFile = path.join(root, 'index.html');
  try {
    let home = await fs.readFile(homeFile, 'utf8');
    const hubs = localGroups.filter(g => g.countryHub);
    const section = `<!-- COUNTRY SEARCHES: START -->\n<section class="home-seo-hub" aria-labelledby="home-country-searches"><h2 id="home-country-searches">Browse listings by country</h2><p>Explore current ads and categories in the countries where people are listing on 6ixo.</p><nav class="home-seo-links home-country-links" aria-label="Marketplace countries">${hubs.map(g => `<a href="${g.base}"><strong>${esc(g.country)}</strong><span>${g.items.length} listings</span></a>`).join('')}</nav></section>\n<!-- COUNTRY SEARCHES: END -->`;
    if (home.includes('<!-- COUNTRY SEARCHES: START -->')) home = home.replace(/<!-- COUNTRY SEARCHES: START -->[\s\S]*?<!-- COUNTRY SEARCHES: END -->/g, section);
    else home = home.includes('<footer class="home-footer">') ? home.replace('<footer class="home-footer">', section + '\n<footer class="home-footer">') : home.replace('</body>', section + '\n</body>');
    await writeChanged(homeFile, home);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const manifest = { count: listings.length, listings: listings.map(({ id, slug, url, imageUrls, categoryKey }) => ({ id, slug, url, images: imageUrls, categoryKey })), indexes, retired: [...retired.values()].map(({ id, slug, url }) => ({ id, slug, url })) };
  await writeChanged(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Generated ${listings.length} listing pages and ${indexes.length} paginated indexes; ${retired.size} unavailable listings excluded.`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generate();
