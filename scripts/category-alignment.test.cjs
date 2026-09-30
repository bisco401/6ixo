const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseCsv } = require('./listing-sync-policy.cjs');
const integrity = require('./lib/listing-integrity.cjs');
const source = fs.readFileSync('app.js', 'utf8');
const context = { console, Date, Map, Set, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, navigator: {} };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const makeApp = () => {
  const app = Object.create(context.App.prototype);
  app.scrapedListingIntegrityRepairs = JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json', 'utf8')).listings;
  return app;
};
const app = makeApp();
const cases = [
  ['mens-shoes', "New Men's Sz 11 Jordan 4 A Ma Maniére Shoes $460", 'clothing', 'shoes'],
  ['womens-shoes', 'Leather ankle boots', 'clothing', 'shoes'],
  ['kids-shoes', 'Toddler sandals', 'clothing', 'shoes'],
  ['buy-sell-other', 'adidas Samba XLG Night Indigo Warm Vanilla', 'clothing', 'shoes'],
  ['buy-sell-other', 'BRAVADO! Ballet FULL CUP Plunge Crossover Bra', 'clothing', 'other'],
  ['buy-sell-other', 'Kia Sportage 2020-2022 Bumper Rear Primed', 'vehicles', 'auto_parts'],
  ['sport-touring', '2003 Suzuki V-Strom DL1000', 'vehicles', 'vehicles'],
  ['sport-bikes', 'Cortech tail bag', 'vehicles', 'auto_parts'],
  ['processor-blender-juicer', 'Ninja CREAMi Ice Cream Maker', 'other', 'appliances'],
  ['textbooks', 'The Geometrical Optics Workbook', 'other', 'hobbies_collectibles'],
  ['buy-sell-other', 'Omcan Commercial Portable Heat Lamp', 'other', 'tools_equipment'],
  ['buy-sell-other', 'DJI Osmo Mobile SE 3-Axis Phone Gimbal', 'electronics', 'cameras_photography'],
  ['nintendo-switch', 'Nintendo Switch console', 'electronics', 'gaming_consoles'],
  ['sony-psp', 'PS Vita Battery Repair - $60 Installed', 'services', 'other'],
  ['other-furniture', 'piano removal', 'services', 'home_services'],
  ['cell-phone', 'Sell Your Used Phone Fast', 'services', 'other'],
  ['construction-trades-jobs', 'FRAMING CARPENTER', 'jobs', 'other'],
  ['classes-lessons', 'Math tutoring lessons', 'community', 'classes_lessons'],
  ['room-rental-roommate', 'Room for rent', 'real_estate', 'for_rent_long'],
  ['cars-trucks', 'Toyota sedan', 'vehicles', 'vehicles'],
  ['buy-sell-other', 'Shoe storage rack', 'other', 'miscellaneous']
];
for (const [slug, title, category, subcategory] of cases) {
  const row = { id: `test-${slug}-${title}`, url: `https://www.kijiji.ca/v-${slug}/toronto/item/1234567`, title,
    phone_numbers: '4165550123', image_urls: 'https://example.com/listing.jpg', city: 'Toronto', price: '$100',
    description: 'Delivery available. We also have shoes, cars, phones, and furniture.' };
  const result = app.normalizeKijijiGtaRow(row);
  assert.ok(result, title);
  assert.equal(result.isVehicle, category === 'vehicles', title);
  assert.equal(result.item.category, category === 'vehicles' ? subcategory : category, title);
  if (!result.isVehicle) assert.equal(result.item.subcategory, subcategory, title);
  if (category === 'services') assert.ok(app.buildServiceProfileEntryFromMarketplaceItem(result.item), title);
  if (category === 'real_estate') assert.ok(app.buildRealestateFeedEntryFromMarketplaceItem(result.item), title);
  if (category === 'clothing' && subcategory === 'shoes') {
    assert.ok(app.matchesClothingChip(result.item, 'shoes'), title);
    assert.match(app.getMarketplaceImageCategoryLabel(result.item), /Shoes|Sneakers/);
  }
}
assert.equal(integrity.classify({url:'https://www.kijiji.ca/v-new-provider-shoe-category/toronto/item/1', title:'Product', app_category:'clothing', app_subcategory:'shoes'}).app_category, 'clothing');
assert.equal(integrity.classify({title:'Blank cotton mens T-shirt', app_category:'clothing', app_subcategory:'men'}).app_subcategory, 'men');
const fashionCases = [
  [{title:'Nike cotton T-shirt', subcategory:'men'}, 'streetwear', false],
  [{title:'Adidas backpack', subcategory:'accessories'}, 'accessories', false],
  [{title:'Leather boots', subcategory:'shoes'}, 'shoes', true],
  [{title:'Jordan 4', subcategory:'shoes'}, 'sneakers', true],
  [{title:'Pendant', subcategory:'accessories', fashion:{styleChip:'all'}}, 'accessories', false]
];
for (const [item, type, isShoe] of fashionCases) {
  item.category = 'clothing';
  assert.equal(app.getClothingItemType(item), type, item.title);
  assert.equal(app.matchesClothingChip(item, 'shoes'), isShoe, item.title);
  assert.ok(app.matchesClothingChip(item, type), item.title);
  assert.ok(app.getMarketplaceCategoryBadges(item).includes(app.inferMarketplaceClothingLabel(item)), item.title);
}
assert.equal(app.matchesClothingAudience({title:"Women's boots"}, 'men'), false);
assert.equal(app.matchesClothingAudience({title:"Women's boots"}, 'women'), true);
assert.equal(app.matchesClothingChip({title:'Leather bags'}, 'kids'), false);
assert.equal(app.matchesClothingAudience({title:'Kids sneakers', subcategory:'kids'}, 'kids'), true);
assert.equal(app.matchesClothingAudience({title:'Unisex sneakers'}, 'women'), true);

