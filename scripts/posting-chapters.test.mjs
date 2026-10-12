import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const chaptersSource = fs.readFileSync(new URL('../assets/posting-accordion.js', import.meta.url), 'utf8');
function fixture() {
    const fields = {};
    const storage = new Map();
    const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
    const button = { disabled: false };
    const form = { querySelector: selector => selector === 'button[type="submit"]' ? button : null, querySelectorAll: () => [] };
    fields['post-item-form'] = form;
    fields['post-item-modal'] = {};
    const context = { console, Event, URL, URLSearchParams, setTimeout, clearTimeout, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 720, localStorage }, document: { getElementById: id => fields[id] || null }, localStorage };
    vm.runInNewContext(appSource.slice(0, appSource.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    vm.runInNewContext(chaptersSource, context);
    const notices = [];
    const app = Object.assign(Object.create(context.App.prototype), { marketplaceUploads: [], requireSignedIn: () => true, renderMarketplaceUploads() {}, showNotification: message => notices.push(message) });
    const chapters = context.window.SixoPostingAccordion.attach(app);
    chapters.sections = Array.from({ length: 4 }, () => ({ querySelectorAll: () => [] }));
    chapters.openStep = step => { chapters.active = step; };
    chapters.updateChapterNavigation = () => {};
    chapters.renderReview = () => {};
    return { app, chapters, fields, notices, button, context, storage, event: { preventDefault() {}, currentTarget: form } };
}

function communityFixture() {
    const fixtureData = fixture();
    const { fields, app, context } = fixtureData;
    fields['community-post-form'] = { querySelector: () => null };
    fields['community-post-modal'] = {};
    const community = context.window.SixoPostingAccordion.attachCommunity(app, { preview: true });
    community.showStatus = () => {};
    for (const id of community.draftFields) fields[id] = { value: '' };
    return { ...fixtureData, community };
}

test('Community drafts restore category, copy, photo URL and location across reopening', () => {
    const { community, fields } = communityFixture();
    Object.assign(fields['community-post-category'], { value: 'events' });
    fields['community-post-title-input'].value = 'Neighbourhood picnic';
    fields['community-post-image'].value = 'https://example.com/photo.jpg';
    fields['community-post-city'].value = 'Toronto';
    assert.equal(community.saveDraft(false), true);
    for (const id of community.draftFields) fields[id].value = '';
    community.restoreDraft();
    assert.equal(fields['community-post-category'].value, 'events');
    assert.equal(fields['community-post-title-input'].value, 'Neighbourhood picnic');
    assert.equal(fields['community-post-image'].value, 'https://example.com/photo.jpg');
    assert.equal(fields['community-post-city'].value, 'Toronto');
});

test('Community draft storage failure does not report a successful save', () => {
    const { community, context, notices } = communityFixture();
    context.window.localStorage.setItem = () => { throw new Error('Storage unavailable'); };
    let successes = 0;
    community.showStatus = () => { successes++; };
    assert.equal(community.saveDraft(), false);
    assert.equal(successes, 0);
    assert.match(notices[0], /could not be saved/);
});

test('Community retains its optional photo rule and clears a published draft', () => {
    const { community, storage } = communityFixture();
    assert.equal(community.validatePhotos(), true);
    community.saveDraft(false);
    assert.equal(storage.has(community.draftKey), true);
    community.clearDraft();
    assert.equal(storage.has(community.draftKey), false);
});

test('successful Community publication clears its draft through the existing publisher', () => {
    const { app, community, fields, storage } = communityFixture();
    for (const [id, value] of Object.entries({ 'community-post-category': 'events', 'community-post-title-input': 'Neighbourhood picnic', 'community-post-summary': 'Meet neighbours at the park.', 'community-post-city': 'Toronto', 'community-post-country': 'Canada' })) fields[id].value = value;
    community.saveDraft(false);
    app.normalizeCommunityPostRecord = record => record;
    app.getMarketplaceUsername = () => 'test.seller';
    app.saveCommunityPosts = () => {};
    app.updateCommunityCategoryButtons = () => {};
    app.filterCommunityPosts = () => {};
    app.renderCommunityComposerPreview = () => {};
    app.switchScreen = () => {};
    fields['community-post-modal'].classList = { add() {} };
    fields['community-post-form'].reset = () => {};
    app.handleCommunityPostSubmit({ preventDefault() {} });
    assert.equal(app.communityPosts.length, 1);
    assert.equal(app.communityPosts[0].category, 'events');
    assert.equal(app.communityPosts[0].title, 'Neighbourhood picnic');
    assert.equal(storage.has(community.draftKey), false);
});

test('an empty photo chapter cannot pass validation or remain marked complete', () => {
    const { chapters, notices } = fixture();
    chapters.completed.add(1);
    assert.equal(chapters.validateStep(1), false);
    assert.equal(chapters.active, 1);
    assert.equal(chapters.completed.has(1), false);
    assert.match(notices[0], /at least one photo/);
});

test('missing photos stop submission before promotion options or publication', async () => {
    const { app, chapters, event, button } = fixture();
    let choices = 0, publications = 0;
    chapters.prepareSubmission = async () => { choices++; return true; };
    app.publishPostItem = async () => { publications++; };
    await app.handlePostItem(event);
    assert.equal(choices, 0);
    assert.equal(publications, 0);
    assert.equal(button.disabled, false);
});

test('removing the last photo clears the completed chapter', () => {
    const { app, chapters } = fixture();
    app.marketplaceUploads = [{ src: 'blob:sample' }];
    assert.equal(chapters.validateStep(1), true);
    chapters.completed.add(1);
    app.marketplaceUploads = [];
    app.renderMarketplaceUploads();
    assert.equal(chapters.completed.has(1), false);
});

test('promotion cancellation preserves the form and releases the submission guard', async () => {
    const { app, chapters, event, button } = fixture();
    app.marketplaceUploads = [{ src: 'blob:sample' }];
    let publications = 0;
    chapters.prepareSubmission = async () => false;
    app.publishPostItem = async () => { publications++; };
    await app.handlePostItem(event);
    assert.equal(publications, 0);
    assert.equal(app.postItemBusy, false);
    assert.equal(button.disabled, false);
    chapters.prepareSubmission = async () => true;
    await app.handlePostItem(event);
    assert.equal(publications, 1);
});

test('repeat publish clicks while promotion options are open create one publication', async () => {
    const { app, chapters, event } = fixture();
    app.marketplaceUploads = [{ src: 'blob:sample' }];
    let resolve, choices = 0, publications = 0;
    const waiting = new Promise(done => { resolve = done; });
    chapters.prepareSubmission = () => { choices++; return waiting; };
    app.publishPostItem = async () => { publications++; };
    const first = app.handlePostItem(event);
    await app.handlePostItem(event);
    resolve(true);
    await first;
    assert.equal(choices, 1);
    assert.equal(publications, 1);
    assert.equal(app.postItemBusy, false);
});

test('Community is available while restricted categories and placements stay restricted', () => {
    const { app, fields } = fixture();
    const options = Object.fromEntries(['community', 'dating', 'companionship'].map(value => [value, { disabled: true, hidden: true }]));
    fields['item-category'] = { value: 'jobs', querySelector: selector => options[selector.match(/value="([^"]+)"/)[1]] };
    app.configureSharedPostFormDatingAccess({ source: 'global_header' });
    assert.equal(options.community.disabled, false);
    assert.equal(options.community.hidden, false);
    assert.equal(options.dating.disabled, true);
    assert.equal(options.companionship.hidden, true);
});

test('Community selection saves the previous draft and opens its dedicated composer', () => {
    const { app, chapters, fields } = fixture();
    let listener, savedCategory, opened = 0, updates = 0, stopped = false;
    fields['item-category'] = { value: 'community', dataset: {}, addEventListener: (type, fn) => { listener = fn; } };
    chapters.categoryValue = 'jobs';
    app.hidePostItemModal = options => {
        assert.equal(options.preserveDraft, true);
        assert.equal(options.forceClose, true);
        savedCategory = fields['item-category'].value;
    };
    app.updateBrowserUiState = () => {};
    app.openCommunityPostModal = () => { opened++; };
    app.updatePostItemCategoryFields = () => { updates++; };
    app.bindPostItemCategory();
    listener({ target: fields['item-category'], stopPropagation() { stopped = true; } });
    assert.equal(savedCategory, 'jobs');
    assert.equal(opened, 1);
    assert.equal(updates, 0);
    assert.equal(stopped, true);
});

test('opening Community directly binds its form without visiting the Community screen first', () => {
    const { app, fields } = fixture();
    let bound = false, visible = false;
    fields['community-post-modal'] = { classList: { remove() { assert.equal(bound, true); visible = true; } } };
    fields['community-post-form'] = {};
    app.bindCommunityComposer = () => { bound = true; };
    app.renderCommunityComposerPreview = () => {};
    app.openCommunityPostModal();
    assert.equal(bound, true);
    assert.equal(visible, true);
});

test('the category menu changes the original form only on an explicit valid choice', () => {
    const { chapters } = fixture();
    let changes = 0;
    chapters.categorySelect = { value: 'jobs', options: [{value:'jobs'}, {value:'services'}, {value:'dating',disabled:true}], dispatchEvent: () => { changes++; } };
    chapters.categoryOptions = { hidden: true, style: {}, offsetHeight: 280 };
    chapters.categoryTrigger = { setAttribute() {}, focus() {}, getBoundingClientRect: () => ({width: 300, left: 20, bottom: 100}) };
    chapters.modal.classList = { contains: () => false };
    chapters.syncCategoryPicker = () => {};
    chapters.setCategoryPickerOpen(true);
    assert.equal(chapters.categorySelect.value, 'jobs');
    chapters.chooseCategory('dating');
    assert.equal(changes, 0);
    chapters.chooseCategory('jobs');
    assert.equal(changes, 0);
    assert.equal(chapters.categoryOptions.hidden, true);
    chapters.chooseCategory('services');
    assert.equal(chapters.categorySelect.value, 'services');
    assert.equal(changes, 1);
    assert.equal(chapters.categoryOptions.hidden, true);
});

test('a missing category focuses the visible picker instead of the hidden select', () => {
    const { chapters, notices } = fixture();
    let focused = false, opened = false, invalid = '';
    chapters.categoryTrigger = { setAttribute: (name, value) => { if (name === 'aria-invalid') invalid = value; }, focus: () => { focused = true; } };
    chapters.setCategoryPickerOpen = value => { opened = value; };
    const field = { id: 'item-category', closest: () => ({ dataset: { postingStep: '0' } }), reportValidity: () => { throw new Error('Hidden select must not receive focus'); } };
    assert.equal(chapters.revealInvalid(field), false);
    assert.equal(chapters.active, 0);
    assert.equal(invalid, 'true');
    assert.equal(opened, true);
    assert.equal(focused, true);
    assert.match(notices[0], /main category/);
});

test('shipping draft values alone never request a paid promotion', () => {
    const { chapters, fields } = fixture();
    fields['item-placement'] = { value: 'market' };
    fields['item-featured'] = { checked: false };
    fields['item-sponsored-arrival'] = { checked: false };
    fields['item-destination-country'] = { value: 'Guyana' };
    fields['item-transit-status'] = { value: 'in_transit' };
    assert.equal(chapters.isPromotionRequested(), false);
    fields['item-sponsored-arrival'].checked = true;
    assert.equal(chapters.isPromotionRequested(), true);
    fields['item-sponsored-arrival'].checked = false;
    assert.equal(chapters.isPromotionRequested(), false);
});

test('sponsored arrival opt-in selects the category placement, including fashion', () => {
    const { app, chapters, fields } = fixture();
    fields['item-sponsored-arrival'] = { checked: true };
    app.getPromotionFeeForPlacement = key => ({ amount: 9.99, label: key });
    for (const category of ['electronics', 'vehicles', 'clothing', 'other']) {
        fields['item-category'] = { value: category };
        const options = chapters.getPromotionOptions();
        assert.equal(options.length, 1);
        assert.equal(options[0].key, app.getFeaturedPlacementForStoredListing({ category }, ''));
    }
});
