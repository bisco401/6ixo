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
