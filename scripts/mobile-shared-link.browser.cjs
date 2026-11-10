// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_BASE_URL || 'http://127.0.0.1:8057/';
const safari = process.env.BROWSER === 'webkit';
const output = process.env.LOCATION_TEST_OUTPUT;

(async () => {
  const browser = await (safari ? webkit : chromium).launch({ headless: true,
    ...(safari ? (process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) : { channel: 'chrome' }) });
  try {
    const scenarios = process.env.LOCATION_SCENARIOS?.split(',') || ['granted', 'worldwide', 'denied', 'silent', 'unsupported', 'dismissed', 'early-choice'];
    for (const scenario of scenarios) {
      const mode = ['whatsapp', 'instagram', 'settings-retry'].includes(scenario) ? 'denied' : ['snapchat', 'tiktok'].includes(scenario) ? 'silent' : scenario;
      const device = safari ? devices['iPhone 13'] : devices['Pixel 7'];
      const page = await browser.newPage({ ...device,
        userAgent: device.userAgent + (scenario === 'whatsapp' ? ' WhatsApp/2.26.1' : scenario === 'snapchat' ? ' Snapchat/13.0' : scenario === 'instagram' ? ' Instagram 360.0' : scenario === 'tiktok' ? ' BytedanceWebview TikTok/40.0' : ''),
        viewport: { width: scenario === 'unsupported' ? 320 : 390, height: 844 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Unrelated external listing media must not contend with location tests.
      await page.route('**/*', route => ['image', 'media'].includes(route.request().resourceType())
        && new URL(route.request().url()).origin !== new URL(base).origin ? route.abort() : route.fallback());
      // Never send synthetic coordinates to an external location provider.
      await page.route('**api.bigdatacloud.net/**', route => {
        const url = new URL(route.request().url());
        return route.fulfill({ json: { latitude: Number(url.searchParams.get('latitude')),
          longitude: Number(url.searchParams.get('longitude')), lookupSource: 'coordinates',
          countryCode: 'KE', countryName: 'Kenya', city: 'Nairobi', locality: 'Nairobi', principalSubdivision: 'Nairobi County' } });
      });
      await page.addInitScript(mode => {
        window.testLocationMode = mode;
        const callbacks = window.testLocationCallbacks = [];
        const sample = () => ({ coords: { latitude: mode === 'worldwide' ? -1.2921 : 43.6532,
          longitude: mode === 'worldwide' ? 36.8219 : -79.3832, accuracy: 15 }, timestamp: Date.now() });
        const geo = { getCurrentPosition(success, error) {
          callbacks.push(() => success(sample()));
          if (window.testLocationMode === 'granted' || window.testLocationMode === 'worldwide') setTimeout(() => success(sample()), 50);
          else if (window.testLocationMode === 'denied') setTimeout(() => error({ code: 1, message: 'Location blocked' }), 50);
        }, watchPosition() { return 1; }, clearWatch() {} };
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: mode === 'unsupported' ? undefined : geo });
        // Cover browsers without the Permissions API, including older Safari.
        Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
      }, mode);
      let releaseApp;
      if (scenario === 'early-choice') {
        const gate = new Promise(resolve => { releaseApp = resolve; });
        await page.route('**/app.js*', async route => { await gate; await route.continue(); });
      }
      const navigation = page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (scenario === 'early-choice') {
        await page.locator('[data-location-entry-manual]').click();
        releaseApp();
      }
      await navigation;
      await page.waitForFunction(() => window.app && document.getElementById('home-search-location').dataset.boundAreaPicker === '1');
      const assertPublicBrowsing = async () => {
        await page.waitForFunction(() => document.querySelectorAll('#home-listings-grid .home-card-item').length > 0);
        assert.equal(await page.locator('.location-entry-prompt').isVisible(), false, 'GPS must not reopen a popup over listings');
        assert.equal(await page.locator('#home-listings-grid').isVisible(), true, 'real inventory is visible before any city selection');
        assert.equal(await page.locator('#home-listings-grid').evaluate(el => !!el.closest('[inert]')), false);
        assert.equal(await page.locator('#home-location-summary').innerText(), 'All locations');
        assert.equal(await page.evaluate(() => app.getDeviceListingLocationScope().source), 'worldwide');
        assert.equal(await page.evaluate(() => app.manualDiscoveryLocation == null), true, 'browsing does not invent a selected city');
        await page.locator('[data-home-category="electronics"]').click();
        await page.waitForFunction(() => app.activeScreen === 'electronics' && document.querySelectorAll('#electronics-items [data-id]').length > 0);
        assert.equal(await page.locator('#electronics-items').isVisible(), true, 'category browsing works without GPS');
        assert.ok(Number(await page.locator('#electronics-items').getAttribute('data-feed-visible-count')) <= 48, 'the first mobile render is bounded');
        if (scenario === 'whatsapp' && await page.locator('#electronics-items [data-feed-load-more]').count()) {
          await page.locator('#electronics-items [data-feed-load-more]').click();
          await page.waitForFunction(() => Number(document.getElementById('electronics-items').dataset.feedVisibleCount) > 48);
        }
        if (output) {
          fs.mkdirSync(output, { recursive: true });
          await page.locator('#electronics-items').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(output, `${safari ? 'safari' : 'chrome'}-${scenario}-without-gps.png`) });
        }
        await page.locator('.bottom-nav [data-screen="home"]').click();
      };
      const retryLocation = async () => {
        if (await page.locator('#home-device-location-retry').isVisible()) {
          await page.locator('#home-device-location-retry').click();
          return;
        }
        if (!await page.locator('#home-location-panel').isVisible()) await page.locator('#home-location-toggle').click();
        await page.locator('#home-use-location').click();
      };
      if (scenario === 'settings-retry') {
        await page.locator('[data-location-entry-allow]').click();
        await page.waitForFunction(() => app.locationPermissionState === 'denied');
        assert.equal(await page.evaluate(() => testLocationCallbacks.length), 1, 'denial does not trigger an automatic retry loop');
        await assertPublicBrowsing();
        const requestsBeforeRetry = await page.evaluate(() => testLocationCallbacks.length);
        await retryLocation();
        await page.waitForFunction(before => testLocationCallbacks.length === before + 1 && !app.locationRequestInFlight, requestsBeforeRetry);
        assert.equal(await page.evaluate(() => app.locationPermissionState), 'denied', 'another tap cannot grant browser permission');
        await page.evaluate(() => { window.testLocationMode = 'granted'; });
        await retryLocation();
        await page.waitForFunction(() => app.deviceLocationFeedsReady && !app.locationRequestInFlight);
        assert.match(await page.locator('#home-location-summary').innerText(), /Toronto/);
        assert.equal(await page.locator('.location-entry-prompt').isVisible(), false);
        assert.equal(await page.evaluate(() => app.manualDiscoveryLocation), null);
      } else if (scenario === 'granted' || scenario === 'worldwide') {
        await page.locator('[data-location-entry-allow]').click();
        await page.waitForFunction(() => app.deviceLocationFeedsReady, null, { timeout: 30000 });
        assert.match(await page.locator('#home-location-summary').innerText(), scenario === 'granted' ? /Toronto/ : /Nairobi/);
        assert.equal(await page.locator('#home-location-recovery').isVisible(), false);
        assert.equal(await page.locator('#home-featured-ads-strip').isVisible(), true);
        assert.equal(await page.evaluate(() => app.manualDiscoveryLocation), null);
      } else {
        if (mode === 'denied' || mode === 'silent') {
          await page.locator('[data-location-entry-allow]').click();
          if (mode === 'denied') {
            await page.waitForFunction(() => app.locationPermissionState === 'denied');
          } else {
            await page.waitForFunction(() => app.locationRequestInFlight);
            assert.match(await page.locator('#home-location-recovery-message').innerText(), /browse all listings now/);
            assert.equal(await page.locator('.home-seo-hub').evaluate(element => element.inert), false, 'public category and country links remain usable without GPS');
            if (output) {
              fs.mkdirSync(output, { recursive: true });
              await page.locator('#home-location-recovery').scrollIntoViewIfNeeded();
              await page.screenshot({ path: path.join(output, `${safari ? 'safari' : 'chrome'}-waiting.png`) });
            }
          }
        } else if (scenario === 'dismissed') {
          await page.locator('[data-location-entry-dismiss]').click();
        } else if (scenario === 'unsupported') {
          assert.equal(await page.locator('[data-location-entry-allow]').isDisabled(), true);
          await page.locator('[data-location-entry-dismiss]').click();
        }
        if (scenario !== 'early-choice') {
          await assertPublicBrowsing();
          await page.locator('#home-location-toggle').click();
        }
        assert.equal(await page.locator('#home-location-panel').isVisible(), true, `${scenario}: opens country/city fields`);
        await page.locator('#home-location-country').fill('Canada');
        await page.locator('#area-picker-countries').getByRole('option', { name: 'Canada Country', exact: true }).click();
        await page.locator('#home-location-city').fill('Toronto');
        await page.locator('#area-picker-countries').getByRole('option', { name: /^Toronto, ON Canada/ }).click();
        await page.locator('#home-location-apply').click();
        await page.waitForFunction(() => app.deviceLocationFeedsReady && app.manualDiscoveryLocation?.city === 'Toronto');
        assert.equal(await page.locator('#home-featured-ads-strip').isVisible(), true);
        assert.equal(await page.locator('#home-location-recovery').isVisible(), false);
        await page.evaluate(() => { for (const callback of window.testLocationCallbacks) callback(); });
        assert.equal(await page.evaluate(() => app.manualDiscoveryLocation?.city), 'Toronto', 'late GPS cannot overwrite the selected city');
        assert.equal(await page.evaluate(() => app.locationRequestInFlight), false);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'mobile layout must fit the screen');
      assert.deepEqual(errors, [], `${scenario}: no uncaught JavaScript errors`);
      if (output) {
        fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, `${safari ? 'safari' : 'chrome'}-${scenario}.png`) });
      }
      console.log(`PASS ${safari ? 'Safari' : 'Chrome'}: ${scenario}`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
