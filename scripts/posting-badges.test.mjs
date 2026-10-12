import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture(values = {}) {
    const fields = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value, textContent: '' }]));
    const checked = [];
    const context = { console, URL, URLSearchParams, setTimeout, clearTimeout, window: {}, document: {
        getElementById: id => fields[id] || null,
        querySelectorAll: () => checked
    } };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    const notices = [];
    const app = Object.assign(Object.create(context.App.prototype), {
        showNotification: message => notices.push(message), schedulePostItemDraftSave() {}, renderPostItemLivePreview() {}
    });
    return { app, fields, checked, notices };
}

test('electrician hiring has trade requirements and work badges, without sales or remote badges', () => {
    const { app } = fixture();
    const options = app.getMarketplaceCategoryBadgeOptions('jobs', { subcategory: 'skilled_trades' });
    for (const label of ['Full-time', 'Hiring now', 'On-site', 'Licence required', 'Apprentices welcome']) assert.ok(options.includes(label));
    for (const label of ['Negotiable', 'Pickup available', 'Shipping available', 'Remote']) assert.equal(options.includes(label), false);
    assert.ok(app.getMarketplaceCategoryBadgeOptions('jobs', { jobCategory: 'tech_digital' }).includes('Remote'));
});

test('transport, healthcare and childcare use the actual job taxonomy', () => {
    const { app } = fixture();
    for (const [subcategory, label] of [['transportation', 'Driver’s licence required'], ['healthcare_wellness', 'Licence required'], ['childcare_education', 'Background check required']]) {
        assert.ok(app.getMarketplaceCategoryBadgeOptions('jobs', { subcategory }).includes(label));
    }
});

test('phone, headphone and gaming badges describe the selected device', () => {
    const { app } = fixture();
    const options = subcategory => app.getMarketplaceCategoryBadgeOptions('electronics', { subcategory });
    assert.ok(options('phones_accessories').includes('Unlocked'));
    assert.equal(options('audio_headphones').includes('Unlocked'), false);
    assert.ok(options('audio_headphones').includes('Noise cancelling'));
    assert.ok(options('gaming_consoles').includes('Controller included'));
    assert.equal(options('gaming_consoles').includes('Noise cancelling'), false);
});

test('property sale and long-term rental badges do not offer instant booking', () => {
    const { app } = fixture();
    const options = listingType => app.getMarketplaceCategoryBadgeOptions('real_estate', { realestate: { listingType } });
    assert.ok(options('for_rent_short').includes('Instant book'));
    assert.equal(options('for_sale').includes('Instant book'), false);
    assert.equal(options('for_rent_long').includes('Instant book'), false);
    assert.equal(options('for_sale').includes('Long-term'), false);
});

test('stale sales and trade badges cannot be submitted under a different category or role', () => {
    const { app, fields, checked } = fixture({ 'item-category': 'jobs', 'item-subcategory': 'tech_digital', 'item-category-badges': 'Negotiable|Apprentices welcome|Full-time' });
    assert.deepEqual(Array.from(app.getSelectedMarketplaceCategoryBadges()), ['Full-time']);
    checked.push({ value: 'Negotiable' }, { value: 'Remote' });
    assert.deepEqual(Array.from(app.getSelectedMarketplaceCategoryBadges()), ['Remote']);
    fields['item-category'].value = 'electronics';
    fields['item-subcategory'].value = 'audio_headphones';
    assert.deepEqual(Array.from(app.getSelectedMarketplaceCategoryBadges()), []);
});

test('viewer badges filter old sales labels out of a hiring ad', () => {
    const { app } = fixture();
    const badges = app.getMarketplaceCategoryBadges({ category: 'jobs', jobCategory: 'skilled_trades', categoryBadges: ['Negotiable', 'Shipping available', 'Licence required'], tags: ['pickup', 'Full-time'], employmentType: 'full_time', jobStatus: 'Hiring now' });
    assert.ok(badges.includes('Licence required'));
    assert.ok(badges.includes('Hiring now'));
    for (const label of ['Negotiable', 'Shipping available', 'Pickup available']) assert.equal(badges.includes(label), false);
});

test('a clear hiring title suggests Jobs and its trade form without treating a book as a vacancy', () => {
    const { app } = fixture();
    const title = 'Licensed electrician — join our growing team';
    const suggestion = app.getPostItemCategorySuggestion({ category: 'buy_sell', title });
    assert.equal(suggestion.category, 'jobs');
    assert.equal(suggestion.subcategory, 'skilled_trades');
    assert.equal(app.getPostItemCategorySuggestion({ category: 'jobs', title }), null);
    assert.equal(app.getPostItemCategorySuggestion({ category: 'jobs', subcategory: 'tech_digital', title }).subcategory, 'skilled_trades');
    assert.equal(app.getPostItemCategorySuggestion({ category: 'buy_sell', title: 'Hiring handbook for managers' }), null);
});

test('AI does not invent the first badge or write sales descriptions for jobs', () => {
    const { app, fields } = fixture({ 'item-category': 'jobs', 'item-title': '', 'item-description': '', 'post-ai-status': '' });
    const firstBadge = { checked: false, dispatchEvent() { throw new Error('An unsupported badge was selected'); } };
    fields['item-category-badge-picker'] = { classList: { contains: () => false }, querySelector: () => firstBadge };
    app.runPostAiConcierge();
    assert.equal(firstBadge.checked, false);
    assert.match(fields['item-description'].value, /responsibilities/);
    assert.doesNotMatch(fields['item-description'].value, /pickup|condition|public place/i);
});

test('AI flags an electrician ad filed under Buy n Sell before generating unrelated sales copy', () => {
    const title = 'Licensed electrician — join our growing team';
    const { app, fields, notices } = fixture({ 'item-category': 'buy_sell', 'item-title': title, 'item-description': '', 'post-ai-status': '' });
    app.runPostAiConcierge();
    assert.equal(fields['item-title'].value, title);
    assert.equal(fields['item-description'].value, '');
    assert.match(notices[0], /Use Jobs/);
});
