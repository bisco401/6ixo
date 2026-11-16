import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const appSource = source.slice(0, source.indexOf('// Initialize the app when the page loads'));

function renderListings({ timeZone, now }) {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = timeZone;
    try {
        class FixedDate extends Date {
            constructor(...args) {
                super(...(args.length ? args : [now]));
            }
        }
        const container = { classList: { toggle() {} }, innerHTML: '' };
        const document = { getElementById: id => id === 'marketplace-items' ? container : null };
        const App = vm.runInNewContext(`${appSource}\nDatingApp;`, { Date: FixedDate, document });
        const instant = new FixedDate();
        const recent = new FixedDate(instant.getTime() - 5 * 3600000);
        const older = new FixedDate(instant.getFullYear(), instant.getMonth(), instant.getDate() - 2, 12);
        const app = Object.assign(Object.create(App.prototype), {
            marketplaceViewMode: 'list',
            filteredItems: [{ postedDate: recent }, { postedDate: older }],
            getCurrentListingLocationPriorityScope: () => ({ active: false }),
            getListingLocalPriority: () => 0,
            syncMarketplaceViewToggle() {},
            bindMarketplaceItemCarousels() {},
            renderMarketplacePagination() {},
            renderMarketplaceFeedCard(item) {
                return `<article>Posted ${this.formatDate(item.postedDate)}</article>`;
            }
        });
        app.renderMarketplaceItems();
        return Array.from(container.innerHTML.matchAll(/<h4>([^<]+)<\/h4>[\s\S]*?<article>([^<]+)<\/article>/g),
            match => [match[1], match[2]]);
    } finally {
        if (previousTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimeZone;
    }
}

test('A listing from earlier in the Toronto evening stays under Today after UTC midnight', () => {
    const entries = renderListings({ timeZone: 'America/Toronto', now: '2026-11-15T19:22:00-05:00' });
    assert.deepEqual(entries, [['Today', 'Posted 5h ago'], ['November 13, 2026', 'Posted 2 days ago']]);
});

test('A five-hour-old listing belongs to Yesterday after local midnight', () => {
    const entries = renderListings({ timeZone: 'America/Toronto', now: '2026-11-16T00:22:00-05:00' });
    assert.deepEqual(entries[0], ['Yesterday', 'Posted 5h ago']);
});

test('Today follows the local calendar in time zones ahead of UTC', () => {
    const entries = renderListings({ timeZone: 'Asia/Tokyo', now: '2026-11-15T12:22:00+09:00' });
    assert.deepEqual(entries[0], ['Today', 'Posted 5h ago']);
});
