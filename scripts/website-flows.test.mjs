import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(process.env.AUDIT_APP_SOURCE ? resolve(process.env.AUDIT_APP_SOURCE) : new URL('../app.js', import.meta.url), 'utf8');
const end = source.indexOf('// Initialize the app when the page loads');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(fields = {}) {
  const elements = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
    value, disabled: false, textContent: '', classList: { add() {}, remove() {}, toggle() {} }, focus() {},
  }]));
  const document = { title: 'Test', getElementById: id => elements[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const context = { console: { warn() {}, log() {}, error() {} }, document, window: { setTimeout, clearTimeout }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, URL, URLSearchParams, Date, Set, Map, Promise, setTimeout, clearTimeout };
  vm.runInNewContext(`${source.slice(0, end)}\nglobalThis.App = DatingApp;`, context);
  const notices = [];
  const app = Object.assign(Object.create(context.App.prototype), {
    isSignedIn: true, supabaseEnabled: true, currentUser: { id: 'account-a', email: 'a@example.test', interests: [], photos: [], marketplacePhotos: [] },
    messages: {}, userPreferences: {},
    showNotification(message, options) { notices.push({ message, options }); },
    ensureProfileUsernames() {}, requireSignedIn() { return this.isSignedIn; },
  });
  const event = { preventDefault() {}, currentTarget: { querySelector() { return null; }, reportValidity() { return true; } } };
  return { app, elements, event, context, notices };
}
const photo = (name = 'photo.jpg') => ({ name, type: 'image/jpeg', size: 1024 });
function storageMock({ failUpload = 0, failInsert = false, failPublicUrl = false } = {}) {
  const uploaded = [], removed = [], recordsRemoved = [];
  const bucket = {
    async upload(path, file) { uploaded.push({ path, file }); return { error: uploaded.length === failUpload ? new Error('Upload failed') : null }; },
    getPublicUrl(path) { return { data: { publicUrl: failPublicUrl ? '' : `https://test.supabase.co/storage/v1/object/public/profile-media/${path}` } }; },
    async remove(paths) { removed.push(...paths); return { error: null }; },
  };
  const supabase = { storage: { from: () => bucket }, from: () => ({
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: failInsert ? new Error('Insert failed') : null }) }) }),
    delete: () => ({ in: async (_, paths) => { recordsRemoved.push(...paths); return { error: null }; } }),
  }) };
  return { supabase, bucket, uploaded, removed, recordsRemoved };
}

test('signup rejects underage, fractional ages, and short passwords before contacting auth', async () => {
  for (const [age, password] of [['17','12345678'], ['25.5','12345678'], ['121','12345678'], ['25','1234567']]) {
    const f = fixture({ 'signup-first-name':'Test','signup-last-name':'Member','signup-email':'test@example.test','signup-email-confirm':'test@example.test','signup-age':age,'signup-password':password });
    f.app.getAuthRedirectTo = () => 'https://6ixo.com/';
    let calls = 0;
    f.app.supabase = { auth: { signUp: async () => { calls++; return {}; } } };
    await f.app.handleSignup(f.event);
    assert.equal(calls, 0);
    assert.ok(f.notices.length);
  }
});

test('signup asks for email confirmation without marking it signed in', async () => {
  const f = fixture({ 'signup-first-name':'Test','signup-last-name':'Member','signup-email':'TEST@example.test','signup-email-confirm':'test@example.test','signup-age':'25','signup-password':'TestPassword1!' });
  f.app.isSignedIn = false;
  f.app.getAuthRedirectTo = () => 'https://6ixo.com/';
  f.app.markAuthEmailSent = () => {};
  let loginShown = false;
  f.app.showLoginScreen = () => { loginShown = true; };
  f.app.supabase = { auth: { signUp: async payload => { assert.equal(payload.options.emailRedirectTo, 'https://6ixo.com/'); return { data: { user: { identities: [{}] }, session: null } }; } } };
  await f.app.handleSignup(f.event);
  assert.equal(loginShown, true);
  assert.ok(f.notices.some(n => /Confirm your email/.test(n.message)));
  assert.equal(f.app.isSignedIn, false);
});

