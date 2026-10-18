const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=fs.readFileSync('app.js','utf8'),ctx={console,Date,Map,Set,URL,URLSearchParams,window:{location:{href:'https://6ixo.com/'}},navigator:{}};
vm.runInNewContext(code.slice(0,code.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',ctx);
const app=Object.create(ctx.App.prototype);
function row(site,category,subcategory){
 const source=site==='Kijiji'?'https://www.kijiji.ca/v-cars-trucks/hamilton/source-fields/999000111':'https://oxglow.com.gh/'+category+'/source-fields';
 const images=['https://example.com/source-item.jpg'],phone=site==='Kijiji'?'+19055551234':'+233201234567';
 return {id:'source-fields',sku:'source-fields',status:'published',source_url:source,url:source,source_site:site,title:'Source item',country:site==='Kijiji'?'Canada':'Ghana',city:'Verified town',location:'Old town',phone,phone_numbers:phone,seller:'Verified seller',description:'Source details',price_text:'Contact for price',price_value:'',price:'9999',condition:'',app_category:category,app_subcategory:subcategory,target_surface:category==='vehicles'?'vehicles':category==='real_estate'?'realestate':'marketplace',year:'2021',make:'Toyota',model:'Corolla',mileage_km:'',image_urls:images.join('|'),attributes:JSON.stringify({listingIdentity:{sourceUrl:source,title:'Source item',images,phones:[phone],city:'Verified town',checkedAt:'2026-10-14T21:00:00Z'}})};
}
const k=row('Kijiji','vehicles','vehicles'),legacy=app.normalizeKijijiGtaRow(k).item,canonical=app.normalizeCsvScrapedListingRow(k).item;
for(const field of ['seller','city','condition','year','make','model','mileageKm','priceValue'])assert.equal(legacy[field],canonical[field],field);
assert.equal(legacy.seller,'Verified seller');assert.equal(legacy.condition,'');assert.equal(legacy.mileageKm,null);assert.equal(legacy.year,2021);assert.equal(legacy.sourceRowId,'kijiji-gta-source-fields');
for(const [method,category,sub] of [['normalizeOxglowElectronicsRow','electronics','other'],['normalizeOxglowRealestateRow','real_estate','for_sale'],['normalizeOxglowAutoPartsRow','vehicles','auto_parts']]){
 const r=row('Oxglow',category,sub),item=app[method](r),main=app.normalizeCsvScrapedListingRow(r).item;
 assert.ok(item,method);for(const field of ['seller','city','country','condition'])assert.equal(item[field],main[field],method+' '+field);
 assert.equal(item.city,'Verified town',method+' must use current source location');
 const gone={...r,status:'rejected',source_availability:'gone'};assert.equal(app[method](gone),null,method+' removal');
}
const wanted=row('Oxglow','services','other');wanted.title='Buying used car parts';wanted.attributes=JSON.stringify({...JSON.parse(wanted.attributes),listingIdentity:{...JSON.parse(wanted.attributes).listingIdentity,title:wanted.title}});wanted.target_surface='services';assert.equal(app.normalizeOxglowAutoPartsRow(wanted),null,'Buying service must not leak into parts inventory');
const raw={...k,phone:undefined,app_category:undefined,year:undefined,attributes:JSON.stringify(JSON.parse(k.attributes))};assert.equal(app.normalizeKijijiGtaRow(raw).item.condition,'','Missing condition stays unspecified in old imports');
const property=row('Oxglow','real_estate','for_sale');
for(const supplied of [null,'',0,2]){
 property.attributes=JSON.stringify({...JSON.parse(property.attributes),bedrooms:supplied,bathrooms:supplied});
 const item=app.normalizeOxglowRealestateRow(property),expected=supplied==null||supplied===''?null:supplied;
 assert.equal(item.realestate.bedrooms,expected,'Missing bedroom count must not become studio');assert.equal(item.realestate.bathrooms,expected,'Missing bathroom count stays unspecified');
}
const integrity=require('./lib/listing-integrity.cjs');
const reviewed=row('Kijiji','vehicles','vehicles');
const held=integrity.applyRepair({...reviewed,title:'Changed cached title'},{sourceUrl:reviewed.source_url,title:reviewed.title,holdReason:'source_identity_mismatch',reviewNote:'Keep source review hold'});
assert.equal(held.status,'rejected','A changed title must not escape the source review');assert.equal(held.sync_visibility,'source_identity_mismatch');
const cached=app.normalizeCsvScrapedListingRow(reviewed).item;
assert.equal(app.isImportedListingPublishable(cached),true);
app.scrapedListingIntegrityRepairs={[integrity.key(reviewed.source_url)]:{sourceUrl:reviewed.source_url,title:'Prior reviewed title',holdReason:'source_identity_mismatch'}};
assert.equal(app.isImportedListingPublishable(cached),false,'Cached profile/featured item must obey source review');
app.vehicleListings=[cached];app.marketplaceItems=[];app.realestateListings=[];app.serviceProfiles=[];app.deduplicateImportedListingFeeds();assert.equal(app.vehicleListings.length,0,'Periodic refresh removes a cached review-held vehicle');
const editedUrl=reviewed.source_url.replace('/source-fields/','/edited-source-title/');
const alias={...reviewed,source_url:editedUrl,url:editedUrl,title:'Edited source title',attributes:JSON.stringify({...JSON.parse(reviewed.attributes),listingIdentity:{...JSON.parse(reviewed.attributes).listingIdentity,sourceUrl:editedUrl,title:'Edited source title'}})};
const exactAliasRepair={sourceUrl:editedUrl,title:alias.title,images:['https://example.com/alias-own-photo.jpg']};
app.scrapedListingIntegrityRepairs={};
const cachedAlias=app.normalizeCsvScrapedListingRow(alias).item;
assert.ok(cachedAlias,'A separately verified source URL can initially publish');
app.scrapedListingIntegrityRepairs={[integrity.key(reviewed.source_url)]:{sourceUrl:reviewed.source_url,title:reviewed.title,holdReason:'source_identity_mismatch',images:['https://example.com/old-photo.jpg']},[integrity.key(editedUrl)]:exactAliasRepair};
const aliasRepair=integrity.resolveRepair(alias,app.scrapedListingIntegrityRepairs);
assert.equal(aliasRepair.holdReason,'source_identity_mismatch','Editing the source URL title cannot evade the ad ID review hold');
assert.deepEqual(aliasRepair.images,exactAliasRepair.images,'An alias hold must not copy another URL photo proof');
assert.equal(app.normalizeCsvScrapedListingRow(alias),null,'Fresh alias imports obey the existing review');
assert.equal(app.isImportedListingPublishable(cachedAlias),false,'Cached alias profile cards obey the existing review');
assert.equal(integrity.resolveRepair({source_url:editedUrl.replace('999000111','999000112')},app.scrapedListingIntegrityRepairs),undefined,'A different ad ID must not inherit another item review');
app.vehicleListings=[cachedAlias];app.deduplicateImportedListingFeeds();assert.equal(app.vehicleListings.length,0);
assert.equal(integrity.sourceIdentity('https://www.jacars.net/adv/123456_old-title/'),integrity.sourceIdentity('https://www.jacars.net/adv/123456_new-title/'));
assert.equal(integrity.sourceIdentity('https://www.craigslist.org/view/d/old-title/AbC123'),integrity.sourceIdentity('https://www.craigslist.org/view/d/new-title/AbC123'));
assert.notEqual(integrity.key(reviewed.source_url),integrity.key(editedUrl),'Exact source URL proof binding stays strict');
console.log('Legacy source fields passed: seller, location, vehicle facts, unknown condition/mileage, stable IDs, confirmed removals and buying-service routing.');
