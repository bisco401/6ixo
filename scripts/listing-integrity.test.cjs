const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const integrity = require('./lib/listing-integrity.cjs');
const url = 'https://www.kijiji.ca/v-clothing-men/hamilton/leather-jacket/123456';
const own = 'https://media.kijiji.ca/api/v1/images/jacket?rule=kijijica-640-webp';
const unrelated = 'https://media.kijiji.ca/api/v1/images/car-mat?rule=kijijica-640-webp';
const html = `<img src="${unrelated}"><script type="application/ld+json">${JSON.stringify({'@type':'ItemList',itemListElement:[{item:{'@type':'Product',name:'Car mat',image:unrelated}}]})}</script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{__APOLLO_STATE__:{other:{__typename:'StandardListing',id:'999',imageUrls:[unrelated]},own:{__typename:'StandardListing',id:'123456',url,title:'Leather Jacket',imageUrls:[own,own]}}}}})}</script>`;
assert.deepEqual(integrity.extract(html,{source_url:url}).images,[own.replace('640','1600')]);
assert.equal(integrity.extract(html,{source_url:url.replace('123456','444')}).matched,false,'A different listing may not borrow this gallery');
const results=[{url:'https://www.kijiji.ca/v-other/x/mats/999',html:'mats'},{url,html:'jacket'}];
assert.equal(integrity.matchCrawlResult(results,url).html,'jacket','Crawler completion order must not decide ownership');
assert.equal(integrity.matchCrawlResult([{html:'no URL'}],url),null,'URL-less results must not be assigned by position');
const product = (name,u,image) => ({'@type':'Product',name,url:u,image});
const ld = `<script type="application/ld+json">${JSON.stringify({'@graph':[product('Other','https://example.com/other',unrelated),product('Own','https://example.com/own',own)]})}</script>`;
assert.deepEqual(integrity.extract(ld,{source_url:'https://example.com/own'}).images,[own.replace('640','1600')]);
assert.deepEqual(integrity.extract(`<img src="${own}">`,{source_url:url}).images,[],'A page-wide image search must never become a gallery');
const cases = [
 ['clothing-men',"Men's Leather Jacket For Sale",'clothing','men'],
 ['jewelry-watch','GOLD, SILVER, PLATINUM & GIFT CARD BUYERS (905) 385-4653','services','financial'],
 ['washer-dryer','Dryer, pickup available, call my phone','other','appliances'],
 ['toys-games','Hot Wheels Star Wars Transporter','other','baby_kids'],
 ['cars-trucks','BMW with alloy wheels, camera and new transmission','vehicles','vehicles'],
 ['short-term-rental','Room for rent','real_estate','for_rent_short'],
 ['house-for-sale','House with rental income','real_estate','for_sale'],
 ['renovation-contracting-handyman','Permit Drawings P.Eng, BCIN, HVAC','services','skilled_trades'],
 ['cleaners-cleaning-service','J.L.A MOTORCYCLE DETAILING','vehicles','detailing'],
 ['other-auto-parts-and-accessories','CASH 4 CARS SCRAP CAR REMOVAL','services','other'],
 ['speakers-headsets-mics','NEW JBL FLIP 5','electronics','audio_headphones']
];
for (const [slug,title,category,sub] of cases) {
 const result=integrity.classify({source_url:`https://www.kijiji.ca/v-${slug}/hamilton/item/123`,title,description:'Call phone. Delivery, pickup, wheels and repair available.',app_category:'electronics'});
 assert.equal(result.app_category,category,title);assert.equal(result.app_subcategory,sub,title);
}
const source=fs.readFileSync('app.js','utf8');
const context={console,Date,Map,Set,URL,URLSearchParams,window:{location:{href:'https://6ixo.com/'}},document:{},navigator:{}};
vm.runInNewContext(`${source.slice(0,source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App=DatingApp;`,context);
const app=Object.create(context.App.prototype);
const row={id:'123456',status:'published',source_url:url,title:'Leather Jacket',app_category:'electronics',app_subcategory:'other',phone:'9051234567',image_urls:unrelated};
app.scrapedListingIntegrityRepairs={[integrity.key(url)]:{title:row.title,images:[own],checkedAt:'2026-09-06T00:00:00Z'}};
const normalized=app.normalizeCsvScrapedListingRow(row);
assert.equal(normalized.item.category,'clothing');
assert.equal(normalized.item.images[0],own.replace('640','1600'));
assert.equal(app.buildMarketplaceItemGallery(normalized.item).gallery[0].src,normalized.item.images[0]);
const svc=app.normalizeCsvScrapedListingRow({...row,source_url:'https://www.kijiji.ca/v-jewelry-watch/hamilton/buyers/555',title:'GOLD & SILVER BUYERS'});
assert.equal(svc.item.category,'services');
assert.equal(app.buildServiceProfileEntryFromMarketplaceItem(svc.item).category,'financial');
console.log('Listing integrity tests passed: gallery ownership, reordered batches, categories, profiles and detail galleries.');

assert.equal(app.inferMarketplaceFeedBadgeType(svc.item),'service','A buyer service without an asking price must not be labelled Free');
assert.equal(app.inferMarketplaceFeedBadgeType({...normalized.item,price:100,description:'Free delivery available'}),'sale');
