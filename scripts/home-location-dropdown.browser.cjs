const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_BASE_URL || 'http://127.0.0.1:8047/';
const output = process.env.LOCATION_TEST_OUTPUT;
(async () => {
  const safari = process.env.BROWSER === 'webkit';
  const browser = await (safari ? webkit : chromium).launch({ headless: true,
    ...(safari ? (process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // Unrelated listing photos must not contend with location fixture requests.
    await page.route('**/*', route => ['image', 'media'].includes(route.request().resourceType()) ? route.abort() : route.fallback());
    await page.route('**/coming-soon-config.js*', route => route.fulfill({ contentType: 'application/javascript', body: 'window.SIXO_COMING_SOON_CONFIG={enabled:false};' }));
    await page.goto(base, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.app && document.getElementById('home-search-location').dataset.boundAreaPicker === '1');
    await page.evaluate(async () => {
      app.stopLocationTracking();
      app.refreshDeviceLocationFeeds = async () => {};
      await app.applyManualDiscoveryLocation({ country: 'Canada', city: 'Hamilton' });
      document.querySelector('[data-location-entry-dismiss]')?.click();
      app.switchScreen('home');
    });
    const toggle = page.locator('#home-location-toggle');
    const panel = page.locator('#home-location-panel');
    const country = page.locator('#home-location-country');
    const city = page.locator('#home-location-city');
    const options = page.locator('#area-picker-countries');
    const apply = page.locator('#home-location-apply');
    const selected = () => page.evaluate(() => ({ ...app.manualDiscoveryLocation }));
    await page.waitForFunction(() => document.getElementById('home-location-summary').textContent === 'Hamilton, ON Canada');
    assert.equal(await panel.isVisible(), false, 'dropdown starts collapsed');
    await toggle.click();
    assert.equal(await panel.isVisible(), true);
    await country.fill('USA');
    await options.getByRole('option', { name: 'United States Country', exact: true }).click();
    assert.equal(await city.inputValue(), '');
    await city.fill('Atlanta');
    await options.getByRole('option', { name: 'Atlanta, GA USA Georgia', exact: true }).click();
    assert.equal((await selected()).city, 'Hamilton', 'city selection remains a draft until Apply');
    await apply.click();
    await page.waitForFunction(() => document.getElementById('home-location-summary').textContent === 'Atlanta, GA USA');
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.evaluate(() => app.matchesListingLocationScope({ city: 'Atlanta', country: 'United States' }, app.getDeviceListingLocationScope())), true, 'region labels retain listings with city/country only');
    await toggle.click();
    await country.fill('Canada');
    await options.getByRole('option', { name: 'Canada Country', exact: true }).click();
    await city.fill('Toronto');
    await options.getByRole('option', { name: 'Toronto, ON Canada Ontario', exact: true }).click();
    await page.locator('#home-location-cancel').click();
    assert.equal((await selected()).city, 'Atlanta', 'Cancel preserves applied location');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await country.inputValue(), 'United States');
    assert.equal(await city.inputValue(), 'Atlanta');
    await city.fill('Dubai, Ghana');
    await apply.click();
    await page.waitForFunction(() => document.getElementById('home-location-city').getAttribute('aria-invalid') === 'true');
    assert.equal((await selected()).city, 'Atlanta', 'invalid country/city pair is not applied');
    await city.press('Escape');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    await toggle.click();
    await city.fill('');
    await apply.click();
    await page.waitForFunction(() => document.getElementById('home-location-summary').textContent === 'USA');
    assert.equal((await selected()).city, '', 'blank City searches whole country');
    assert.equal((await selected()).region, '', 'countrywide choice clears previous state');
    await toggle.click();
    await country.fill('Ghana');
    await options.getByRole('option', { name: 'Ghana Country', exact: true }).click();
    await city.fill('Accra');
    await options.getByRole('option', { name: /^Accra, Greater Accra Ghana/ }).click();
    await apply.click();
    await page.waitForFunction(() => document.getElementById('home-location-summary').textContent === 'Accra, Greater Accra Ghana');
    assert.equal(await page.evaluate(() => app.matchesListingLocationScope({ city: 'Accra', country: 'Ghana' }, app.getDeviceListingLocationScope())), true);
    // An untouched automatic label must stay automatic after opening and applying.
    const gps = await page.evaluate(async () => {
      const original = app.applyManualDiscoveryLocation;
      const selection = app.getHomeSearchLocationSelection;
      let calls = 0;
      app.getHomeSearchLocationSelection = () => ({ country: 'Canada', city: 'Hamilton', region: 'Ontario', text: 'Hamilton, Ontario, Canada' });
      app.manualDiscoveryLocation = null;
      document.getElementById('home-search-location').value = 'Hamilton, Ontario, Canada';
      await Promise.resolve();
      app.applyManualDiscoveryLocation = () => { calls++; };
      document.getElementById('home-location-toggle').click();
      await app.resolveHomeLocationAutocomplete();
      app.applyManualDiscoveryLocation = original;
      app.getHomeSearchLocationSelection = selection;
      return { calls, manual: app.manualDiscoveryLocation };
    });
    assert.equal(gps.calls, 0);
    assert.equal(gps.manual, null);
    await page.evaluate(() => app.applyManualDiscoveryLocation({ country: 'Canada', city: 'Hamilton', region: 'Ontario' }));
    const layouts = [];
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if (await panel.isVisible()) await page.locator('#home-location-cancel').click();
      await toggle.scrollIntoViewIfNeeded();
      const closed = await page.evaluate(() => {
        const ids = ['home-search-what', 'home-location-toggle', 'home-search-category'];
        return { noOverflow: document.documentElement.scrollWidth <= innerWidth,
          boxes: ids.map(id => { const el = document.getElementById(id), r = el.getBoundingClientRect(); return { width: r.width, height: r.height, visible: r.width > 0 && r.height > 0 }; }) };
      });
      assert.equal(closed.noOverflow, true);
      assert.ok(closed.boxes.every(box => box.visible && box.height >= 44));
      await toggle.click();
      const open = await panel.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth }; });
      assert.ok(open.left >= 0 && open.right <= open.viewport, 'dropdown fits viewport');
      layouts.push({ width, closed, open });
      if (output) {
        fs.mkdirSync(output, { recursive: true });
        await page.locator('#home-content .home-search').screenshot({ path: path.join(output, `${safari ? 'safari' : 'chrome'}-${width}-open.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ base, browser: safari ? 'webkit' : 'chrome', checks: ['collapsed toggle', 'country-scoped city search', 'province/state labels', 'Apply commits', 'Cancel restores', 'invalid pair rejected', 'Escape focus', 'countrywide search', 'international region', 'GPS stays automatic', '320/390/1440px layout'], layouts }));
  } catch (error) {
    if (output) { fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'failure.png') }); }
    console.error('Page errors:', errors);
    console.error(await page.evaluate(() => ({ country: document.getElementById('home-location-country')?.value, city: document.getElementById('home-location-city')?.value, summary: document.getElementById('home-location-summary')?.textContent, status: document.getElementById('area-picker-status')?.textContent, options: document.getElementById('area-picker-countries')?.textContent, active: document.activeElement?.id, appReady: !!window.app, bound: document.getElementById('home-search-location')?.dataset.boundAreaPicker })) .catch(() => ({})));
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
