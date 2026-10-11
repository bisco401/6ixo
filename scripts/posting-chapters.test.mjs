import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const chaptersSource = fs.readFileSync(new URL('../assets/posting-accordion.js', import.meta.url), 'utf8');
function fixture() {
    const fields = {};
    const button = { disabled: false };
    const form = { querySelector: selector => selector === 'button[type="submit"]' ? button : null, querySelectorAll: () => [] };
    fields['post-item-form'] = form;
    fields['post-item-modal'] = {};
    const context = { console, URL, URLSearchParams, setTimeout, clearTimeout, window: { addEventListener() {} }, document: { getElementById: id => fields[id] || null }, localStorage: { getItem() { return null; } } };
    vm.runInNewContext(appSource.slice(0, appSource.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    vm.runInNewContext(chaptersSource, context);
    const notices = [];
    const app = Object.assign(Object.create(context.App.prototype), { marketplaceUploads: [], requireSignedIn: () => true, renderMarketplaceUploads() {}, showNotification: message => notices.push(message) });
    const chapters = context.window.SixoPostingAccordion.attach(app);
    chapters.sections = Array.from({ length: 4 }, () => ({ querySelectorAll: () => [] }));
    chapters.openStep = step => { chapters.active = step; };
    chapters.updateChapterNavigation = () => {};
    chapters.renderReview = () => {};
    return { app, chapters, fields, notices, button, event: { preventDefault() {}, currentTarget: form } };
}

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
