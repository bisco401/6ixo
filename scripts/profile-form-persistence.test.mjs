import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(process.env.AUDIT_PROFILE_SOURCE || new URL('../app.js',import.meta.url),'utf8');
function fixture(){
 const fields={'profile-account-name':'Audit Private','profile-private-name':'Audit Private','profile-public-name':'AuditPublic','profile-bio':'Saved biography','profile-country':'Ghana','profile-region':'Greater Accra','profile-city':'Accra','profile-email':'','profile-phone':'','profile-map-visible':false,'profile-name':'','profile-age':'','profile-photo':''};
 const elements=Object.fromEntries(Object.entries(fields).map(([id,value])=>[id,{value,textContent:'',checked:value===true,classList:{add(){},remove(){},toggle(){}},focus(){}}]));
 const context={console:{warn(){},error(){},log(){}},Date,URL,URLSearchParams,Set,Map,window:{},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}}};
 vm.runInNewContext(source.slice(0,source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
 const writes=[],notices=[];
 const user={id:'10000000-0000-4000-8000-000000000001',email:'audit@example.test',firstName:'Audit',lastName:'Private',age:25,interests:[],photos:[],marketplacePhotos:[],location:{city:'Toronto',region:'Ontario',country:'Canada',distance:0},marketplaceUsername:'AuditPublic'};
 const app=Object.assign(Object.create(context.App.prototype),{isSignedIn:true,currentUser:user,userPreferences:{},showNotification:message=>notices.push(message),ensureProfileUsernames(){},requireSignedIn:()=>true,persistMarketplaceProfilePhotos:async()=>{},saveUserPreferences(){},updateMapMarkers(){},getMarketplaceProfilePhoto:()=>'',getAccountSignupName:()=> 'Audit Private',getMarketplaceUsername:()=> 'AuditPublic',getMarketplaceUsernameHandle:()=> 'AuditPublic',getMarketplaceProfileBio:()=> 'Saved biography',syncProfileViewerNamePreview(){}});
 const q={select(){return q;},maybeSingle:async()=>({data:{id:'public-profile',public_id:'mp_test'}})};
 app.supabase={auth:{getUser:async()=>({data:{user:{id:user.id,user_metadata:{first_name:'Audit',last_name:'Private',full_name:'Audit Private'}}}}),updateUser:async()=>({error:null})},from:table=>({upsert(row){writes.push({table,row});return table==='marketplace_profiles'?q:Promise.resolve({error:null});}})};
 for(const name of ['loadInterests','renderPhotoSlot','syncCompanionshipMyPosts','renderMyPosts','renderMyAuctions','renderMarketplaceConversations','renderGuestBookingsDashboard','renderHostBookingsDashboard','renderHostRentalListings','renderProfileArriveTrips','applySellerProUiState'])app[name]=()=>{};
 for(const name of ['canViewMarketplaceConversations','canViewGuestBookings','canViewHostBookings'])app[name]=()=>false;
 for(const name of ['refreshHostPayoutStatus','refreshSellerProSubscriptionState','loadAdvertiserDashboard'])app[name]=async()=>{};
 return {app,elements,writes,notices};
}
test('profile save persists edited country, region and city in both account and seller records',async()=>{
 const {app,writes,notices}=fixture();await app.saveProfile();
 assert.ok(notices.includes('Profile saved successfully!'));
 for(const table of ['profiles','marketplace_profiles']){
  const row=writes.find(w=>w.table===table)?.row;assert.ok(row);
  assert.equal(row.country,'Ghana');assert.equal(row.region,'Greater Accra');assert.equal(row.city,'Accra');
 }
});
test('opening profile restores the account email and saved country, region and city',()=>{
 const {app,elements}=fixture();app.loadUserProfile();
 assert.equal(elements['profile-email'].value,'audit@example.test');assert.equal(elements['profile-country'].value,'Canada');assert.equal(elements['profile-region'].value,'Ontario');assert.equal(elements['profile-city'].value,'Toronto');
});
test('a guest profile never displays null years old',()=>{
 const {app,elements}=fixture();app.isSignedIn=false;app.currentUser.age=null;app.loadUserProfile();assert.doesNotMatch(elements['profile-age'].textContent,/null|undefined/);
});

test('public seller contact and interests require explicit choices and can be removed', async () => {
  const { app, elements, writes } = fixture();
  elements['profile-phone'].value = '+1 416 555 0100';
  elements['profile-public-phone'] = { value: '+1 416 555 0111' };
  elements['profile-public-interests'] = { checked: true };
  app.currentUser.interests = ['Gardening'];
  await app.saveProfile();
  const [publicWrite, privateWrite] = writes;
  assert.equal(publicWrite.row.public_phone, '+1 416 555 0111');
  assert.deepEqual(Array.from(publicWrite.row.public_interests), ['Gardening']);
  assert.equal(publicWrite.row.phone, undefined);
  assert.equal(publicWrite.row.full_name, undefined);
  assert.equal(privateWrite.row.phone, '+1 416 555 0100');
  assert.equal(app.currentUser.location.city, 'Toronto');
  elements['profile-public-phone'].value = '';
  elements['profile-public-interests'].checked = false;
  await app.saveProfile();
  assert.equal(writes[2].row.public_phone, null);
  assert.equal(writes[2].row.public_interests, null);
});

test('a viewer receives the saved seller identity without replacing the ad location or description', () => {
  const { app } = fixture();
  const publicProfile = {
    display_name: 'Updated seller', city: 'Ottawa', country: 'Canada', bio: 'Updated profile bio',
    photo_urls: ['https://example.test/profile.jpg'], profile_video_url: 'https://example.test/profile.mp4'
  };
  const listing = app.normalizeSupabaseMarketplaceListingRow({
    id: 'listing-1', user_id: 'seller-account', city: 'Toronto', description: 'Ad description',
    listing_payload: { seller: 'Old seller', sellerUserId: 'forged-owner' }
  }, publicProfile);
  const card = app.applyPublicSellerProfile({ name: 'Old seller' }, listing.sellerProfile);
  assert.equal(listing.sellerUserId, 'seller-account');
  assert.equal(listing.seller, 'Updated seller');
  assert.equal(listing.city, 'Toronto');
  assert.equal(listing.description, 'Ad description');
  assert.equal(card.name, 'Updated seller');
  assert.equal(card.location, 'Ottawa, Canada');
  assert.equal(card.bio, 'Updated profile bio');
  assert.equal(card.photo, 'https://example.test/profile.jpg');
  assert.equal(card.profileVideo, 'https://example.test/profile.mp4');
});
