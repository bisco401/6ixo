const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const classStart = source.indexOf('class DatingApp');
const classEnd = source.indexOf('// Initialize the app when the page loads');

assert.notEqual(classStart, -1, 'DatingApp class was not found');
assert.notEqual(classEnd, -1, 'DatingApp class boundary was not found');

const DatingApp = vm.runInNewContext(
    `${source.slice(classStart, classEnd)}\nDatingApp;`,
    { console }
);
const cleaner = Object.create(DatingApp.prototype);

const csvFiles = [
    'data/kijiji-gta-recent-with-phones.csv',
    'data/oxglow-auto-parts-accessories-recent.csv',
    'data/oxglow-electronics-recent.csv',
    'data/oxglow-real-estate-recent.csv',
    'data/guyana-listings.csv',
    'data/kenya-listings.csv',
    'data/scraped-listings.csv'
];
const prohibitedDisplayCopy = /<\/?(?:p|br|div|li|ul|ol)\b|https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:lease[-\s]?to[-\s]?own|\bOAC\b|\d{2,3}\s*months?\s*:|browse more|see the rest of our inventory|customer service speaks for itself)\b/i;

function readRows(relativePath) {
    const csv = fs.readFileSync(path.join(root, relativePath), 'utf8');
    return cleaner.parseCsvRows(csv);
}

test('keeps the useful lift details and removes imported sales copy', () => {
    const sourceDescription = '<p>Built for indoor electrical, HVAC, signage and facility maintenance work.</p><p>The articulating jib clears obstacles and reaches overhead in tight spaces.</p><p>Call or text 905-218-7368 or email sales@summitequipment.ca.</p><p>Specs:<br>• Model: JLG E300AJP<br>• Platform height: 30 ft<br>• Working height: 36 ft<br>• Platform capacity: 500 lb<br>• Power: battery electric, zero emissions<br>• Year: 2014<br>• Hours: 973</p><p>Includes a fresh annual safety inspection.</p><p>Lease-to-own OAC: 72 months: $581/mo</p><p>Summit Equipment. Trade-ins welcome. See the rest of our inventory at www.summitequipment.ca.</p>';
    const result = cleaner.cleanScrapedListingDescription(sourceDescription);

    assert.match(result, /Built for indoor electrical, HVAC, signage and facility maintenance work\./);
    assert.match(result, /Model: JLG E300AJP/);
    assert.match(result, /Platform height: 30 ft/);
    assert.match(result, /Working height: 36 ft/);
    assert.match(result, /Power: battery electric, zero emissions/);
    assert.match(result, /Hours: 973/);
    assert.match(result, /fresh annual safety inspection/i);
    assert.doesNotMatch(result, prohibitedDisplayCopy);
    assert.doesNotMatch(result, /905[-\s]?218|289[-\s]?684|Summit Equipment|Trade-ins welcome/i);
    assert.ok(result.length <= 620);
});

test('separates malformed inline specs and keeps one value per label', () => {
    // Keep this parser fixture stable even though the scheduled Kijiji feed rolls
    // older listings out of its CSV.
    const row = {
        description: 'Please call 905+354+1853 to check availability. Condition: Refurbished - Minor signs of use Condition: Open Box - Like New Slots: 4Measurements: 7.4" high x 12.5" width x 10.8" depthElectrical: 120V/60HzWatts: 1500 Item #: W-7314 Lapennaco 5515 Stanley Ave. Niagara Falls, On. (905) 354-1853'
    };

    const result = cleaner.cleanScrapedListingDescription(row.description);

    assert.equal((result.match(/Condition:/g) || []).length, 1);
    assert.match(result, /Condition: Refurbished - Minor signs of use/);
    assert.match(result, /Dimensions: 7\.4" high x 12\.5" width x 10\.8" depth/);
    assert.match(result, /Electrical: 120V\/60Hz/);
    assert.match(result, /Power: 1500/);
    assert.match(result, /Item number: W-7314/);
    assert.doesNotMatch(result, /5515 Stanley|905[-+\s]?354/i);
});

test('all current scraped descriptions stay concise and free of source markup', () => {
    let descriptionCount = 0;

    csvFiles.forEach((relativePath) => {
        readRows(relativePath).forEach((row) => {
            const raw = String(row.description || row.summary || '').trim();
            if (!raw) return;
            descriptionCount += 1;
            const result = cleaner.cleanScrapedListingDescription(raw, row);
            assert.ok(result.length <= 620, `${relativePath}: ${row.title || row.id} exceeded the display limit`);
            assert.doesNotMatch(result, prohibitedDisplayCopy, `${relativePath}: ${row.title || row.id} kept irrelevant source copy`);
        });
    });

    assert.ok(descriptionCount >= 200, 'Expected to validate all populated current scraped feeds');
});

test('user-written listing descriptions are not shortened', () => {
    const description = 'Call me after 6 p.m. to arrange pickup. I wrote this description myself.';
    const result = cleaner.getMarketplaceDisplayDescription({
        description,
        source: { type: 'user' }
    });

    assert.equal(result, description);
});
