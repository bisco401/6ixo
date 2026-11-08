const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PROFILE_CHECK_URL || 'http://127.0.0.1:8078/';
const photos = [
    '/assets/tonaton-honda-crv-2019.webp', '/assets/vehicles/ferrari-blue-studio.jpg',
    '/assets/realestate/property-stays-background.jpg', '/assets/rolls-royce-cullinan-hero.jpg'
];
const cases = [
    ['vehicle', 'vehicle-modal', 'openVehicleModal', 'closeVehicleModal', '#vehicle-modal-image', '#vehicle-media-thumbs', '#vehicle-media-next'],
    ['property', 'realestate-modal', 'openRealestateModal', 'closeRealestateModal', '#realestate-modal-image', '#realestate-media-thumbs', '#realestate-media-next'],
    ['service', 'service-modal', 'openServiceModal', 'closeServiceModal', '#service-modal-image', '#service-modal-thumbs', '#service-media-next'],
    ['personal', 'profile-modal', 'openProfileModal', 'closeProfileModal', '#profile-modal-photo', '#profile-modal-gallery', '#profile-photo-next'],
    ['demo', 'demo-profile-modal', 'openDemoProfileObject', 'closeDemoProfile', '#demo-profile-photo', '#demo-profile-gallery-strip', '.cb-profile-next'],
    ['seller', 'seller-profile-modal', 'openSellerProfileModal', 'closeSellerProfileModal', '#seller-profile-luxury-image', '#seller-profile-luxury-thumbs', '#seller-profile-luxury-next'],
    ['featured', 'luxury-ad-modal', 'openLuxuryAdModal', 'closeLuxuryAdModal', '.native-photo-track > img', '#luxury-ad-thumbs', '#luxury-ad-next'],
    ['promoted profile', 'luxury-ad-modal', 'openLuxuryAdModal', 'closeLuxuryAdModal', '.native-photo-track > img', '#luxury-ad-thumbs', '#luxury-ad-next'],
    ['marketplace', 'marketplace-item-modal', 'openMarketplaceItemModal', 'closeMarketplaceItemModal', '.gt-photo-slide img', '#marketplace-item-thumbs', '#marketplace-item-next'],
    ['short stay', 'realestate-modal', 'openRealestateModal', 'closeRealestateModal', '#realestate-modal-image', '#realestate-media-thumbs', '#realestate-media-next']
];

