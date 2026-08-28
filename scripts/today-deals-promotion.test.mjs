import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const catalog = readFileSync(resolve(root, 'supabase/functions/_shared/monetization-catalog.ts'), 'utf8');
const migration = readFileSync(resolve(root, 'supabase/migrations/20260828123000_add_today_deals_promotion.sql'), 'utf8');
const classEnd = source.indexOf('// Initialize the app when the page loads');
if (classEnd < 0) throw new Error('Could not isolate DatingApp for the Today\'s Deals test.');

const context = {
  console,
  document: {},
  navigator: {},
  window: { location: { search: '', hash: '' } },
  Date,
  Map,
  Set,
  URL,
  URLSearchParams
};
vm.runInNewContext(`${source.slice(0, classEnd)}\nglobalThis.TestDatingApp = DatingApp;`, context);

const app = Object.create(context.TestDatingApp.prototype);
const now = new Date();
const oldDate = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));
const campaignEnd = new Date(now.getTime() + (24 * 60 * 60 * 1000));
app.currentUser = { location: {} };
app.getHomeNearMeTarget = () => ({});
app.adCampaigns = [{
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Paid deal campaign',
  placement: 'today_deals_featured',
  resource_id: 'paid-deal',
  starts_at: oldDate.toISOString(),
  ends_at: campaignEnd.toISOString()
}];
app.marketplaceItems = [
  { id: 'old-cheap', title: 'Old cheap listing', price: 25, postedDate: oldDate, tags: [] },
  { id: 'today-ordinary', title: 'Today ordinary listing', price: 900, postedDate: now, tags: [] },
  { id: 'today-sale', title: 'Today clearance sale', price: 300, postedDate: now, tags: ['sale'] },
  { id: 'paid-deal', title: 'Promoted deal', price: 500, postedDate: oldDate, tags: [] }
];

const deals = app.getHomeTodayDeals();
const ids = deals.map((entry) => entry.item.id);
if (ids[0] !== 'paid-deal') throw new Error(`Paid Today\'s Deals listing must rank first; received ${ids.join(', ')}.`);
if (!ids.includes('today-sale')) throw new Error('A deal-tagged listing posted today must appear organically.');
if (ids.includes('old-cheap')) throw new Error('An old cheap listing must not remain in Today\'s Deals indefinitely.');
if (ids.includes('today-ordinary')) throw new Error('A new listing without a deal signal must not be labelled a Today\'s Deal.');
if (deals[0].reasons[0] !== 'Sponsored deal') throw new Error('Paid deal cards must be clearly labelled Sponsored.');

if (!html.includes('id="home-today-deals-promote"')) throw new Error('Today\'s Deals seller CTA is missing.');
if (!html.includes('value="today_deals_featured"')) throw new Error('Today\'s Deals listing placement option is missing.');
if (!catalog.includes('today_deals_featured: 9.99')) throw new Error('Server-side Today\'s Deals pricing is missing.');
if (!catalog.includes('today_deals_featured: 168')) throw new Error('Server-side Today\'s Deals duration is missing.');
if (!source.includes("this.supabase.rpc('activate_paid_listing_promotion'")) throw new Error('Paid listing activation RPC is not wired into the client.');
if (!source.includes('deferConsumption: true')) throw new Error('Payment consumption must be deferred until listing activation.');
if (!source.includes('newItem.serverListingPublicId || newItem.publicId || newItem.id')) {
  throw new Error('The paid promotion must use the durable server listing ID.');
}
if (!migration.includes("when placement_value = 'today_deals_featured' then 'today_deals_featured'")) {
  throw new Error('Paid Today\'s Deals activation must persist the placement on the listing.');
}

console.log('Today\'s Deals promotion test passed: fresh organic deals and paid placements are functional.');
