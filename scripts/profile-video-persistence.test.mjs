import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture({ updateError = null, uploadError = null } = {}) {
    const nodes = new Map();
    for (const id of ['profile-video-preview', 'profile-video-status', 'record-video-btn', 'retake-video-btn', 'use-video-btn', 'profile-video-player', 'profile-video-player-wrap', 'profile-video-trigger', 'profile-video-tools']) {
        const classes = new Set(['hidden']);
        nodes.set(id, { src: '', hidden: true, disabled: false, textContent: '', pause() {}, play: async () => {}, removeAttribute(name) { delete this[name]; }, classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle(c, value) { if (value) classes.add(c); else classes.delete(c); }, contains: c => classes.has(c) } });
    }
    const choices = { photo: { value: 'photo', checked: false }, photo_video: { value: 'photo_video', checked: true } };
    const context = { console: { warn() {} }, URL, URLSearchParams, Blob, Date, Map, Set, window: {}, navigator: {}, document: { getElementById: id => nodes.get(id), querySelector: selector => selector.includes(':checked') ? Object.values(choices).find(x => x.checked) : choices.photo_video, querySelectorAll: () => [], addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App=DatingApp;', context);
    const calls = { uploads: [], deletes: [], updates: [] };
    const accountId = '10000000-0000-4000-8000-000000000001';
    const origin = 'https://test.supabase.co';
    const oldPath = `${accountId}/profile-video/old.mp4`;
    const app = Object.assign(Object.create(context.App.prototype), { isSignedIn: true, currentUser: { id: accountId, profileVideoUrl: `${origin}/storage/v1/object/public/marketplace-media/${oldPath}` }, requireSignedIn() { return this.isSignedIn; }, getMarketplaceUsername: () => 'seller' });
    const bucket = {
        async upload(path, blob, options) { calls.uploads.push({ path, blob, options }); if (calls.onUpload) await calls.onUpload(); return { error: uploadError }; },
        getPublicUrl: path => ({ data: { publicUrl: `${origin}/storage/v1/object/public/marketplace-media/${path}` } }),
        async remove(paths) { calls.deletes.push(...paths); return { error: null }; }
    };
    app.supabase = { supabaseUrl: origin, storage: { from: () => bucket }, auth: { getUser: async () => ({ data: { user: { id: accountId } } }) }, from: () => ({ update(payload) { calls.updates.push(payload); const chain = { eq() { return chain; }, select() { return chain; }, maybeSingle: async () => ({ error: updateError, data: updateError ? null : { id: 'profile-id', public_id: 'mp_profile' } }) }; return chain; } }) };
    return { app, context, calls, nodes, choices, accountId, oldPath };
}
const video = () => new Blob(['synthetic recorded bytes'], { type: 'video/mp4' });
test('saving a clip uploads a durable URL, preserves unrelated fields, and removes the previous clip', async () => {
    const { app, calls, oldPath, accountId } = fixture();
    const url = await app.persistProfileVideo(video());
    assert.match(calls.uploads[0].path, new RegExp(`^${accountId}/profile-video/.*\\.mp4$`));
    assert.equal(calls.uploads[0].options.contentType, 'video/mp4');
    assert.equal(app.currentUser.profileVideoUrl, url);
    assert.equal(calls.updates[0].profile_video_url, url);
    assert.deepEqual(Object.keys(calls.updates[0]), ['profile_video_url']);
    assert.deepEqual(calls.deletes, [oldPath]);
});
test('database failure removes only the new upload and preserves the saved clip', async () => {
    const { app, calls } = fixture({ updateError: new Error('save failed') });
    const before = app.currentUser.profileVideoUrl;
    await assert.rejects(app.persistProfileVideo(video()), /save failed/);
    assert.equal(app.currentUser.profileVideoUrl, before);
    assert.deepEqual(calls.deletes, [calls.uploads[0].path]);
});
test('upload failure cannot write a profile or show success and remains retryable', async () => {
    const { app, calls, nodes, accountId } = fixture({ uploadError: new Error('offline') });
    app.recordedVideoBlob = video(); app.profileVideoRecordingUserId = accountId;
    await app.useRecordedVideo();
    assert.equal(calls.updates.length, 0);
    assert.match(nodes.get('profile-video-status').textContent, /could not be saved/);
    assert.equal(nodes.get('use-video-btn').disabled, false);
    assert.equal(app.profileVideoSaveBusy, false);
    assert.ok(app.recordedVideoBlob);
});
test('switching accounts during upload deletes the new file without writing either account', async () => {
    const { app, calls } = fixture();
    calls.onUpload = () => { app.currentUser = { id: 'other-user', profileVideoUrl: '' }; };
    await assert.rejects(app.persistProfileVideo(video()), /session changed/);
    assert.equal(calls.updates.length, 0);
    assert.deepEqual(calls.deletes, [calls.uploads[0].path]);
    assert.equal(app.currentUser.profileVideoUrl, '');
});
test('authenticated user mismatch and unsupported clips are rejected before upload', async () => {
    const { app, calls } = fixture();
    await assert.rejects(app.persistProfileVideo(new Blob(['bad'], { type: 'text/html' })), /supported video/);
    await assert.rejects(app.persistProfileVideo(new Blob([], { type: 'video/mp4' })), /supported video/);
    app.supabase.auth.getUser = async () => ({ data: { user: { id: 'other' } } });
    await assert.rejects(app.persistProfileVideo(video()), /session changed/);
    assert.equal(calls.uploads.length, 0);
});
test('removing a saved video clears the database and its owned storage object', async () => {
    const { app, calls, oldPath } = fixture();
    await app.persistProfileVideo(null);
    assert.equal(calls.updates[0].profile_video_url, null);
    assert.equal(app.currentUser.profileVideoUrl, '');
    assert.deepEqual(calls.deletes, [oldPath]);
});
test('cleanup cannot delete other users or arbitrary URL paths', () => {
    const { app, accountId } = fixture();
    for (const url of ['https://evil.example/storage/v1/object/public/marketplace-media/' + accountId + '/profile-video/a.mp4', 'https://test.supabase.co/storage/v1/object/public/marketplace-media/other/profile-video/a.mp4', 'blob:temporary']) assert.equal(app.getProfileVideoStoragePath(url, accountId), '');
});
test('a reloaded profile restores the video URL and supports play/close/photo-only', async () => {
    const { app, nodes, choices } = fixture();
    const durableUrl = app.currentUser.profileVideoUrl;
    app.supabase.from = () => { const chain = { select() { return chain; }, eq() { return chain; }, maybeSingle: async () => ({ data: { id: 'profile-id', display_name: 'seller', profile_video_url: durableUrl } }) }; return chain; };
    app.ensureProfileUsernames = () => {};
    app.currentUser.profileVideoUrl = '';
    await app.loadSupabaseMarketplaceProfile(app.currentUser.id);
    app.renderProfileVideo();
    assert.equal(nodes.get('profile-video-preview').src, durableUrl);
    assert.equal(nodes.get('profile-video-trigger').classList.contains('hidden'), false);
    app.openProfileVideo();
    assert.equal(nodes.get('profile-video-player').src, durableUrl);
    assert.equal(nodes.get('profile-video-player-wrap').classList.contains('hidden'), false);
    choices.photo_video.checked = false; choices.photo.checked = true;
    app.renderProfileVideo();
    assert.equal(nodes.get('profile-video-trigger').classList.contains('hidden'), true);
    assert.equal(nodes.get('profile-video-player-wrap').classList.contains('hidden'), true);
});
test('recorder selects MP4 when WebM is unsupported and releases camera tracks', async () => {
    const { app, context, nodes } = fixture();
    let stopped = 0;
    context.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) };
    context.MediaRecorder = class {
        static isTypeSupported = type => type === 'video/mp4';
        constructor(stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.ondataavailable?.({ data: video() }); this.onstop?.(); }
    };
    await app.startVideoRecording();
    assert.equal(app.mediaRecorder.mimeType, 'video/mp4');
    app.mediaRecorder.stop();
    assert.equal(app.recordedVideoBlob.type, 'video/mp4');
    assert.equal(stopped, 1);
    assert.equal(nodes.get('use-video-btn').disabled, false);
    app.resetProfileVideoRecording();
    assert.equal(app.recordedVideoBlob, null);
});
test('migration repairs schema drift idempotently, keeps existing rows, and rejects temporary video URLs', async () => {
    const db = new PGlite();
    try {
        await db.exec("create table host_applications(id int primary key, legal_name text); insert into host_applications values(1,'existing host'); create table marketplace_profiles(id int primary key, display_name text); insert into marketplace_profiles values(1,'existing seller');");
        const migration = readFileSync(new URL('../supabase/migrations/20261007190000_repair_host_fields_and_profile_video.sql', import.meta.url), 'utf8');
        await db.exec(migration); await db.exec(migration);
        assert.equal((await db.query('select legal_name from host_applications where id=1')).rows[0].legal_name, 'existing host');
        await db.exec("update host_applications set bedrooms=2,bathrooms=1.5,has_insurance=true where id=1; update marketplace_profiles set profile_video_url='https://test.example/video.mp4' where id=1;");
        assert.equal(Number((await db.query('select bathrooms from host_applications')).rows[0].bathrooms), 1.5);
        await assert.rejects(db.exec("update marketplace_profiles set profile_video_url='blob:temporary';"), /marketplace_profile_video_https/);
    } finally { await db.close(); }
});
test('profile ID defaults allow new profiles while keeping existing identities', async () => {
    const db = new PGlite();
    try {
        await db.exec("create table marketplace_profiles(public_id text unique not null, display_name text,map_visible boolean default true); create table dating_profiles(public_id text unique not null, display_name text); insert into marketplace_profiles(public_id,display_name) values('mp_existing','existing');");
        const migration = readFileSync(new URL('../supabase/migrations/20261007191000_restore_profile_id_defaults.sql', import.meta.url), 'utf8');
        await db.exec(migration); await db.exec(migration);
        await db.exec("insert into marketplace_profiles(display_name) values('new'),('another'); insert into dating_profiles(display_name) values('new');");
        const rows = (await db.query('select * from marketplace_profiles order by display_name')).rows;
        assert.equal(rows.find(r => r.display_name === 'existing').public_id, 'mp_existing');
        for (const row of rows.filter(r => r.display_name !== 'existing')) { assert.match(row.public_id, /^mp_[a-f0-9]{16}$/); assert.equal(row.map_visible, false); }
        assert.equal(new Set(rows.map(r => r.public_id)).size, 3);
        assert.match((await db.query('select public_id from dating_profiles')).rows[0].public_id, /^dp_[a-f0-9]{16}$/);
    } finally { await db.close(); }
});
test('legacy public policies cannot expose account details or hidden dating profiles', async () => {
    const db = new PGlite();
    try {
        await db.exec(`create role anon; create role authenticated; create schema auth;
            create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
            create function public.is_admin_user() returns boolean language sql stable as $$ select false $$;
            grant usage on schema auth to anon,authenticated;
            create table profiles(id uuid primary key,full_name text);
            create table dating_profiles(user_id uuid,display_name text,is_active boolean,is_discoverable boolean);
            alter table profiles enable row level security; alter table dating_profiles enable row level security;
            create policy profiles_select_public on profiles for select to anon,authenticated using(true);
            create policy profiles_select_own on profiles for select to authenticated using(id=auth.uid());
            create policy dating_profiles_select_public on dating_profiles for select to anon,authenticated using(is_active or user_id=auth.uid());
            create policy dating_profiles_select_discoverable_or_own on dating_profiles for select using(is_discoverable or user_id=auth.uid());
            grant select on profiles,dating_profiles to anon,authenticated;
            insert into profiles values('10000000-0000-4000-8000-000000000001','private name'),('10000000-0000-4000-8000-000000000002','other private name');
            insert into dating_profiles values('10000000-0000-4000-8000-000000000001','hidden',true,false),('10000000-0000-4000-8000-000000000002','public',true,true);`);
        const migration=readFileSync(new URL('../supabase/migrations/20261007192000_keep_account_profiles_private.sql',import.meta.url),'utf8');
        await db.exec(migration);await db.exec(migration);
        await db.exec("set role anon; select set_config('test.uid','',false);");
        assert.equal((await db.query('select * from profiles')).rows.length,0);
        assert.deepEqual((await db.query('select display_name from dating_profiles')).rows.map(r=>r.display_name),['public']);
        await db.exec("reset role; set role authenticated; select set_config('test.uid','10000000-0000-4000-8000-000000000001',false);");
        assert.deepEqual((await db.query('select full_name from profiles')).rows.map(r=>r.full_name),['private name']);
        assert.equal((await db.query('select * from dating_profiles')).rows.length,2);
        await db.exec("select set_config('test.uid','10000000-0000-4000-8000-000000000002',false);");
        assert.deepEqual((await db.query('select display_name from dating_profiles')).rows.map(r=>r.display_name),['public']);
    } finally { await db.close(); }
});