(async () => {
    for (const [name, engine, options] of [
        ['chrome', chromium, { channel: 'chrome' }],
        ['safari', webkit, process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}]
    ]) {
        if (process.env.BROWSER_ONLY && process.env.BROWSER_ONLY !== name) continue;
        const browser = await engine.launch({ headless: true, ...options });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            // Keep production scripts/layouts; isolate inventory and remote services from gesture checks.
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                return url.origin === new URL(base).origin && !url.pathname.startsWith('/data/') ? route.continue() : route.abort();
            });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.app && window.configureListingGalleryTabs);
            await page.evaluate(() => document.querySelector('[data-location-entry-dismiss]')?.click());
            const cdp = name === 'chrome' ? await page.context().newCDPSession(page) : null;
            async function swipe(selector, direction, { vertical = false, short = false } = {}) {
                const box = await page.locator(selector).boundingBox();
                assert.ok(box && box.width > 100, 'gesture target is visible');
                const x = Math.max(30, box.x + box.width * (direction < 0 ? .7 : .3));
                const y = Math.max(10, box.y + Math.min(box.height * .35, 80));
                const endX = vertical ? x : x + direction * (short ? 24 : box.width * .4);
                const endY = y + (vertical ? 60 : 0);
                if (cdp) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
                    for (let i = 1; i <= 5; i++) {
                        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (endX - x) * i / 5, y: y + (endY - y) * i / 5, id: 1 }] });
                    }
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                } else {
                    // WebKit's automation API lacks native drag touch; bubble the Safari touch lifecycle through the actual DOM.
                    await page.evaluate(({ selector, x, y, endX, endY }) => {
                        const target = document.querySelector(selector);
                        const emit = (type, clientX, clientY) => {
                            const point = { identifier: 1, target, clientX, clientY };
                            const event = new Event(type, { bubbles: true, cancelable: true });
                            Object.defineProperties(event, {
                                touches: { value: type === 'touchend' ? [] : [point] },
                                changedTouches: { value: [point] }
                            });
                            target.dispatchEvent(event);
                        };
                        emit('touchstart', x, y);
                        for (let i = 1; i <= 5; i++) emit('touchmove', x + (endX - x) * i / 5, y + (endY - y) * i / 5);
                        emit('touchend', endX, endY);
                    }, { selector, x, y, endX, endY });
                }
            }
            for (const [label, modalId, open, close, image, thumbs, next] of cases) {
                const modal = '#' + modalId;
                async function openCard(count = 4) {
                    // Deliberately bypass category feeds: Home/search/Arrive can open cards before those feeds bind controls.
                    await page.evaluate(({ open, label, photos, count }) => {
                        const images = photos.slice(0, count);
                        const record = { id: 'gesture-fixture', title: 'Gallery test', name: 'Gallery test', category: 'vehicles', price: 123,
                            photos: images, images, galleryImages: images, photo: images[0], image: images[0],
                            description: 'Profile gallery description. '.repeat(20), desc: 'Profile gallery description. '.repeat(20) };
                        if (label === 'short stay') Object.assign(record, { listingType: 'for_rent_short', priceTerm: 'per_night' });
                        if (label === 'promoted profile') record.sourceType = 'companionship';
                        app[open](record);
                    }, { open, label, photos, count });
                    await page.locator(modal).waitFor({ state: 'visible' });
                }
                let currentIndex = 0;
                const strip = ['featured', 'promoted profile', 'marketplace'].includes(label);
                const imageSelector = () => modal + ' ' + image + (strip ? `:nth-child(${currentIndex + 1})` : '');
                // Marketplace slides have one image each, so select their wrapper instead.
                const target = () => label === 'marketplace' ? `${modal} .gt-photo-slide:nth-child(${currentIndex + 1}) img` : imageSelector();
                async function check(index) {
                    currentIndex = index;
                    assert.equal(await page.locator(modal).isVisible(), true, `${label}: photo swipe keeps profile open`);
                    assert.equal(await page.locator('#media-lightbox').isVisible(), false, `${label}: swipe does not open fullscreen`);
                    await page.waitForFunction(({ selector, src }) => {
                        const img = document.querySelector(selector);
                        return img && new URL(img.getAttribute('src'), location.href).href === new URL(src, location.href).href;
                    }, { selector: target(), src: photos[index] });
                    if (strip) await page.waitForFunction(selector => {
                        const box = document.querySelector(selector).getBoundingClientRect();
                        return Math.abs(box.x) < 2 && Math.abs(box.width - innerWidth) < 2;
                    }, target());
                }
                await openCard();
                await check(0);
                await page.locator(thumbs + ' button').nth(1).tap(); await check(1);
                await swipe(target(), -1); await check(0);
                await swipe(target(), 1); await check(1);
                await swipe(target(), -1); await check(0);
                await swipe(target(), -1); await check(3);
                await swipe(target(), 1); await check(0);
                await swipe(target(), -1, { short: true }); await check(0);
                await swipe(target(), 1, { vertical: true }); await check(0);
                await page.locator(modal + ' ' + next).tap(); await check(1);
                await page.evaluate(close => app[close]({ useHistory: false }), close);
                await openCard(); await check(0);
                await swipe(target(), 1); await check(1); // Reopening must not duplicate handlers.
                await page.evaluate(close => app[close]({ useHistory: false }), close);
                await openCard(1); await check(0);
                await swipe(target(), -1); await check(0);
                await swipe(target(), 1); await check(0);
                await page.evaluate(close => app[close]({ useHistory: false }), close);
                console.log(`PASS ${name}: ${label}, both directions, wrapping, controls, reopening, single photo, profile stays open`);
            }
            assert.deepEqual(errors, []);
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
