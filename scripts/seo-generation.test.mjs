import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generate, schemaEntity } from './generate-listing-seo-pages.mjs';
import { generateSitemap } from './generate-sitemap.mjs';
import { ORIGIN, parseCsv, crawlAllowed, httpUrl, jsonLd } from './lib/seo.mjs';
import { searchTopics, searchGroups, countryGroups } from './lib/marketplace-search.mjs';

test('specific searches distinguish rental apartments and mobile phones from other ads', () => {
  const apartment = searchTopics.find(t => t.slug === 'apartments-for-rent').matches;
  const property = { categoryKey: 'real-estate', app_subcategory: 'for_rent_long' };
  assert.ok(apartment({ ...property, title: '2 bedroom apartment for rent' }));
  assert.ok(apartment({ ...property, title: 'Condo with parking' }));
  assert.ok(!apartment({ ...property, title: 'Office in an apartment building' }));
  assert.ok(!apartment({ ...property, title: 'Private room in a shared apartment' }));
  assert.ok(!apartment({ ...property, app_subcategory: 'for_sale', title: 'Apartment for sale' }));
  assert.ok(!apartment({ ...property, app_subcategory: 'for_rent_short', title: 'Vacation apartment' }));
  const phone = searchTopics.find(t => t.slug === 'phones-for-sale').matches;
  for (const title of ['iPhone 13 Pro', 'Samsung Galaxy S22 Ultra', 'Motorola flip phone bundle', 'Red magic 11pro', 'CUBOT KINGKONG ES PRO', 'OUKITEL C17', 'POCO X8 PRO 5G']) assert.ok(phone({ categoryKey: 'electronics', title }), title);
  assert.ok(phone({categoryKey:'electronics', app_subcategory:'phones_accessories', title:'Samsung s26 ultra'}));
  for (const title of ['iPhone 18 Pro Max clear case', 'Samsung Galaxy Tab A8', 'iPhone screen repairs', 'Phone charger', 'Galaxy replacement battery', 'Google Pixel Buds Pro 2', 'Desktop Tripod Phone/Camera', 'OUKITEL pad tablet', 'POCO powerbank', 'Samsung TV']) assert.ok(!phone({ categoryKey: 'electronics', title }), title);
  assert.ok(!phone({ categoryKey: 'services', title: 'iPhone 13 Pro' }));
});

test('location searches contain matching ads and do not create empty country or city pages', () => {
  const listings = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `ca-${i}`, categoryKey: 'electronics', title: `iPhone ${i + 10}`, country: 'Canada', city: 'Toronto' })),
    { id: 'uk', categoryKey: 'electronics', title: 'iPhone 12', country: 'United Kingdom', city: 'London' },
    { id: 'case', categoryKey: 'electronics', title: 'iPhone case', country: 'Canada', city: 'Toronto' }
  ];
  const groups = searchGroups(listings);
  assert.equal(groups.find(g => g.base === '/phones-for-sale/').items.length, 6);
  assert.equal(groups.find(g => g.base === '/phones-for-sale/canada/toronto/').items.length, 5);
  assert.equal(groups.find(g => g.base === '/phones-for-sale/united-kingdom/').items.length, 1);
  assert.ok(!groups.some(g => g.base === '/phones-for-sale/united-kingdom/london/'));
  assert.ok(groups.find(g => g.base === '/phones-for-sale/canada/').links.some(([url]) => url === '/phones-for-sale/canada/toronto/'));
});

test('country pages use actual categories and distinguish events from event services', () => {
  const listings = [
    { id: 'car', categoryKey: 'vehicles', title: 'Toyota Corolla', country: 'Ghana' },
    { id: 'bike', categoryKey: 'vehicles', title: 'Honda motorbike', country: 'Ghana' },
    { id: 'bike-model', categoryKey: 'vehicles', title: 'Honda CL500', attributes: JSON.stringify({sourceSpecifications: [{label:'Body type',value:'Motorcycle'}]}), country: 'Ghana' },
    { id: 'phone', categoryKey: 'electronics', title: 'iPhone 13', country: 'Canada' },
    { id: 'laptop', categoryKey: 'electronics', title: 'Laptop', country: 'China' },
    { id: 'rental', categoryKey: 'real-estate', app_subcategory: 'for_rent', title: 'Apartment for rent', country: 'Guyana' },
    { id: 'event', categoryKey: 'community', app_subcategory: 'events', title: 'Neighbourhood market', country: 'Canada' },
    { id: 'tent', categoryKey: 'services', app_subcategory: 'events_services', title: 'Tent rentals', country: 'Jamaica' }
  ];
  const topics = searchGroups(listings);
  assert.deepEqual(topics.find(g => g.base === '/cars-for-sale/ghana/').items.map(l => l.id), ['car']);
  assert.equal(topics.find(g => g.base === '/events/canada/').items.length, 1);
  assert.ok(!topics.some(g => g.base === '/events/jamaica/'));
  assert.ok(!topics.some(g => g.base === '/cars-for-sale/' || g.base === '/events/'));
  const categories = [['vehicles', 'Cars for sale'], ['electronics', 'Electronics'], ['real-estate', 'Real estate'], ['community', 'Community'], ['services', 'Services']].map(([key, name]) => ({key, name, base: `/listings/${key}/`, items: listings.filter(l=>l.categoryKey===key)}));
  const countries = countryGroups(listings, categories, topics);
  assert.equal(countries.filter(g => g.countryHub).length, 5);
  const canada = countries.find(g => g.base === '/listings/country/canada/');
  assert.ok(canada.links.some(([url]) => url === '/phones-for-sale/canada/'));
  assert.ok(canada.links.some(([url]) => url === '/events/canada/'));
  assert.ok(!canada.links.some(([url]) => url.includes('ghana')));
  assert.ok(!countries.some(g => g.base === '/listings/country/ghana/vehicles/'));
  const china = countries.find(g => g.base === '/listings/country/china/electronics/');
  assert.deepEqual(china.items.map(l=>l.id), ['laptop']);
  assert.ok(!countries.some(g => g.base === '/listings/country/china/real-estate/'));
});