// Audit every public record through the same normalization used by Home.
let checked = 0;
for (const file of fs.readdirSync('data').filter(file => file.endsWith('.csv'))) {
  for (const row of parseCsv(fs.readFileSync(`data/${file}`, 'utf8')).rows) {
    if ((row.status || 'published') !== 'published') continue;
    const method = file === 'kijiji-gta-recent-with-phones.csv' ? 'normalizeKijijiGtaRow'
      : file.startsWith('oxglow-auto-') ? 'normalizeOxglowAutoPartsRow'
      : file.startsWith('oxglow-electronics-') ? 'normalizeOxglowElectronicsRow'
      : file.startsWith('oxglow-real-estate-') ? 'normalizeOxglowRealestateRow' : 'normalizeCsvScrapedListingRow';
    const result = app[method](row);
    assert.ok(result, `${file}: ${row.title}`);
    const item = result.item || result;
    if (method === 'normalizeKijijiGtaRow' || method === 'normalizeCsvScrapedListingRow') {
      const route = integrity.classify(app.applyScrapedListingIntegrity({...row, source_url: row.source_url || row.url}));
      assert.equal(item.category, result.isVehicle ? route.app_subcategory : route.app_category, row.title);
      if (item.category === 'clothing') assert.ok(app.matchesClothingCategory(item, 'all') && app.matchesClothingChip(item, 'all'), row.title);
      if (item.category === 'services') assert.ok(app.buildServiceProfileEntryFromMarketplaceItem(item), row.title);
      if (item.category === 'real_estate') assert.ok(app.buildRealestateFeedEntryFromMarketplaceItem(item), row.title);
    }
    checked++;
  }
}

// Community cards must open the original listing, including all photos/contact.
app.communityPosts = [{id:'native-post', category:'events', title:'Local event'}];
const community = app.normalizeKijijiGtaRow({ id:'lesson', url:'https://www.kijiji.ca/v-classes-lessons/toronto/item/1234567', title:'Math lessons', phone_numbers:'4165550123', image_urls:'https://example.com/a.jpg|https://example.com/b.jpg', city:'Toronto' }).item;
app.marketplaceItems = [community, {id:2, category:'clothing', title:'Shoes'}];
const posts = app.getCommunityFeedPosts();
assert.equal(posts.length, 2);
assert.equal(posts[1].category, 'classes_lessons');
let opened;
app.openMarketplaceItemModal = item => { opened = item; };
app.openCommunityPostMarketplaceModal(posts[1].id);
assert.equal(opened, community);
assert.equal(opened.images.length, 2);
app.communityFilters = { country:'Canada', city:'Toronto' };
app.activeCommunityCategory = 'classes_lessons';
app.ensureLocationDistance = location => location;
app.updateCommunityFeedMeta = () => {};
app.renderCommunityPosts = filtered => { assert.equal(filtered.length, 1); assert.equal(filtered[0].marketplaceItemId, community.id); };
app.filterCommunityPosts();

// A late Kijiji response must repaint whichever matching category is open.
(async () => {
  context.document = { getElementById: () => null, querySelector: () => null, createElement: () => ({ innerHTML: '', get value() { return this.innerHTML; } }) };
  const csv = fs.readFileSync('data/kijiji-gta-recent-with-phones.csv', 'utf8');
  context.fetch = async () => ({ok:true, text: async () => csv});
  for (const [screen, method] of Object.entries({clothing:'applyClothingFilters', electronics:'applyElectronicsFilters', other:'applyOtherFilters', jobs:'applyJobsFilters', services:'renderServicesFeed', realestate:'renderRealestateFeed', vehicles:'renderVehiclesFeed', community:'filterCommunityPosts', home:'applyHomeFilters', marketplace:'applyMarketplaceFilters'})) {
    const view = makeApp();
    view.activeScreen = screen;
    view.loadScrapedListingIntegrityRepairs = async () => {};
    view.renderHomeTodayDeals = view.renderHomePersonalizedRows = view.renderMarketplaceSponsoredAds = () => {};
    view.getActiveRealestateCategory = () => 'all';
    let renders = 0;
    view[method] = () => { renders++; };
    const loaded = await view.loadKijijiGtaListings();
    assert.ok(loaded.length > 0, `${screen}: imported`);
    assert.equal(renders, 1, `${screen}: refreshed after response`);
    const jordan = view.marketplaceItems.find(item => /Jordan 4/.test(item.title));
    assert.equal(jordan.category, 'clothing');
    assert.ok(view.matchesClothingChip(jordan, 'shoes'));
    assert.equal(view.isClothingBiddingListing(jordan, {stockxMode:true}), false, 'Imported shoes keep their asking price');
    const bra = view.marketplaceItems.find(item => /Crossover Bra/.test(item.title));
    assert.equal(view.isClothingBiddingListing(bra), false, 'Make an offer does not create an auction');
  }
  console.log(`Category alignment passed: ${checked} public records, ${cases.length} routing cases, Fashion filters/profile labels, Community details, and 10 late-loading screens.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
