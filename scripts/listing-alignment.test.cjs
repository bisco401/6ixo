const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const integrity = require('./lib/listing-integrity.cjs');
const { parseCsv } = require('./listing-sync-policy.cjs');
const url = 'https://www.kijiji.ca/v-clothing-men/hamilton/mens-leather-jacket-for-sale/1744485688';
const jacket = 'https://media.kijiji.ca/api/v1/images/jacket?rule=kijijica-640-webp';
const windowPhoto = 'https://media.kijiji.ca/api/v1/images/fe86dfb2-511c-4ea9-848b-8671346f71fa?rule=kijijica-640-webp';
const row = { id: 'kijiji-1744485688', status: 'published', title: "Men's Leather Jacket For Sale", source_url: url, city: 'Hamilton', phone: '9057457366', image_urls: jacket, app_category: 'clothing', app_subcategory: 'men', scraped_at: '2026-10-07T08:00:00Z', attributes: '{}' };
const entity = { __typename: 'StandardListing', id: '1744485688', title: row.title, url, imageUrls: [jacket], location: { name: 'Hamilton' }, posterInfo: { posterId: 'seller-jacket', phoneNumber: '9057457366' }, description: 'Call 905-745-7366.', status: 'ACTIVE' };
const html = own => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: { related: { ...entity, id: '111', title: 'Related window', imageUrls: [windowPhoto] }, own } } } })}</script>`;
assert.equal(integrity.publicationIssue(row), 'source_identity_unverified', 'New imports wait for source evidence');
const verified = integrity.verifyRecord(row, html(entity), '2026-10-07T12:00:00Z');
assert.equal(verified.result.matched, true);
assert.equal(integrity.publicationIssue(verified.row), '');
assert.deepEqual(verified.result.images, [jacket.replace('640', '1600')]);
for (const other of [
  { ...entity, title: 'Aluminum window screen', imageUrls: [windowPhoto] },
  { ...entity, url: 'https://www.kijiji.ca/v-home-outdoor-other/edmonton/window-screen/1744485688' }
]) {
  const result = integrity.extract(html(other), row);
  assert.equal(result.matched, false, 'A matching numeric ID cannot override a different title or canonical URL');
  assert.equal(result.identityIssue, 'source_identity_mismatch');
  assert.deepEqual(result.images, []);
}
assert.equal(integrity.publicationIssue({ ...verified.row, image_urls: 'https://example.com/someone-elses-photo.jpg' }), 'foreign_gallery');
assert.equal(integrity.publicationIssue({ ...verified.row, phone: '4165551234' }), 'foreign_contact');
assert.equal(integrity.publicationIssue({ ...verified.row, city: 'Edmonton' }), 'foreign_location');
assert.equal(integrity.publicationIssue({ ...verified.row, attributes: JSON.stringify({ ...JSON.parse(verified.row.attributes), sellerId: 'another-seller' }) }), 'foreign_seller');
assert.equal(integrity.publicationIssue({ ...row, image_urls: windowPhoto }), 'reviewed_image_mismatch', 'The user-reviewed window must never return on a jacket relist');
const ctx = { console, Date, Map, Set, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, navigator: {} };
const appCode = fs.readFileSync('app.js', 'utf8');
vm.runInNewContext(appCode.slice(0, appCode.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', ctx);
const app = Object.create(ctx.App.prototype);
assert.equal(app.normalizeCsvScrapedListingRow(row), null);
assert.equal(app.normalizeCsvScrapedListingRow({ ...row, image_urls: windowPhoto }), null);
const good = app.normalizeCsvScrapedListingRow(verified.row).item;
assert.equal(good.category, 'clothing');
assert.equal(good.subcategory, 'men');
assert.equal(app.buildMarketplaceItemGallery(good).gallery[0].src, good.images[0]);
const repairs = JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json')).listings;
let checked = 0;
for (const file of fs.readdirSync('data').filter(v => v.endsWith('.csv'))) {
  for (const record of parseCsv(fs.readFileSync('data/' + file, 'utf8')).rows) {
    if ((record.status || 'published') !== 'published') continue;
    const repaired = integrity.applyRepair(record, repairs[integrity.key(integrity.sourceUrl(record))]);
    assert.equal(integrity.publicationIssue(repaired), '', `${file}: ${record.id || record.title}`);
    if (/kijiji\.ca\//.test(integrity.sourceUrl(record))) assert.ok(JSON.parse(repaired.attributes).listingIdentity, `${record.id}: public Kijiji requires evidence`);
    checked++;
  }
}
// The installed workflow cannot assign detail photos until the complete identity passes.
const workflow = JSON.parse(fs.readFileSync('automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json'));
const code = workflow.nodes.find(n => n.type === 'n8n-nodes-base.code').parameters.jsCode;
assert.ok(code.includes('ListingIntegrity.verifyRecord(row, detail.html, nowIso)'));
assert.ok(code.includes("row.status = 'pending'"));
console.log(`Listing alignment passed: ${checked} public rows, complete source identity, screenshot conflict, gallery/contact/seller/location binding and unverified import guards.`);
(async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const wrongDetail of [false, true]) {
    let published;
    const input = { githubToken: 'TEST_TOKEN', availabilityMaxRows: 10, sourcesJson: JSON.stringify([{ enabled: true, name: 'Hamilton', city: 'Hamilton', country: 'Canada', list_url: 'https://www.kijiji.ca/b-hamilton/l80014', max_listings: 10 }]), crawl4aiResult: { results: [{ url: 'https://www.kijiji.ca/b-hamilton/l80014', status_code: 200, html: html({ ...entity, price: { amount: 500, currency: 'CAD', type: 'FIXED' } }) }] } };
    const httpRequest = async request => {
      if (request.method === 'PUT') { published = Buffer.from(request.body.content, 'base64').toString('utf8'); return { statusCode: 200, body: {} }; }
      if (request.method === 'POST') return { statusCode: 200, body: { results: [{ url, status_code: 200, html: html(wrongDetail ? { ...entity, title: 'Window screen', imageUrls: [windowPhoto] } : { ...entity, price: { amount: 500, currency: 'CAD', type: 'FIXED' } }) }] } };
      return { statusCode: 200, body: { sha: 'test', encoding: 'base64', content: Buffer.from('id,status,source_url\n').toString('base64') } };
    };
    await new AsyncFunction('$input', code).call({ helpers: { httpRequest } }, { first: () => ({ json: input }) });
    const stored = parseCsv(published).rows[0];
    assert.ok(stored);
    if (wrongDetail) {
      assert.equal(stored.status, 'pending');
      assert.equal(stored.sync_visibility, 'source_identity_mismatch');
      assert.ok(!stored.image_urls.includes('fe86dfb2'), 'Mismatched source photos never merge into the ad');
    } else {
      assert.equal(stored.status, 'published');
      assert.equal(stored.price_value, '5', 'Kijiji cents must be divided by 100 even for low-price items');
      assert.equal(integrity.publicationIssue(stored), '');
      assert.ok(JSON.parse(stored.attributes).listingIdentity);
    }
  }
  console.log('n8n import behavior passed: complete identity required before publishing; low prices use cents correctly.');
})().catch(error => { console.error(error); process.exitCode = 1; });
