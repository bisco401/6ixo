import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const storage = new Map();
const context = vm.createContext({ console, URL, URLSearchParams, window: { localStorage: { setItem: (k,v)=>storage.set(k,v), getItem:k=>storage.get(k) }, SIXO_LOCATION_ENTRY:{ dismiss(){} } }, document: {getElementById:()=>null, querySelector:()=>null,querySelectorAll:()=>[]}, setTimeout, clearTimeout });
vm.runInContext(source.slice(source.indexOf('class DatingApp'), source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp',context);
const app = Object.create(context.App.prototype);
const score = (title, query, description='') => app.scoreHomeSearchMatch({title,raw:{}},query.split(' '),undefined,[description]);
test('Exact product terms do not fuzzy-match a different phone brand',()=>{
 assert.equal(score('Samsung Galaxy S26','iphone','Android phone, excellent condition').matched,false);
 assert.equal(score('iPhone 15 Pro','iphone').related,false);
 assert.equal(score('Samsung Watch8','iphone','Compatible with iPhone').related,true);
 assert.ok(score('iPhone 15 Pro','iphone').score>score('Samsung Watch8','iphone','Compatible with iPhone').score);
});
test('Every query word and model number must match; accessories are labelled separately',()=>{
 assert.equal(score('iPhone 14 Pro','iphone 15').matched,false);
 assert.equal(score('iPhone 15 Pro Max','iphone 15').matched,true);
 assert.equal(score('iPhone 15 case','iphone 15').related,true);
 assert.equal(score('iPhone 15 case','iphone 15 case').related,false);
 assert.equal(score('iPhone 160','iphone 16').matched,false);
 assert.equal(score('Blue sofa','blue sofa').related,false);
});
test('Imported attribution is clear and does not alter seller identity or Kijiji privacy',()=>{
 const item={seller:'Unknown',source:{type:'scraped_csv',site:'Gadget Craze'},description:'Samsung phone. Listed by Gadget Craze in Kampala.'};
 assert.equal(app.getListingSellerDisplayName(item),'Gadget Craze');
 assert.equal(app.getImportedListingSellerName(item),'Unknown');
 assert.equal(app.getListingSellerDisplayName({...item,source:{type:'scraped_csv',site:'Kijiji'}}),'External advertiser');
 assert.equal(app.getListingSellerDisplayName({...item,description:''}),'External advertiser');
 assert.equal(app.getListingReviewSummary(item),'Imported listing · confirm availability');
});
test('Source boilerplate is removed while listing information remains',()=>{
 app.decodeScrapedDescription=value=>value;
 const clean=app.cleanScrapedListingDescription('QR Code Link to This Post Spacious two bedroom apartment with balcony.\npost id: 12345');
 assert.doesNotMatch(clean,/QR Code|post id/i);
 assert.match(clean,/two bedroom apartment/);
});
test('Only deliberate browsing labels are persisted and restored',async()=>{
 let restored;
 app.applyManualDiscoveryLocation=area=>{restored=area};
 app.browseWorldwide=()=>{restored='worldwide'};
 app.rememberBrowsingLocation({mode:'manual',city:'Toronto',country:'Canada'});
 await app.restoreBrowsingLocation();assert.equal(restored.city,'Toronto');
 app.rememberBrowsingLocation({mode:'worldwide'});await app.restoreBrowsingLocation();assert.equal(restored,'worldwide');
 storage.set('sixo_browsing_area_v1','invalid');assert.doesNotThrow(()=>app.restoreBrowsingLocation());
 app.browseWorldwideSelected=true;assert.equal(app.getCurrentLocationDisplayText(),'');
});
test('Broad category searches stay primary without turning brands into synonyms',()=>{
 const result=app.scoreHomeSearchMatch({title:'Toyota Corolla',searchHints:['car','cars','vehicle'],raw:{}},['cars'],undefined,['vehicle','car']);
 assert.equal(result.matched,true);assert.equal(result.related,false);
 assert.equal(score('Blue laptop','laptops').matched,true);
});
