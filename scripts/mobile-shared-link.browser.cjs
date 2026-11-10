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
      const mode = scenario === 'whatsapp' ? 'denied' : scenario === 'snapchat' ? 'silent' : scenario;
      const device = safari ? devices['iPhone 13'] : devices['Pixel 7'];
      const page = await browser.newPage({ ...device,
        userAgent: device.userAgent + (scenario === 'whatsapp' ? ' WhatsApp/2.26.1' : scenario === 'snapchat' ? ' Snapchat/13.0' : ''),
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
        const callbacks = window.testLocationCallbacks = [];
        const sample = () => ({ coords: { latitude: mode === 'worldwide' ? -1.2921 : 43.6532,
          longitude: mode === 'worldwide' ? 36.8219 : -79.3832, accuracy: 15 }, timestamp: Date.now() });
        const geo = { getCurrentPosition(success, error) {
          callbacks.push(() => success(sample()));
          if (mode === 'granted' || mode === 'worldwide') setTimeout(() => success(sample()), 50);
          else if (mode === 'denied') setTimeout(() => error({ code: 1, message: 'Location blocked' }), 50);
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
      if (scenario === 'granted' || scenario === 'worldwide') {
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
            await page.locator('[data-location-entry-manual]').click();
          } else {
            await page.waitForFunction(() => app.locationRequestInFlight);
            assert.match(await page.locator('#home-location-recovery-message').innerText(), /Waiting/);
            assert.equal(await page.locator('.home-seo-hub').evaluate(element => element.inert), false, 'public category and country links remain usable without GPS');
            if (output) {
              fs.mkdirSync(output, { recursive: true });
              await page.locator('#home-location-recovery').scrollIntoViewIfNeeded();
              await page.screenshot({ path: path.join(output, `${safari ? 'safari' : 'chrome'}-waiting.png`) });
            }
            await page.locator('#home-location-choose').click();
          }
        } else if (scenario === 'dismissed') {
          await page.locator('[data-location-entry-dismiss]').click();
          assert.equal(await page.locator('#home-location-recovery').isVisible(), true);
          await page.locator('#home-location-choose').click();
        } else if (scenario === 'unsupported') {
          assert.equal(await page.locator('[data-location-entry-allow]').isDisabled(), true);
          await page.locator('[data-location-entry-manual]').click();
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
