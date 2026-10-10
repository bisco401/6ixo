import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryChapters, homeCategoryLinks, homeCountryLinks, categoryRoutes } from './lib/category-chapters.mjs';

const fixture = `<!DOCTYPE html><html><head><title>Electronics | 6ixo</title><link rel="canonical" href="https://6ixo.com/electronics/"><script type="application/ld+json">{"@type":"CollectionPage"}</script></head><body><main id="main"><section class="hero"><div><h1>Electronics</h1><p>Compare devices.</p><a href="/#electronics">Browse</a></div><aside class="hero-panel"><p>Check the model.</p></aside></section><section class="section tint"><h2>Buying guide</h2><section><h3>Nested checklist</h3><a href="/phones-for-sale/">Phones</a></section></section><section class="section safety"><h2>Verify ownership</h2><p>Check account locks.</p></section><!-- CURRENT INVENTORY: START --><section class="section"><h2>Current devices</h2><article class="listing-index-card"><a href="/listing/real-device/"><img src="/data/device.jpg" alt="Real device"><h3>Real device</h3></a></article></section><script type="application/ld+json">{"@type":"ItemList","numberOfItems":1}</script><!-- CURRENT INVENTORY: END --></main></body></html>`;

test('category layout preserves nested guides, genuine inventory links and metadata without requiring JavaScript', () => {
  const html = categoryChapters(fixture, 'electronics', 'Electronics');
  assert.ok(html.includes('<h1>Electronics</h1>'));
  assert.ok(html.includes('href="https://6ixo.com/electronics/"'));
  assert.ok(html.includes('{"@type":"CollectionPage"}'));
  const listings = html.split('<!-- CHAPTER LISTINGS: START -->')[1].split('<!-- CHAPTER LISTINGS: END -->')[0];
  const guide = html.split('<!-- CHAPTER GUIDE: START -->')[1].split('<!-- CHAPTER GUIDE: END -->')[0];
  const safety = html.split('<!-- CHAPTER SAFETY: START -->')[1].split('<!-- CHAPTER SAFETY: END -->')[0];
  assert.ok(listings.includes('href="/listing/real-device/"'));
  assert.ok(listings.includes('"numberOfItems":1'));
  assert.ok(guide.includes('Nested checklist'));
  assert.ok(guide.includes('href="/phones-for-sale/"'));
  assert.ok(guide.includes('Check the model.'));
  assert.ok(safety.includes('Check account locks.'));
  assert.ok(!html.includes(' hidden'));
  assert.equal(categoryChapters(html, 'electronics', 'Electronics'), html);
});

test('an inventory refresh replaces old ads without duplicating or losing the guide chapters', () => {
  let html = categoryChapters(fixture, 'electronics', 'Electronics');
  html = html.replace(/<!-- CURRENT INVENTORY: START -->[\s\S]*?<!-- CURRENT INVENTORY: END -->/, '');
  html = html.replace('</main>', '<!-- CURRENT INVENTORY: START --><section><a href="/listing/new-device/">New device</a></section><!-- CURRENT INVENTORY: END --></main>');
  html = categoryChapters(html, 'electronics', 'Electronics');
  assert.ok(!html.includes('/listing/real-device/'));
  assert.equal(html.split('/listing/new-device/').length - 1, 1);
  assert.equal(html.split('Nested checklist').length - 1, 1);
  assert.equal(html.split('Check account locks.').length - 1, 1);
  assert.equal(categoryChapters(html, 'electronics', 'Electronics'), html);
});

test('categories without a public static inventory offer their working marketplace route', () => {
  const empty = fixture.replace(/<!-- CURRENT INVENTORY: START -->[\s\S]*?<!-- CURRENT INVENTORY: END -->/, '');
  const html = categoryChapters(empty, 'electronics', 'Electronics');
  assert.ok(html.includes('href="/#electronics">Open marketplace'));
  assert.ok(!html.includes('class="listing-index-card"'));
  assert.equal(categoryChapters(html, 'electronics', 'Electronics'), html);
});

test('the closed footer exposes every category through ordinary HTML links', () => {
  const html = homeCategoryLinks();
  assert.ok(html.startsWith('<details class="home-seo-hub">'));
  assert.ok(!html.includes(' open'));
  for (const [slug] of categoryRoutes) assert.ok(html.includes(`href="/${slug}/"`), slug);
});

test('country links and actual inventory counts stay inside the same collapsed footer', () => {
  const countries = homeCountryLinks([{country:'Canada',base:'/listings/country/canada/',items:[{},{}]}]);
  const html = homeCategoryLinks(countries);
  assert.ok(html.includes('href="/listings/country/canada/"'));
  assert.ok(html.includes('2 listings'));
  assert.equal(html.split('class="home-seo-hub"').length - 1,1);
  assert.ok(html.indexOf('Marketplace countries') < html.indexOf('</details>'));
});

test('paginated inventory keeps its filters, count and next-page link in the listing chapter', () => {
  const source = '<html><head></head><body><main><section class="listing-index-hero"><h1>Phones for sale</h1></section><nav class="listing-filters"><a href="/phones-for-sale/canada/">Canada</a></nav><p>Showing 1–36 of 50 listings.</p><section id="current-listings" class="listing-index-grid"><article>Phone</article></section><nav class="listing-pagination"><a href="/phones-for-sale/page/2/">Next</a></nav><section class="section"><h2>Buying a phone</h2></section></main></body></html>';
  const html = categoryChapters(source, 'phones-for-sale', 'Phones for sale');
  const listings = html.split('<!-- CHAPTER LISTINGS: START -->')[1].split('<!-- CHAPTER LISTINGS: END -->')[0];
  assert.ok(listings.includes('href="/phones-for-sale/canada/"'));
  assert.ok(listings.includes('Showing 1–36 of 50 listings.'));
  assert.ok(listings.includes('href="/phones-for-sale/page/2/"'));
  assert.ok(!html.includes('<details class="chapter-filters" open'));
  assert.equal(categoryChapters(html, 'phones-for-sale', 'Phones for sale'), html);
});