test('login keeps invalid credentials signed out and clears the busy button', async () => {
  const f = fixture({ email: 'test@example.test', password: 'wrong', submit: '' });
  f.app.isSignedIn = false;
  f.event.currentTarget.querySelector = () => f.elements.submit;
  f.app.supabase = { auth: { signInWithPassword: async () => ({ error: { message: 'Invalid login credentials' } }) } };
  await f.app.handleLogin(f.event);
  assert.equal(f.app.isSignedIn, false);
  assert.equal(f.elements.submit.disabled, false);
  assert.match(f.notices[0].message, /email or password is incorrect/);
});

test('auth callbacks defer dependent requests until after the auth lock callback returns', async () => {
  const f = fixture(); let callback, called = false;
  f.context.window.SUPABASE_URL = 'https://test.supabase.co'; f.context.window.SUPABASE_ANON_KEY = 'public-test-key';
  f.context.window.supabase = { createClient: () => ({ auth: { onAuthStateChange(fn) { callback = fn; return { data: {} }; } } }) };
  f.app.applySupabaseSession = () => { called = true; };
  f.app.initializeSupabaseClient(); callback('SIGNED_IN', { user: { id: 'a' } });
  assert.equal(called, false);
  await new Promise(r => setTimeout(r, 5)); assert.equal(called, true);
});

test('auth callback errors with literal percent signs are shown and URL secrets are cleaned', async () => {
  const f = fixture(); f.context.window.location = { href: 'https://6ixo.com/?error_description=100%25+expired' };
  f.app.supabase = {}; let cleaned = false; f.app.cleanSupabaseAuthUrl = () => { cleaned = true; };
  await f.app.handleSupabaseAuthRedirect();
  assert.equal(cleaned, true); assert.equal(f.notices[0].message, '100% expired');
});

test('password recovery rejects repeat requests while the first email is pending', async () => {
  const f = fixture({ email: 'test@example.test' }); const gate = deferred(); let calls = 0;
  Object.assign(f.app, { getAuthEmailCooldownRemaining: () => 0, getPasswordResetRedirectTo: () => undefined, markAuthEmailSent() {}, supabase: { auth: { resetPasswordForEmail: async () => { calls++; await gate.promise; return {}; } } } });
  const first = f.app.handleForgotPassword(f.event); const second = f.app.handleForgotPassword(f.event); const observedCalls = calls;
  gate.resolve(); await Promise.all([first, second]); assert.equal(observedCalls, 1); assert.equal(f.app.forgotPasswordBusy, false);
});

test('verification resend is single-flight and recovers from failure', async () => {
  const f = fixture(); const gate = deferred(); let calls = 0;
  Object.assign(f.app, { getAuthRedirectTo: () => 'https://6ixo.com/', supabase: { auth: { resend: async () => { calls++; await gate.promise; return {error:new Error('Offline')}; } } } });
  const first = f.app.resendSupabaseSignupConfirmation('test@example.test');
  const second = f.app.resendSupabaseSignupConfirmation('test@example.test');
  const observedCalls = calls; gate.resolve();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, 'rejected'); assert.equal(observedCalls, 1); assert.equal(f.app.verificationResendBusy, false);
});

test('rental calendar rejects impossible dates and accepts leap days correctly', () => {
  const { app } = fixture();
  for (const date of ['2026-02-30','2026-02-29','2026-04-31','2026-13-01','garbage']) assert.equal(app.parseRealestateDateInput(date), null, date);
  assert.ok(app.parseRealestateDateInput('2028-02-29'));
  assert.ok(app.parseRealestateDateInput('2026-09-07'));
});

