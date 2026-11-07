const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LOCATION_CHECK_URL || 'http://127.0.0.1:8037/';
const output = process.env.LOCATION_TEST_OUTPUT || path.resolve('output/all-location-searches');
const prefix = base.startsWith('https:') ? 'live' : 'local';
fs.mkdirSync(output, { recursive: true });

(async () => {
    for (const [name, engine, options] of [
        ['safari', webkit, process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}],
        ['chrome', chromium, { channel: 'chrome' }]
    ]) {
        if (process.env.BROWSER_ONLY && process.env.BROWSER_ONLY !== name) continue;
        const browser = await engine.launch({ headless: true, ...options });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
            page.setDefaultTimeout(30000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/coming-soon-config.js*', route => route.fulfill({ contentType: 'application/javascript', body: 'window.SIXO_COMING_SOON_CONFIG={enabled:false};' }));
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.app && document.getElementById('country-filter-autocomplete'));
            await page.evaluate(async () => {
                app.stopLocationTracking();
                // This check exercises location controls without refreshing all listing feeds.
                app.refreshDeviceLocationFeeds = async () => {};
                await app.applyManualDiscoveryLocation({ country: 'Canada', city: 'Hamilton' });
                document.querySelector('[data-location-entry-dismiss]')?.click();
                app.switchScreen('home');
            });
            const home = page.locator('#home-search-location'), homeMenu = page.locator('#area-picker-countries');
            await home.scrollIntoViewIfNeeded(); await home.fill('Ghana');
            await homeMenu.getByRole('option', { name: /^Accra, Ghana/ }).waitFor();
            assert.equal(await homeMenu.getByRole('option').first().locator('span').textContent(), 'Ghana');
            await home.fill('Dubai');
            await homeMenu.getByRole('option', { name: /^Sharjah, United Arab Emirates/ }).waitFor();
            assert.ok((await homeMenu.getByRole('option').allTextContents()).every(label => label.includes('United Arab Emirates')));
            await page.setViewportSize({ width: 390, height: 440 });
            await page.evaluate(() => {
                const input = document.getElementById('home-search-location');
                window.scrollBy(0, input.getBoundingClientRect().top - 120);
                visualViewport.dispatchEvent(new Event('resize'));
            });
            const homeGeometry = await page.evaluate(() => {
                const input = document.getElementById('home-search-location'), menu = document.getElementById('area-picker');
                const rect = input.getBoundingClientRect(), box = menu.getBoundingClientRect();
                return { clear: box.bottom <= rect.top || box.top >= rect.bottom,
                    fits: box.top >= 0 && box.bottom <= visualViewport.height,
                    visible: getComputedStyle(menu).visibility === 'visible',
                    tappable: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === input };
            });
            assert.ok(Object.values(homeGeometry).every(Boolean), JSON.stringify(homeGeometry));
            await page.screenshot({ path: path.join(output, `${prefix}-${name}-home.png`) });
            await homeMenu.getByRole('option', { name: /^Ajman, United Arab Emirates/ }).click();
            await page.waitForFunction(() => app.manualDiscoveryLocation?.city === 'Ajman');
            assert.equal(await page.evaluate(() => app.manualDiscoveryLocation.country), 'United Arab Emirates');
            await page.setViewportSize({ width: 390, height: 844 });

            await page.evaluate(async () => {
                app.switchScreen('arrive');
                const controller = SIXO_ARRIVE_DISCOVERY.mount(app);
                await controller.store.ready;
                controller.clearDestination('country');
            });
            const country = page.locator('#arrive-discovery-country'), countrySearch = page.locator('#arrive-discovery-country-search');
            const city = page.locator('#arrive-discovery-city'), cityMenu = page.locator('#arrive-discovery-city-options');
            await country.scrollIntoViewIfNeeded(); await country.click(); await countrySearch.fill('Dubai');
            await page.locator('#arrive-discovery-country-options').getByRole('option', { name: /^Dubai, United Arab Emirates/ }).waitFor();
            // A visitor can move directly from an unconfirmed city in Country into City.
            await city.tap();
            await page.waitForFunction(() => document.getElementById('arrive-discovery-country').value === 'United Arab Emirates');
            await cityMenu.getByRole('option', { name: 'Ajman', exact: true }).waitFor();
            assert.equal(await cityMenu.getByRole('option').first().textContent(), 'Dubai');
            await cityMenu.getByRole('option', { name: 'Sharjah', exact: true }).click();
            assert.equal(await city.inputValue(), 'Sharjah');
            assert.equal(await country.inputValue(), 'United Arab Emirates');

            await country.click(); await countrySearch.fill('Ghana'); await countrySearch.press('Enter');
            await page.waitForFunction(() => document.activeElement?.id === 'arrive-discovery-city' && document.getElementById('arrive-discovery-country').value === 'Ghana');
            await cityMenu.getByRole('option', { name: 'Accra', exact: true }).waitFor();
            assert.equal(await city.inputValue(), '');
            assert.equal(await cityMenu.getByRole('option', { name: 'Sharjah', exact: true }).count(), 0);

            // Model the reduced space above a mobile keyboard, retaining a visible input.
            await page.setViewportSize({ width: 390, height: 440 });
            await page.evaluate(() => {
                const input = document.getElementById('arrive-discovery-city');
                window.scrollBy(0, input.getBoundingClientRect().top - 260);
                visualViewport.dispatchEvent(new Event('resize'));
            });
            const geometry = await page.evaluate(() => {
                const input = document.getElementById('arrive-discovery-city'), menu = document.getElementById('arrive-discovery-city-options');
                const rect = input.getBoundingClientRect(), box = menu.getBoundingClientRect();
                return { clear: box.bottom <= rect.top || box.top >= rect.bottom,
                    fits: box.top >= 0 && box.bottom <= visualViewport.height,
                    visible: getComputedStyle(menu).visibility === 'visible',
                    tappable: document.elementFromPoint(rect.left + 20, rect.top + rect.height / 2) === input };
            });
            assert.ok(Object.values(geometry).every(Boolean), JSON.stringify(geometry));
            await page.screenshot({ path: path.join(output, `${prefix}-${name}-arrive.png`) });
            await city.fill('Kumasi');
            await cityMenu.getByRole('option', { name: 'Kumasi', exact: true }).click();
            assert.equal(await city.inputValue(), 'Kumasi');

            const stale = await page.evaluate(async () => {
                const controller = SIXO_ARRIVE_DISCOVERY.mount(app), api = SIXO_LOCATION_AUTOCOMPLETE;
                const original = api.search;
                let finish;
                api.search = (query, options) => query === 'Dubai' ? new Promise(resolve => { finish = resolve; }) : original(query, options);
                try {
                    controller.countrySearch.value = 'Dubai';
                    const pending = controller.showPicker('country');
                    controller.selectDestination('country', 'Canada');
                    finish([{ city: 'Dubai', region: 'Dubai', country: 'United Arab Emirates', label: 'Dubai, United Arab Emirates', type: 'city', exact: true }]);
                    await pending;
                    const suggestionsIgnored = controller.fields.country.value === 'Canada' && document.getElementById('arrive-discovery-country-options').hidden;
                    controller.countrySearch.value = 'Dubai';
                    const settling = controller.settleCountryText({ advanceToCity: true });
                    controller.selectDestination('country', 'Ghana');
                    finish([{ city: 'Dubai', region: 'Dubai', country: 'United Arab Emirates', label: 'Dubai, United Arab Emirates', type: 'city', exact: true }]);
                    await settling;
                    return suggestionsIgnored && controller.fields.country.value === 'Ghana';
                } finally { api.search = original; }
            });
            assert.ok(stale, 'Older city lookups cannot overwrite a newer destination');
            assert.deepEqual(errors, []);
            const report = { name, url: base, checks: ['Home country cities', 'Home nearby-city selection', 'Arrive city-in-country draft', 'Arrive country-to-city focus', 'country isolation', 'keyboard placement and typing', 'stale suggestions and commits'], homeGeometry, geometry, errors };
            fs.writeFileSync(path.join(output, `${prefix}-${name}-results.json`), JSON.stringify(report, null, 2));
            console.log(`${name}: Home and Arrive+ location searches passed`);
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
