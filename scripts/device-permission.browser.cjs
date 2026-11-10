// Exercise the browser's Geolocation/Permissions implementation, without
// replacing navigator.geolocation. Playwright supplies test device coordinates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_BASE_URL || 'http://127.0.0.1:8057/';
const output = process.env.LOCATION_TEST_OUTPUT;

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const scenario of process.env.LOCATION_SCENARIOS?.split(',') || ['granted', 'denied-then-enabled']) {
      const context = await browser.newContext({ ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 }, geolocation: { latitude: 43.6532, longitude: -79.3832, accuracy: 15 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => ['image', 'media'].includes(route.request().resourceType())
        && new URL(route.request().url()).origin !== new URL(base).origin ? route.abort() : route.fallback());
      // Test coordinates are never sent to an external provider.
      await page.route('**api.bigdatacloud.net/**', route => route.abort());
      if (scenario === 'granted') {
        await context.grantPermissions(['geolocation'], { origin: new URL(base).origin });
      } else {
        const cdp = await context.newCDPSession(page);
        const { targetInfo } = await cdp.send('Target.getTargetInfo');
        await cdp.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied',
          origin: new URL(base).origin, browserContextId: targetInfo.browserContextId });
      }
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => window.app?.hasRequestedLocationOnLoad);
      if (scenario === 'granted') {
        assert.equal(await page.evaluate(() => !!app.hasBrowserGeolocation), false, 'the site still waits for the visitor to request location');
        if (output) {
          fs.mkdirSync(output, { recursive: true });
          await page.screenshot({ path: path.join(output, 'chrome-device-request.png') });
        }
        await page.locator('[data-location-entry-allow]').click();
      } else {
        await page.waitForFunction(() => app.locationPermissionState === 'denied' && !app.locationRequestInFlight);
        await page.locator('#home-device-location-retry').click();
        await page.waitForFunction(() => app.locationPermissionState === 'denied' && !app.locationRequestInFlight);
        assert.equal(await page.locator('#home-device-location-retry').isEnabled(), true);
        assert.equal(await page.locator('#home-location-permission-help').isVisible(), true);
        await page.locator('#home-location-permission-help summary').click();
        if (output) {
          fs.mkdirSync(output, { recursive: true });
          await page.screenshot({ path: path.join(output, 'chrome-permission-help.png') });
        }
        // Enabling permission must resume the requested device lookup without
        // another tap, a reload, a manual city, or a synthetic JS success callback.
        await context.grantPermissions(['geolocation'], { origin: new URL(base).origin });
      }
      // Deliver a fresh sensor reading after the visitor requests location.
      await context.setGeolocation({ latitude: 43.6532, longitude: -79.3832, accuracy: 15 });
      try {
        await page.waitForFunction(() => app.deviceLocationFeedsReady && !app.locationRequestInFlight, null, { timeout: 30000 });
      } catch (error) {
        console.error(await page.evaluate(() => ({ secure: window.isSecureContext, permission: app.locationPermissionState,
          hasDeviceFix: app.hasBrowserGeolocation, inFlight: app.locationRequestInFlight, status: app.deviceLocationStatus,
          geocodeStatus: app.localGeocodeStatus, resolved: app.getCurrentLocationDisplayText() })));
        throw error;
      }
      assert.match(await page.locator('#home-location-summary').innerText(), /Toronto/);
      assert.equal(await page.evaluate(() => app.currentUserLocationSource), 'device');
      assert.equal(await page.evaluate(() => app.manualDiscoveryLocation == null), true);
      assert.equal(await page.locator('#home-location-recovery').isVisible(), false);
      assert.equal(await page.locator('.location-entry-prompt').isVisible(), false);
      assert.deepEqual(errors, []);
      if (output) {
        await page.locator('#home-location-toggle').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `chrome-device-${scenario}.png`) });
      }
      console.log(`PASS Chrome actual permission API: ${scenario}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
