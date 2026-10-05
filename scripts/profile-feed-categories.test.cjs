const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const integrity = require('./lib/listing-integrity.cjs');
const { parseCsv } = require('./listing-sync-policy.cjs');
const source = fs.readFileSync('app.js', 'utf8');
const context = { console, Date, Map, Set, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, navigator: {} };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
app.scrapedListingIntegrityRepairs = JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json', 'utf8')).listings;

// The screenshot's buyer businesses are services; actual jewelry remains Fashion.
const cases = [
  ['jewelry-watch', 'CASH FOR GOLD, SILVER, PLATINUM CALL (905) 547-4653', 'services', 'other'],
  ['jewelry-watch', 'GOLD, SILVER, PLATINUM & GIFT CARD BUYERS (905) 385-4653', 'services', 'other'],
  ['jewelry-watch', 'CASH 4 GOLD', 'services', 'other'],
  ['jewelry-watch', '14K Gold Band with Diamond', 'clothing', 'accessories'],
  ['financial-legal', 'PRIVATE MORTGAGE', 'services', 'financial'],
  ['general-electronics', 'Lenovo ideapad 1 14IAU7 720P HD Camera', 'electronics', 'computers_tablets'],
  ['general-electronics', 'Samsung Galaxy S22 Ultra 8GB RAM 128GB Storage', 'electronics', 'phones_accessories'],
  ['general-electronics', 'Sony Soundbar with wireless subwoofer', 'electronics', 'audio_headphones'],
  ['general-electronics', 'Home Theater Projector', 'electronics', 'tv_video_home_theatre'],
  ['general-electronics', 'GOOGLE PIXEL BUDS PRO 2', 'electronics', 'audio_headphones'],
  ['general-electronics', 'PS4 PRO for sale', 'electronics', 'gaming_consoles'],
  ['general-electronics', 'Washing Machine & Electric Dryer', 'other', 'appliances'],
  ['general-electronics', 'BYOD Mobile Plan $40', 'services', 'other'],
  ['other-pets', 'Beautiful puppies For Sale', 'other', 'pet_supplies'],
  ['horses-ponies', 'Belgian Broodmare', 'other', 'pet_supplies'],
  ['guitar', 'Electric Guitar and AMP', 'other', 'hobbies_collectibles'],
  ['storage-organization', 'Renovation work / Handyman & repairs', 'services', 'skilled_trades'],
  ['buy-sell-other', 'Tent rental and decor', 'services', 'events_services'],
  ['buy-sell-other', 'Commercial Meat Grinder', 'other', 'tools_equipment'],
  ['hobbies-craft', 'AI Vending Machine', 'other', 'tools_equipment'],
  ['plumbing-sink-toilet-shower', 'BEST PRICE APPLIANCE INSTALLATION', 'services', 'home_services'],
  ['health-special-needs', 'Hospital bed with air mattress', 'other', 'miscellaneous'],
  ['cars-trucks', 'Toyota sedan with camera, speakers and new tires', 'vehicles', 'vehicles'],
  ['house-for-sale', 'House for Sale with mortgage options', 'real_estate', 'for_sale']
];
for (const [slug, title, category, subcategory] of cases) {
  const row = { id: 'fixture', source_url: `https://www.kijiji.ca/v-${slug}/hamilton/item/1234567`,
    title, app_category: 'electronics', app_subcategory: 'other', status: 'published', phone: '9055550123',
    image_urls: 'https://example.com/own-photo.jpg', description: 'We also offer phones, bookkeeping, installation and pet products.' };
  const result = app.normalizeCsvScrapedListingRow(row);
  assert.ok(result, title);
  assert.equal(result.isVehicle, category === 'vehicles', title);
  assert.equal(result.item.category, result.isVehicle ? subcategory : category, title);
  if (!result.isVehicle) assert.equal(result.item.subcategory, subcategory, title);
  if (category === 'services') {
    assert.equal(result.item.service.category, subcategory, title);
    assert.equal(app.buildServiceProfileEntryFromMarketplaceItem(result.item).category, subcategory, title);
    assert.equal(app.getMarketplaceImageCategoryLabel(result.item), app.getServiceCategoryLabel(subcategory), title);
  }
}
assert.equal(app.resolveServiceCategoryKey({ category: 'services', subcategory: 'other', description: 'Tax included, installation available, pet-friendly shop.' }), 'other');
assert.equal(integrity.classify({ title: 'Room for rent', app_category: 'real_estate', app_subcategory: 'for_rent_short' }).app_subcategory, 'for_rent_short');

let checked = 0;
const publicProfiles = [];
for (const file of fs.readdirSync('data').filter(file => file.endsWith('.csv'))) {
  const method = file === 'kijiji-gta-recent-with-phones.csv' ? 'normalizeKijijiGtaRow'
    : file.startsWith('oxglow-auto-') ? 'normalizeOxglowAutoPartsRow'
    : file.startsWith('oxglow-electronics-') ? 'normalizeOxglowElectronicsRow'
    : file.startsWith('oxglow-real-estate-') ? 'normalizeOxglowRealestateRow' : 'normalizeCsvScrapedListingRow';
  for (const row of parseCsv(fs.readFileSync(`data/${file}`, 'utf8')).rows) {
    if ((row.status || 'published') !== 'published') continue;
    const normalized = app[method](row);
    assert.ok(normalized, `${file}: ${row.title}`);
    const item = normalized.item || normalized;
    if (item.category === 'services') {
      const profile = app.buildServiceProfileEntryFromMarketplaceItem(item);
      assert.equal(profile.category, item.subcategory, `${file}: ${row.title}`);
      assert.equal(app.getMarketplaceImageCategoryLabel(item), app.getServiceCategoryLabel(profile.category), row.title);
      publicProfiles.push(profile);
    }
    if (row.app_category) {
      const next = integrity.classify(row);
      assert.equal(next.app_category, row.app_category, `${file}: stable category ${row.title}`);
      assert.equal(next.app_subcategory, row.app_subcategory, `${file}: stable subcategory ${row.title}`);
    }
    checked++;
  }
}
assert.equal(publicProfiles.filter(profile => profile.category === 'financial' && /cash (?:for|4) gold|gold.*buyers/i.test(profile.title)).length, 0);
console.log(`Profile feed categories passed: ${checked} public records across all nine feed files, ${cases.length} placement cases, consistent service filters and profile badges.`);