test('topic pages are crawlable and retired location pages stop allowing indexing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '6ixo-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'sitemap.xml'), '<urlset></urlset>');
  const columns = ['id', 'status', 'app_category', 'title', 'description', 'image_urls', 'city', 'country', 'source_url'];
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: `phone-${i}`, status: 'published', app_category: 'electronics', title: `iPhone ${i + 11}`, description: 'A mobile phone offered for sale with its original box and charging cable.', image_urls: 'https://example.com/phone.jpg', city: 'Dubai', country: 'United Arab Emirates', source_url: `https://example.com/phone/${i}` }));
  rows.push({ ...rows[0], id: 'laptop', title: 'Laptop for sale', source_url: 'https://example.com/laptop' });
  const writeFeed = async () => fs.writeFile(path.join(root, 'data/scraped-listings.csv'), columns.join(',') + '\n' + rows.map(r => columns.map(c => `"${String(r[c] || '').replaceAll('"', '""')}"`).join(',')).join('\n'));
  await writeFeed();
  const first = await generate(root);
  assert.ok(first.indexes.some(i => i.url === `${ORIGIN}/phones-for-sale/united-arab-emirates/dubai/`));
  const html = await fs.readFile(path.join(root, 'phones-for-sale/index.html'), 'utf8');
  assert.equal([...html.matchAll(/class="listing-index-card"/g)].length, 36);
  assert.ok(html.includes('href="/phones-for-sale/united-arab-emirates/"'));
  assert.ok(!html.includes('Laptop for sale'));
  const pageTwo = await fs.readFile(path.join(root, 'phones-for-sale/united-arab-emirates/dubai/page/2/index.html'), 'utf8');
  const pageThree = await fs.readFile(path.join(root, 'phones-for-sale/united-arab-emirates/dubai/page/3/index.html'), 'utf8');
  assert.notEqual(pageTwo.match(/<title>(.*?)<\/title>/)[1], pageThree.match(/<title>(.*?)<\/title>/)[1]);
  rows.slice(0, 80).forEach(r => { r.status = 'rejected'; });
  await writeFeed();
  const second = await generate(root);
  assert.ok(!second.indexes.some(i => i.url === `${ORIGIN}/phones-for-sale/united-arab-emirates/dubai/`));
  assert.ok((await fs.readFile(path.join(root, 'phones-for-sale/united-arab-emirates/dubai/index.html'), 'utf8')).includes('noindex, follow'));
  assert.ok((await fs.readFile(path.join(root, 'phones-for-sale/index.html'), 'utf8')).includes('No matching listings are published right now'));
});

