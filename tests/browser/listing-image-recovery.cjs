const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_BASE_URL || 'http://127.0.0.1:8036';
const root = path.resolve(__dirname, '../..');
(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/__image-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div class="featured-ad-card"><div class="image-carousel" data-gallery-photos=\'["/missing-one.jpg","/test-good.svg"]\'><div class="carousel-track"><img id="initial" src="/missing-one.jpg"></div></div></div><img id="unrelated" src="/missing-logo.jpg">' }));
        await page.route('**/missing-*.jpg', route => route.fulfill({ status: 404, body: '' }));
        await page.route('**/test-good.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#4067a0"/></svg>' }));
        await page.goto(base + '/__image-test');
        await page.waitForFunction(() => document.querySelector('#initial').complete);
        await page.addScriptTag({ path: path.join(root, 'assets/listing-image-recovery.js') });
        await page.waitForFunction(() => document.querySelector('#initial').naturalWidth === 640);
        assert.ok((await page.locator('#initial').getAttribute('src')).endsWith('/test-good.svg'));
        assert.equal(await page.locator('#unrelated').getAttribute('src'), '/missing-logo.jpg');
        await page.evaluate(() => {
            const card = document.createElement('div');
            card.className = 'home-card-item';
            card.dataset.images = ['/missing-two.jpg', '/test-good.svg'].map(encodeURIComponent).join('|');
            card.innerHTML = '<img id="dynamic" class="home-card-img" src="/missing-two.jpg">';
            document.body.append(card);
            const allBad = document.createElement('div');
            allBad.className = 'jobs-feed-image';
            allBad.innerHTML = '<img id="all-bad" src="/missing-three.jpg">';
            document.body.append(allBad);
        });
        await page.waitForFunction(() => document.querySelector('#dynamic').naturalWidth === 640 && document.querySelector('#all-bad').naturalWidth === 800);
        assert.ok((await page.locator('#all-bad').getAttribute('src')).endsWith('/assets/listing-photo-unavailable.svg'));
        // A recycled card must retry its new source instead of retaining the previous failed state.
        await page.locator('#all-bad').evaluate(image => { image.src = '/test-good.svg'; });
        await page.waitForFunction(() => document.querySelector('#all-bad').naturalWidth === 640);
        await page.evaluate(() => {
            const modal = document.createElement('div');
            modal.id = 'marketplace-item-track';
            modal.innerHTML = '<div class="gt-photo-track"><img id="modal" src="/missing-four.jpg"></div>';
            document.body.append(modal);
            window.app = { resolveSitewideListingImageContext: () => ({ sources: ['/missing-four.jpg', '/test-good.svg'] }) };
            document.querySelector('#modal').addEventListener('error', event => { event.target.src = '/missing-old-placeholder.jpg'; });
        });
        await page.waitForFunction(() => document.querySelector('#modal').naturalWidth === 640);
        // Requests rejected because of Referer get one retry; an unavailable CDN never loops.
        const requests = [];
        await page.route('https://provider.test/**', route => {
            requests.push(route.request().url());
            return route.fulfill({ status: 403, body: '' });
        });
        await page.evaluate(() => {
            window.app = undefined;
            const image = document.createElement('img'); image.id = 'blocked'; image.className = 'home-card-img';
            image.src = 'https://provider.test/blocked.jpg'; document.body.append(image);
        });
        await page.waitForFunction(() => document.querySelector('#blocked').naturalWidth === 800);
        assert.equal(requests.length, 2, 'one retry, then a local fallback');
        // Cached covers stay available even when the original provider is completely offline.
        await page.route('https://storage.albacars.ae/**', route => route.abort());
        await page.evaluate(() => {
            const image = document.createElement('img'); image.id = 'dubai'; image.className = 'home-card-img';
            image.src = 'https://storage.albacars.ae/vehicles/drafts/2332/1.jpg?format=auto'; document.body.append(image);
        });
        await page.waitForFunction(() => document.querySelector('#dubai').naturalWidth === 1200);
        assert.ok((await page.locator('#dubai').getAttribute('src')).includes('/data/listing-image-cache/'));
        assert.deepEqual(errors, []);
        console.log('PASS: initial and dynamic cards, gallery recovery, unavailable photos, recycled nodes, modal handlers, bounded retries, cached Dubai cover.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
