const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const profileMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260225010000_create_profiles_base.sql'),
  'utf8'
);

const privateIndex = html.indexOf('id="profile-account-name"');
const publicIndex = html.indexOf('id="profile-public-name"');
assert(privateIndex >= 0, 'Private Profile name field is missing');
assert(publicIndex > privateIndex, 'Public name must follow the private Profile name');
assert(html.includes('This is the name you registered with. Only you can see it.'), 'Private Profile name explanation is missing');
assert(html.includes('Shown to viewers on your profile, listings, reviews, and messages.'), 'Public name explanation is missing');
assert(!html.includes('Profile nickname (optional)'), 'Legacy Profile nickname field is still rendered');
assert(!html.includes('id="profile-username"'), 'Legacy public-name field is still rendered');

const marketplaceLoader = app.slice(
  app.indexOf('async loadSupabaseMarketplaceProfile'),
  app.indexOf('async upsertSupabaseMarketplaceProfile')
);
assert(!marketplaceLoader.includes('this.currentUser.name = displayName'), 'Public-name loading must not overwrite the private Profile name');

const ensureNamesStart = app.indexOf('ensureProfileUsernames() {');
const ensureNames = app.slice(ensureNamesStart, app.indexOf('refreshVisibleProfileScreen()', ensureNamesStart));
assert(ensureNames.includes('this.currentUser.name = accountName'), 'The account name must remain the private currentUser name');
assert(!ensureNames.includes('this.currentUser.name = marketplaceUsername'), 'The Public name must not replace the private account name');

const saveStart = app.indexOf('\n\t    saveProfile() {');
const saveProfile = app.slice(saveStart, app.indexOf('loadAuctionsState()', saveStart));
assert(saveProfile.includes('this.currentUser.accountName = privateProfileName'), 'Profile save must retain the private name');
assert(saveProfile.includes('this.currentUser.marketplaceUsername = publicIdentity'), 'Profile save must retain the Public name separately');

assert(profileMigration.includes('using (auth.uid() = id)'), 'Private profiles must remain owner-only');

console.log('Profile name privacy test passed');