test('marketplace, stay, and car upload boundaries reject empty, invalid, oversized, and excess files', async () => {
  for (const method of ['uploadMarketplaceListingImages','uploadShortTermRentalImages','uploadVehicleRentalImages']) {
    for (const files of [[], [{ ...photo(), size: 0 }], [{ ...photo(), type: 'text/html' }], [{ ...photo(), size: 51*1024*1024 }], Array.from({ length: 13 }, () => photo())]) {
      const f = fixture(); const storage = storageMock(); f.app.supabase = storage.supabase;
      await assert.rejects(() => f.app[method](files)); assert.equal(storage.uploaded.length, 0);
    }
  }
});

test('a failed listing image batch cleans up successful uploads', async () => {
  const f = fixture(); const storage = storageMock({ failUpload: 2 }); f.app.supabase = storage.supabase;
  await assert.rejects(() => f.app.uploadMarketplaceListingImages([photo(),photo('second.jpg')]), /Upload failed/);
  assert.equal(storage.removed.length, 1); assert.equal(storage.removed[0], storage.uploaded[0].path);
});

test('profile gallery uploads files and replaces browser previews with persistent URLs', async () => {
  const f = fixture(); const storage = storageMock(); f.app.supabase = storage.supabase;
  f.app.currentUser.marketplacePhotos = [{ file: photo(), url: 'blob:preview' }, 'https://example.test/existing.jpg'];
  f.app.renderPhotoSlot = () => {};
  await f.app.persistMarketplaceProfilePhotos();
  assert.equal(storage.uploaded.length, 1);
  assert.match(f.app.currentUser.marketplacePhoto, /^https:\/\//);
  assert.equal(typeof f.app.currentUser.marketplacePhotos[0], 'string');
  assert.equal(f.app.currentUser.marketplacePhotos[1], 'https://example.test/existing.jpg');
});

test('failed profile uploads preserve the selected files for retry and clean uploaded objects', async () => {
  const f = fixture(); const storage = storageMock({ failUpload: 2 }); f.app.supabase = storage.supabase;
  const entries = [{ file: photo(), url: 'blob:one' }, { file: photo(), url: 'blob:two' }]; f.app.currentUser.marketplacePhotos = entries;
  await assert.rejects(() => f.app.persistMarketplaceProfilePhotos(), /Upload failed/);
  assert.equal(f.app.currentUser.marketplacePhotos, entries); assert.equal(storage.removed.length, 1);
});

test('profile save only reports success after both database writes finish; failure retains edits', async () => {
  for (const fails of [false,true]) {
    const f = fixture({ 'profile-account-name': 'Test Person', 'profile-public-name': 'Public Name', 'profile-age': '25', 'profile-bio': 'New bio' });
    const gate = deferred();
    Object.assign(f.app, { syncProfileViewerNamePreview() {}, persistMarketplaceProfilePhotos: async () => {}, upsertSupabaseMarketplaceProfile: async () => { await gate.promise; if (fails) throw new Error('Database unavailable'); }, upsertSupabaseProfile: async () => true, saveUserPreferences() {}, updateMapMarkers() {} });
    const pending = f.app.saveProfile();
    assert.equal(f.notices.filter(n => /saved successfully/.test(n.message)).length, 0);
    gate.resolve(); await pending;
    assert.equal(f.notices.some(n => /saved successfully/.test(n.message)), !fails);
    assert.equal(f.app.currentUser.marketplaceBio, 'New bio');
    assert.equal(f.app.profileSaveBusy, false);
  }
});

function messagingFixture() {
  const f = fixture({ 'message-input':'Hello A', 'send-message':'' });
  Object.assign(f.app, { activeChatThread:'thread-a', activeChatConversationId:'conversation-a', getMarketplaceMessageRisk: () => null, saveChatMessages() {}, renderChatMessages() {}, syncChatMobileViewport() {}, loadMarketplaceConversations: async () => [], ensureChatThread(key) { return this.messages[key] ||= []; } });
  return f;
}

test('a chat switch during send keeps the sent message in its original thread and preserves the new draft', async () => {
  const f = messagingFixture(); const gate = deferred();
  f.app.sendMarketplaceConversationMessage = async id => { assert.equal(id,'conversation-a'); await gate.promise; return { id:'message-a', text:'Hello A', sender:'me' }; };
  const pending = f.app.sendMessage();
  f.app.activeChatThread = 'thread-b'; f.app.activeChatConversationId = 'conversation-b'; f.elements['message-input'].value = 'Draft for B';
  gate.resolve(); await pending;
  assert.equal(f.app.messages['thread-a'][0].id, 'message-a'); assert.equal(f.app.messages['thread-b'], undefined);
  assert.equal(f.elements['message-input'].value, 'Draft for B');
});

test('repeated Enter sends only once; failed sends retain the draft', async () => {
  const f = messagingFixture(); const gate = deferred(); let calls = 0;
  f.app.sendMarketplaceConversationMessage = async () => { calls++; await gate.promise; throw new Error('Offline'); };
  const pending = f.app.sendMessage(); const second = f.app.sendMessage(); const observedCalls = calls;
  gate.resolve(); await Promise.all([pending, second]); assert.equal(observedCalls, 1); assert.equal(f.elements['message-input'].value, 'Hello A');
  assert.equal(f.app.messageSendBusy, false); assert.equal(f.elements['send-message'].disabled, false);
});

test('production chat never pretends a local-only message reached a recipient', async () => {
  const f = messagingFixture(); f.app.activeChatConversationId = null;
  let simulated = false; f.app.simulateMessageDelivery = () => { simulated = true; };
  await f.app.sendMessage(); assert.equal(simulated,false); assert.deepEqual(Object.keys(f.app.messages),[]);
  assert.equal(f.elements['message-input'].value,'Hello A'); assert.match(f.notices[0].message,/no connected in-app recipient/);
});

test('messages arriving during history fetch are preserved without duplicates', async () => {
  const f = messagingFixture(); const gate = deferred();
  f.app.supabase = { rpc: async () => { await gate.promise; return { data: [{id:'old'}] }; } };
  f.app.normalizeMarketplaceMessageRow = row => row;
  f.app.messages['thread-a'] = [{id:'old'}];
  const pending = f.app.loadMarketplaceConversationMessages('conversation-a','thread-a');
  f.app.messages['thread-a'].push({id:'new'}); gate.resolve(); await pending;
  assert.deepEqual(Array.from(f.app.messages['thread-a'],m=>m.id),['old','new']);
});

test('late chat responses cannot populate another account', async () => {
  const f = messagingFixture(); const gate = deferred();
  f.app.supabase = { rpc: async () => { await gate.promise; return { data: [{ id:'secret' }] }; } };
  f.app.normalizeMarketplaceMessageRow = row => row;
  const pending = f.app.loadMarketplaceConversationMessages('conversation-a','thread-a');
  f.app.currentUser.id = 'account-b'; gate.resolve(); await pending;
  assert.equal(f.app.messages['thread-a'], undefined);
});

test('private account state is cleared between users', () => {
  const f = fixture(); Object.assign(f.app, { messages: { private: [{}] }, currentHostApplication: { legal_name:'Private name' }, currentVehicleHostApplication: { phone:'private' }, myPosts:[{}] });
  f.app.currentUser.isAdmin = true; f.app.currentUser.hostStatus = 'approved';
  f.app.clearPrivateAccountState();
  assert.equal(f.app.currentUser.id,null); assert.equal(f.app.currentUser.isAdmin,false); assert.equal(f.app.currentUser.hostStatus,'none');
  assert.equal(f.app.currentHostApplication,null); assert.equal(f.app.myPosts.length,0); assert.equal(Object.keys(f.app.messages).length,0);
});

test('duplicate item submissions share one publish operation and release the guard after failure', async () => {
  const f = fixture(); const gate = deferred(); let calls = 0;
  f.app.publishPostItem = async () => { calls++; await gate.promise; throw new Error('Upload failed'); };
  const pending = f.app.handlePostItem(f.event); const second = f.app.handlePostItem(f.event); const observedCalls = calls;
  gate.resolve(); await Promise.all([pending,second]); assert.equal(observedCalls,1); assert.equal(f.app.postItemBusy,false);
});

test('short-term proof insert failures roll back uploaded files and database records', async () => {
  const f = fixture({ 'host-application-document-type':'government_id' }); const storage = storageMock({failInsert:true}); f.app.supabase = storage.supabase;
  f.app.enforceHostApplicationDocumentLimit = () => [photo()]; f.app.hostDocumentsBucket = 'host-documents';
  await assert.rejects(() => f.app.uploadHostApplicationDocuments('application-a'), /Insert failed/);
  assert.equal(storage.removed.length,1); assert.equal(storage.recordsRemoved.length,1);
});

test('ad artwork is uploaded before checkout and reused on retry', async () => {
  const f = fixture(); let calls = 0;
  f.app.uploadMarketplaceListingImages = async files => { calls++; assert.equal(files[0].name,'photo.jpg'); return {publicUrls:['https://test.supabase.co/art.jpg']}; };
  const uploads = [{file:photo(),src:'blob:preview'}];
  assert.equal(await f.app.prepareAdCreative(uploads),'https://test.supabase.co/art.jpg');
  await f.app.prepareAdCreative(uploads); assert.equal(calls,1);
});

test('seller profile cards resolve string listing IDs into real conversations', () => {
  const f = fixture();
  const listing = { id:'ml_uuid123', serverBacked:true, sourceTable:'marketplace_listings' };
  f.app.marketplaceItems = [listing];
  f.app.discoveryPosts = [{ id:'post123', marketplaceItemId:listing.id }];
  assert.equal(f.app.resolveSellerChatListing({type:'marketplace',id:listing.id}),listing);
  assert.equal(f.app.resolveSellerChatListing({type:'discovery',id:'post123'}),listing);
  assert.equal(f.app.resolveSellerChatListing({type:'marketplace',id:'unconnected'}),null);
});

test('production seller cards never invent reviews, verification, or completed transactions', () => {
  const f = fixture();
  assert.equal(f.app.buildDemoSellerReviews('Seller', 123).length,0);
  assert.equal(f.app.isMarketplaceSellerVerified({id:123}),false);
  assert.equal(f.app.computeSellerTrustMetrics({listings:[{}],reviews:[{}]}),null);
  const meta = f.app.buildReviewMeta({fallbackRating:4.9,fallbackReviews:98});
  assert.equal(meta.ratingValue,null); assert.equal(meta.reviewCount,0); assert.equal(meta.ratingText,'Not rated');
  const evidence = f.app.getSellerProfileEvidence({id:'vehicle-1',description:'Car rental'});
  assert.equal(evidence.verified,false); assert.equal(evidence.ratingValue,null); assert.equal(evidence.reviewCount,0);
  assert.equal(evidence.bio,'Car rental');
});

test('real review evidence is retained without generated fallback numbers', () => {
  const f = fixture();
  const evidence = f.app.getSellerProfileEvidence({rating:4.3,reviews:7});
  assert.equal(evidence.ratingValue,4.3); assert.equal(evidence.reviewCount,7);
});

test('invalid car rental rates and years are rejected before uploads or publishing', async () => {
  for (const changes of [{rate:'-1'}, {rate:'0'}, {year:'2025.5'}, {seats:'0'}, {'min-trip-days':'0'}]) {
    const f = fixture(); const values = {'host-name':'Test Host',make:'Toyota',model:'Corolla',year:'2024',rate:'50',country:'Canada',city:'Toronto',seats:'5','min-trip-days':'1',description:'A test rental',...changes};
    const form = {dataset:{},querySelector(selector){const field = selector.replace('#vehicle-rental-',''); return {value:values[field]||'',checked:true,files:field==='images'?[photo()]:[]};}};
    Object.assign(f.app,{parseVehicleRentalMileageValue:()=>0,getVehicleRentalSelectedFeatures:()=>[],formatVehicleBlockedDates:()=>'',getMissingVehicleRentalComplianceDocumentTypes:()=>[]});
    let uploads = 0; f.app.uploadVehicleRentalImages = async () => { uploads++; };
    await f.app.handleVehicleRentalPostSubmit(form); assert.equal(uploads,0); assert.match(f.notices[0].message,/positive daily rate/);
  }
});

test('approved-host publishing gates cannot fall back to ordinary listing creation', async () => {
  const f = fixture(); let writes = 0;
  f.app.supabase = {from:()=>{writes++;throw new Error('must not write');}};
  await assert.rejects(() => f.app.createSupabaseMarketplaceListing({category:'vehicles',subcategory:'rentals'}),/approved-host/);
  assert.equal(writes,0);
});

test('failed message history loads do not mark unread messages as read', async () => {
  const f = fixture(); let marked = 0;
  Object.assign(f.app, {canViewMarketplaceConversations:()=>true,getMarketplaceRealtimeRecord:()=>({}),activeChatConversationId:'conversation-a',activeChatThread:'thread-a',loadMarketplaceConversationMessages:async()=>null,markMarketplaceConversationRead:async()=>{marked++;}});
  await f.app.handleMarketplaceRealtimeMessage({}, {scope:'conversation',conversationId:'conversation-a'});
  assert.equal(marked,0);
});

test('successful login applies the returned session and removes the entered password', async () => {
  const f = fixture({email:'TEST@example.test',password:'TestPassword1!'});
  const session = {user:{id:'account-a'}}; let applied = null, continued = false;
  Object.assign(f.app,{supabase:{auth:{signInWithPassword:async ({email})=>{assert.equal(email,'test@example.test');return {data:{session}};}}},applySupabaseSession:s=>{applied=s;},showMainApp(){},loadUserProfile(){},loadCurrentCard(){},runPendingAuthAction(){continued=true;}});
  await f.app.handleLogin(f.event);
  assert.equal(applied,session); assert.equal(f.elements.password.value,''); assert.equal(continued,true);
});

test('recovery links install the session and open password reset rather than a generic login result', async () => {
  const f = fixture(); let reset = false, cleaned = false;
  f.context.window.location = {href:'https://6ixo.com/#access_token=test&refresh_token=test-refresh&type=recovery'};
  Object.assign(f.app,{supabase:{auth:{setSession:async ()=>({data:{session:{user:{id:'account-a'}}}})}},applySupabaseSession(){},showResetPasswordScreen(){reset=true;},cleanSupabaseAuthUrl(){cleaned=true;}});
  await f.app.handleSupabaseAuthRedirect(); assert.equal(reset,true); assert.equal(cleaned,true);
});

test('Stripe webhook persists the paid campaign artwork for cross-device delivery', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const ts = readFileSync(new URL('../supabase/functions/stripe-webhook/index.ts',import.meta.url),'utf8');
  const start = ts.indexOf('async function syncAdCampaignFromIntent('), end = ts.indexOf('async function syncConnectedAccount(',start);
  let saved;
  const db = { from: () => ({select:()=>({eq:()=>({maybeSingle:async()=>({data:null})})}),upsert:async row=>{saved=row;return {error:null};}}) };
  const context = {supabaseAdmin:db,toText:v=>v||null,toCurrency:v=>v?.toUpperCase(),PROMOTION_DURATION_HOURS:{home:24},campaignKindForPlacement:()=> 'banner'};
  vm.runInNewContext(stripTypeScriptTypes(ts.slice(start,end),{mode:'transform'}),context);
  await context.syncAdCampaignFromIntent({id:'pi_test',status:'succeeded',amount_received:1200,currency:'usd',metadata:{user_id:'account-a',placement:'home',creative_image_url:'https://test.supabase.co/ad.jpg',creative_title:'Actual paid ad'}});
  assert.equal(saved.creative_image_url,'https://test.supabase.co/ad.jpg'); assert.equal(saved.creative_title,'Actual paid ad'); assert.equal(saved.status,'active');
});
