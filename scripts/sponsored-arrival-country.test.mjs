import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const context = { console, document: {}, navigator: {}, window: {}, Date, Map, Set, URL, URLSearchParams };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
const app = Object.create(context.App.prototype);
app.isShortTermHostPosting = () => false;
const fields = {
  'item-category': { value: 'electronics' },
  'item-country': { value: 'Canada' },
  'item-city': { value: 'Toronto' },
  'item-sponsored-arrival': { checked: false, setAttribute() {} },
  'item-sponsored-arrival-details': { hidden: true },
  'item-destination-country': { value: 'Guyana' },
  'item-transit-status': { value: 'in_transit' },
  'item-expected-arrival': { value: '2026-11-01' },
  'item-target-country': { value: 'Ghana' },
  'item-placement': { value: 'market' },
  'item-featured': { checked: false }
};
context.document.getElementById = id => fields[id] || null;
app.syncCrossBorderSponsoredFields('item-target-country');
if (fields['item-destination-country'].value !== 'Guyana'
  || fields['item-target-country'].value !== 'Ghana'
  || fields['item-featured'].checked || fields['item-placement'].value !== 'market') {
  throw new Error('Choosing a promotion country must not change shipping or enable a paid promotion.');
}
if (!fields['item-sponsored-arrival-details'].hidden || !fields['item-destination-country'].disabled
  || fields['item-destination-country'].required || fields['item-transit-status'].required) {
  throw new Error('Sponsored arrival fields must be inactive until the seller checks the box.');
}
let target = app.getPostItemPromotionTarget();
if (target.country !== 'Ghana' || target.city !== '') {
  throw new Error('Promotion in Ghana must not inherit the seller’s Toronto city.');
}
fields['item-sponsored-arrival'].checked = true;
app.syncCrossBorderSponsoredFields('item-sponsored-arrival');
if (fields['item-sponsored-arrival-details'].hidden || fields['item-destination-country'].disabled
  || !fields['item-destination-country'].required || !fields['item-transit-status'].required) {
  throw new Error('Checking sponsored arrival must reveal and require destination and shipping status.');
}
if (app.getPostItemPromotionTarget().country !== 'Ghana') {
  throw new Error('A seller’s explicit promotion country must take priority over the shipping destination.');
}
fields['item-target-country'].value = '';
target = app.getPostItemPromotionTarget();
if (target.country !== 'Guyana' || target.city !== '') {
  throw new Error('Sponsored arrivals without an explicit promotion country must default to their destination country.');
}
fields['item-sponsored-arrival'].checked = false;
app.syncCrossBorderSponsoredFields('item-sponsored-arrival');
if (app.getPostItemPromotionTarget().country !== 'Canada' || !fields['item-expected-arrival'].disabled) {
  throw new Error('Disabling a sponsored arrival must ignore retained shipping values and restore listing-country targeting.');
}
fields['item-target-city'] = { value: 'Accra' };
fields['item-target-country'].value = 'Ghana';
if (app.getPostItemPromotionTarget().city !== 'Accra') {
  throw new Error('The seller’s explicit target city must be preserved.');
}

console.log('Universal cross-border sponsored test passed: explicit opt-in, independent country targeting, transit display, and offers.');
