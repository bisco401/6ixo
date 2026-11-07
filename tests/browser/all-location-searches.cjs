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
        let page;
        try {
            page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
            const homeCountry = page.locator('#home-location-country'), home = page.locator('#home-location-city'), homeMenu = page.locator('#area-picker-countries');
            await homeCountry.scrollIntoViewIfNeeded(); await homeCountry.fill('Ghana'); await homeCountry.press('Enter');
            await page.waitForFunction(() => document.getElementById('area-picker').hidden);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'home-location-country', 'Confirming Country does not move focus into optional City');
            assert.equal(await home.inputValue(), '', 'Changing the country clears the old city');
            await page.locator('#home-search-btn').click();
            await page.waitForFunction(() => app.manualDiscoveryLocation?.country === 'Ghana' && app.manualDiscoveryLocation.city === '');
            assert.equal(await home.getAttribute('aria-expanded'), 'false', 'Countrywide search leaves City closed');
            // Search must remain clickable while unconfirmed country suggestions are open.
            await homeCountry.fill('UAE');
            await page.locator('#home-search-btn').click({ delay: 150 });
            await page.waitForFunction(() => app.manualDiscoveryLocation?.country === 'United Arab Emirates' && app.manualDiscoveryLocation.city === '');
            await homeCountry.fill('Ghana'); await homeCountry.press('Enter');
            await page.waitForFunction(() => document.getElementById('area-picker').hidden);
            await home.tap();
            await homeMenu.getByRole('option', { name: /^Accra, Ghana/ }).waitFor();
            assert.equal(await homeMenu.getByRole('option').first().locator('span').textContent(), 'All cities in Ghana');
            assert.equal(await home.inputValue(), '', 'Changing the country clears the old city');
            await homeCountry.fill('Dubai'); await home.focus();
            await homeMenu.getByRole('option', { name: /^Sharjah, United Arab Emirates/ }).waitFor();
            assert.ok((await homeMenu.getByRole('option').allTextContents()).every(label => label.includes('United Arab Emirates')));
            await page.setViewportSize({ width: 390, height: 440 });
            await page.evaluate(() => {
                const input = document.getElementById('home-location-city');
                window.scrollBy(0, input.getBoundingClientRect().top - 120);
                visualViewport.dispatchEvent(new Event('resize'));
            });
            const homeGeometry = await page.evaluate(() => {
                const input = document.getElementById('home-location-city'), menu = document.getElementById('area-picker');
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
            assert.equal(await homeCountry.inputValue(), 'United Arab Emirates');
            // Both visible fields can be autofilled without firing input events.
            await page.evaluate(() => {
                document.getElementById('home-location-country').value = 'Canada';
                document.getElementById('home-location-city').value = 'Toronto';
            });
            assert.equal(await page.evaluate(() => app.resolveHomeLocationAutocomplete()), true);
            assert.equal(await page.evaluate(() => app.manualDiscoveryLocation.city), 'Toronto');
            await home.fill('Dubai, Ghana');
            assert.equal(await page.evaluate(() => app.resolveHomeLocationAutocomplete()), false);
            assert.equal(await page.evaluate(() => app.manualDiscoveryLocation.country), 'Canada', 'Invalid city qualifiers preserve the selected country');
            await home.press('Escape');
            await home.fill('');
            assert.equal(await page.evaluate(() => app.resolveHomeLocationAutocomplete()), true);
            assert.equal(await page.evaluate(() => app.manualDiscoveryLocation.city), '', 'An empty City searches the whole country');
            assert.equal(await page.evaluate(() => app.manualDiscoveryLocation.country), 'Canada');
            const homeRaces = await page.evaluate(async () => {
                const country = document.getElementById('home-location-country'), city = document.getElementById('home-location-city');
                const api = SIXO_LOCATION_AUTOCOMPLETE, search = api.search;
                let finishLookup, signalLookup;
                const lookupStarted = new Promise(resolve => { signalLookup = resolve; });
                api.search = (query, options) => query === 'Toronto' && options?.type === 'city'
                    ? new Promise(resolve => { finishLookup = resolve; signalLookup(); }) : search(query, options);
                let staleIgnored;
                try {
                    city.value = 'Toronto'; city.dispatchEvent(new Event('input', { bubbles: true }));
                    const pending = app.resolveHomeLocationAutocomplete(); await lookupStarted;
                    country.value = 'Ghana'; country.dispatchEvent(new Event('input', { bubbles: true }));
                    finishLookup([{ city: 'Toronto', country: 'Canada', type: 'city' }]);
                    staleIgnored = await pending === false && country.value === 'Ghana' && app.manualDiscoveryLocation.country === 'Canada';
                } finally { api.search = search; }
                const refresh = app.refreshDeviceLocationFeeds;
                let finishFeeds, signalFeeds;
                const feedsStarted = new Promise(resolve => { signalFeeds = resolve; });
                app.refreshDeviceLocationFeeds = () => new Promise(resolve => { finishFeeds = resolve; signalFeeds(); });
                let draftPreserved;
                try {
                    country.value = 'Canada'; country.dispatchEvent(new Event('input', { bubbles: true }));
                    city.value = 'Toronto'; city.dispatchEvent(new Event('input', { bubbles: true }));
                    const pending = app.resolveHomeLocationAutocomplete(); await feedsStarted;
                    city.value = 'Vancouver'; city.dispatchEvent(new Event('input', { bubbles: true }));
                    finishFeeds();
                    draftPreserved = await pending === false && city.value === 'Vancouver' && Boolean(app.homeLocationDraft);
                } finally { app.refreshDeviceLocationFeeds = refresh; }
                await app.resolveHomeLocationAutocomplete();
                return { staleIgnored, draftPreserved, latestCity: app.manualDiscoveryLocation.city };
            });
            assert.ok(homeRaces.staleIgnored && homeRaces.draftPreserved);
            assert.equal(homeRaces.latestCity, 'Vancouver');
            await page.evaluate(() => {
                window.originalHomeLocationRequest = app.requestLocationPermission;
                window.homeLocationRequests = 0;
                app.requestLocationPermission = async () => {
                    window.homeLocationRequests++;
                    app.setHomeLocationControls({ country: 'Canada', city: 'Hamilton', text: 'Hamilton, Canada', auto: true });
                };
            });
            await page.locator('#home-use-location').click();
            await page.waitForFunction(() => document.getElementById('home-location-city').value === 'Hamilton');
            assert.equal(await homeCountry.inputValue(), 'Canada');
            assert.equal(await page.evaluate(() => window.homeLocationRequests), 1);
            assert.equal(await page.evaluate(() => app.resolveHomeLocationAutocomplete()), true);
            assert.equal(await page.evaluate(() => app.manualDiscoveryLocation), null, 'Using GPS must not convert the filled fields into a manual destination');
            await page.evaluate(() => { app.requestLocationPermission = window.originalHomeLocationRequest; });
            await homeCountry.fill('Ghana');
            await homeMenu.getByRole('option', { name: /^Ghana/ }).click();
            await page.waitForFunction(() => document.getElementById('area-picker').hidden);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'home-location-country', 'Tapping a country also leaves City optional');
            await home.tap();
            await homeMenu.getByRole('option', { name: /^Accra, Ghana/ }).waitFor();
            await homeMenu.getByRole('option', { name: /^Accra, Ghana/ }).click();
            const layouts = [];
            for (const width of [320, 390, 1440]) {
                await page.setViewportSize({ width, height: 900 });
                const layout = await page.evaluate(() => {
                    const country = document.getElementById('home-location-country').getBoundingClientRect();
                    const city = document.getElementById('home-location-city').getBoundingClientRect();
                    const search = document.querySelector('#home-content .home-search').getBoundingClientRect();
                    const content = document.getElementById('home-content');
                    const available = content.clientWidth - parseFloat(getComputedStyle(content).paddingLeft) - parseFloat(getComputedStyle(content).paddingRight);
                    return { aligned: Math.abs(country.top - city.top) < 2, stacked: city.top >= country.bottom,
                        fullWidth: search.width >= available - 2, noOverflow: document.documentElement.scrollWidth <= innerWidth,
                        padded: parseFloat(getComputedStyle(document.getElementById('home-location-city')).paddingLeft) >= 10,
                        fieldWidth: country.width, searchWidth: search.width };
                });
                assert.ok(layout.fullWidth && layout.noOverflow && layout.padded, `${width}: ${JSON.stringify(layout)}`);
                assert.ok(width < 360 ? layout.stacked : layout.aligned, `${width}: responsive location fields`);
                layouts.push({ width, ...layout });
                await page.locator('#home-content .home-search').screenshot({ path: path.join(output, `${prefix}-${name}-home-${width}.png`) });
            }
            await page.setViewportSize({ width: 390, height: 844 });
            await page.evaluate(() => { app.browsingLocationReturnScreen = 'marketplace'; });
            await homeCountry.scrollIntoViewIfNeeded(); await homeCountry.fill('Canada'); await homeCountry.press('Enter');
            await page.waitForFunction(() => document.getElementById('area-picker').hidden);
            assert.equal(await page.evaluate(() => app.activeScreen), 'home', 'Country selection leaves time to choose a city');
            await home.tap();
            await homeMenu.getByRole('option', { name: /^All cities in Canada/ }).waitFor();
            await home.fill('Toronto');
            await homeMenu.getByRole('option', { name: /^Toronto, Canada/ }).click();
            await page.waitForFunction(() => app.activeScreen === 'marketplace');

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
            const report = { name, url: base, checks: ['Home country cities', 'Home nearby-city selection', 'Home autofill and countrywide search', 'Home GPS button and scope', 'Home responsive width', 'Arrive city-in-country draft', 'Arrive country-to-city focus', 'country isolation', 'keyboard placement and typing', 'stale suggestions and commits'], homeRaces, layouts, homeGeometry, geometry, errors };
            fs.writeFileSync(path.join(output, `${prefix}-${name}-results.json`), JSON.stringify(report, null, 2));
            console.log(`${name}: Home and Arrive+ location searches passed`);
        } catch (error) {
            if (page) {
                await page.screenshot({ path: path.join(output, `${prefix}-${name}-failure.png`) }).catch(() => {});
                const state = await page.evaluate(() => ({ active: document.activeElement?.id,
                    country: document.getElementById('home-location-country')?.value, city: document.getElementById('home-location-city')?.value,
                    hidden: document.getElementById('area-picker')?.hidden, status: document.getElementById('area-picker-status')?.textContent,
                    options: [...document.querySelectorAll('#area-picker-countries button span')].map(x => x.textContent),
                    selection: window.app?.manualDiscoveryLocation, draft: window.app?.homeLocationDraft })).catch(() => null);
                fs.writeFileSync(path.join(output, `${prefix}-${name}-failure.json`), JSON.stringify(state, null, 2));
                console.error(state);
            }
            throw error;
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