test('CSV parser preserves quoted descriptions, commas, multiline text and escaped quotes', () => {
  assert.deepEqual(parseCsv('\uFEFFid,description\r\n1,"A, B\nHe said ""yes"""\r\n'), [{ id: '1', description: 'A, B\nHe said "yes"' }]);
});
test('photo crawl exceptions use longest matching robots rules', () => {
  const robots = 'User-agent: *\nAllow: /\nDisallow: /data/\nAllow: /data/*-images/\nDisallow: /*.csv$';
  assert.equal(crawlAllowed('/data/oxglow-listing-images/photo.jpg', robots), true);
  assert.equal(crawlAllowed('/data/pigiame-clean-images/photo.png', robots), true);
  assert.equal(crawlAllowed('/data/scraped-listings.csv', robots), false);
  assert.equal(crawlAllowed('/data/seo-page-state.json', robots), false);
  assert.equal(crawlAllowed('/index.html', robots), true);
});
test('untrusted input cannot add JSON-LD script tags or unsafe external URLs', () => {
  assert.equal(httpUrl('javascript:alert(1)'), '');
  assert.equal(httpUrl('https://user:pass@example.com/'), '');
  assert.ok(!jsonLd({ name: '</script><script>alert(1)</script>' }).includes('<'));
});
test('Product offers never invent stock, condition, or a price; services use Service', () => {
  const listing = { categoryKey: 'electronics', url: `${ORIGIN}/listing/test/`, title: 'Laptop', description: 'A laptop', imageUrls: [], details: [], currency: 'CAD', priceValue: null };
  assert.equal(schemaEntity(listing).offers, undefined);
  assert.equal(schemaEntity(listing).itemCondition, undefined);
  const offer = schemaEntity({ ...listing, priceValue: 25, source_availability: 'unknown' }).offers;
  assert.equal(offer.price, 25); assert.equal(offer.availability, undefined); assert.equal(offer.itemCondition, undefined);
  assert.equal(schemaEntity({ ...listing, categoryKey: 'services', priceValue: 25 })['@type'], 'Service');
  assert.equal(schemaEntity({ ...listing, categoryKey: 'jobs' })['@type'], 'Thing');
});
test('inventory builds paginate, deduplicate, preserve URLs, retire sold pages, and retain lastmod', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '6ixo-seo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'robots.txt'), 'User-agent: *\nAllow: /');
  const home = '<!DOCTYPE html><html lang="en"><head><link rel="canonical" href="https://6ixo.com/"><meta name="robots" content="index, follow"></head><body><a href="/listings/">Listings</a></body></html>';
  await fs.writeFile(path.join(root, 'index.html'), home);
  await fs.writeFile(path.join(root, 'sitemap.xml'), '<urlset><url><loc>https://6ixo.com/</loc><lastmod>2026-09-01</lastmod></url></urlset>');
  const headers = ['id', 'status', 'app_category', 'app_subcategory', 'title', 'description', 'image_urls', 'city', 'country', 'source_url', 'price_value', 'price_text', 'currency', 'source_availability', 'scraped_at'];
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `id-${i}`, status: 'published', app_category: 'electronics', title: `Laptop ${i}`, description: 'A complete description of this laptop and its useful features.', image_urls: 'https://example.com/photo.jpg', city: 'Toronto', country: 'Canada', source_url: `https://example.com/ad/${i}`, price_value: '2500', price_text: '$25', currency: 'CAD', source_availability: 'unknown', scraped_at: '2026-10-01' }));
  const writeFeed = async records => fs.writeFile(path.join(root, 'data/scraped-listings.csv'), headers.join(',') + '\n' + records.map(row => headers.map(h => `"${String(row[h] || '').replaceAll('"', '""')}"`).join(',')).join('\n'));
  await writeFeed([...rows, rows[0], { ...rows[1], id: 'duplicate-source' }, { ...rows[0], id: 'rejected', status: 'rejected' }, { ...rows[0], id: 'sold', source_availability: 'sold' }]);
  const first = await generate(root);
  assert.equal(first.count, 40);
  assert.ok(first.indexes.some(i => i.url === `${ORIGIN}/listings/page/2/`));
  const firstPage = await fs.readFile(path.join(root, 'listings/index.html'), 'utf8');
  assert.equal([...firstPage.matchAll(/class="listing-index-card"/g)].length, 36);
  assert.ok(firstPage.includes('href="/listings/page/2/"'));
  const firstListing = first.listings.find(l => l.id === 'id-0');
  const listingFile = path.join(root, 'listing', firstListing.slug, 'index.html');
  const listingHtml = await fs.readFile(listingFile, 'utf8');
  assert.ok(listingHtml.includes('"price":25'));
  assert.ok(!listingHtml.includes('InStock'));
  const firstState = await generateSitemap(root, new Date('2026-10-08T16:00:00Z'));
  const sitemapBefore = await fs.readFile(path.join(root, 'sitemap.xml'), 'utf8');
  const statBefore = await fs.stat(listingFile);
  await generate(root);
  await generateSitemap(root, new Date('2026-10-09T16:00:00Z'));
  assert.equal(await fs.readFile(path.join(root, 'sitemap.xml'), 'utf8'), sitemapBefore);
  assert.equal((await fs.stat(listingFile)).mtimeMs, statBefore.mtimeMs);
  assert.ok(sitemapBefore.includes('<image:loc>https://example.com/photo.jpg</image:loc>'));
  rows[0].title = 'A renamed laptop'; rows[1].source_availability = 'sold';
  await writeFeed(rows);
  const next = await generate(root);
  assert.equal(next.count, 39);
  assert.equal(next.listings.find(l => l.id === 'id-0').slug, firstListing.slug);
  assert.ok(next.retired.some(l => l.id === 'id-1'));
  const retiredFile = path.join(root, 'listing', first.listings.find(l => l.id === 'id-1').slug, 'index.html');
  assert.ok((await fs.readFile(retiredFile, 'utf8')).includes('noindex, follow'));
  const state = await generateSitemap(root, new Date('2026-10-09T16:00:00Z'));
  assert.equal(state[firstListing.url].lastmod, '2026-10-09');
  assert.equal(state[first.listings.find(l => l.id === 'id-1').url], undefined);
  assert.equal(state[`${ORIGIN}/`].lastmod, '2026-10-09'); // Country counts visible on home changed.
  assert.equal(state[`${ORIGIN}/apartments-for-rent/`].lastmod, firstState[`${ORIGIN}/apartments-for-rent/`].lastmod);
  await writeFeed([]);
  await assert.rejects(generate(root), /Refusing to retire every listing/);
});
