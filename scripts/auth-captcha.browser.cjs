const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const authHtml = index.slice(index.indexOf('<!-- Login Screen -->'), index.indexOf('<!-- Onboarding Screen -->'));
    await page.setContent(`<style>.hidden{display:none}.auth-card{width:100%;box-sizing:border-box;padding:24px}body{margin:0}</style>${authHtml}`);
    await page.addStyleTag({ path: path.join(root, 'styles.css') });
    await page.addStyleTag({ path: path.join(root, 'assets/auth-captcha.css') });
    await page.addScriptTag({ path: path.join(root, 'assets/auth-captcha.js') });
    assert.equal(await page.locator('script[src*="challenges.cloudflare.com"]').count(), 0, 'browsing must not load Turnstile');
    await page.evaluate(() => {
      window.SIXO_TURNSTILE_SITE_KEY = 'test-key';
      window.renders = []; window.removed = [];
      window.turnstile = {
        render(node, options) { window.renders.push(options); node.textContent = 'Security check'; return String(window.renders.length); },
        remove(id) { window.removed.push(id); }
      };
      window.begin = action => {
        document.querySelectorAll('.auth-screen').forEach(el => el.classList.add('hidden'));
        document.getElementById({ signup:'signup-screen', login:'login-screen', recovery:'login-screen', resend:'verify-email-screen' }[action]).classList.remove('hidden');
        window.outcome = null;
        window.SixoAuthCaptcha.getOptions(action).then(value => window.outcome = { value }, error => window.outcome = { error: error.message });
      };
    });
    for (const action of ['signup', 'login', 'recovery', 'resend']) {
      await page.evaluate(a => window.begin(a), action);
      await page.waitForFunction(a => window.renders.at(-1)?.action === a, action);
      assert.equal(await page.evaluate(() => window.outcome), null, 'no request proceeds while challenge is pending');
      await page.evaluate(a => window.renders.at(-1).callback(`token-${a}`), action);
      await page.waitForFunction(() => window.outcome !== null);
      assert.deepEqual(await page.evaluate(() => window.outcome), { value: { captchaToken: `token-${action}` } });
      assert.equal(await page.locator('.auth-captcha').count(), 0);
    }
    for (const callback of ['error-callback','expired-callback','timeout-callback','unsupported-callback']) {
      const count = await page.evaluate(() => window.renders.length);
      await page.evaluate(() => window.begin('signup'));
      await page.waitForFunction(n => window.renders.length > n, count);
      await page.evaluate(c => window.renders.at(-1)[c](), callback);
      await page.waitForFunction(() => window.outcome !== null);
      assert.ok((await page.evaluate(() => window.outcome)).error, callback);
    }
    await page.evaluate(() => window.begin('signup'));
    await page.waitForFunction(() => window.outcome === null && document.querySelector('.auth-captcha div')?.textContent === 'Security check');
    const duplicate = await page.evaluate(() => window.SixoAuthCaptcha.getOptions('signup').catch(e => e.message));
    assert.match(duplicate, /current security check/);
    await page.evaluate(() => document.getElementById('signup-screen').classList.add('hidden'));
    await page.waitForFunction(() => window.outcome?.error);
    assert.match(await page.evaluate(() => window.outcome.error), /cancelled/);
    await page.setViewportSize({ width: 320, height: 700 });
    const count = await page.evaluate(() => window.renders.length);
    await page.evaluate(() => window.begin('login'));
    await page.waitForFunction(n => window.renders.length > n, count);
    assert.equal(await page.evaluate(() => window.renders.at(-1).size), 'compact');
    await page.screenshot({ path: '/tmp/6ixo-turnstile-mobile.png' });
    await page.evaluate(() => window.renders.at(-1).callback('fresh-after-retry'));
    await page.waitForFunction(() => window.outcome !== null);
    assert.equal(await page.evaluate(() => window.outcome.value.captchaToken), 'fresh-after-retry');
    assert.equal(await page.evaluate(() => window.removed.length), await page.evaluate(() => window.renders.length));
    await page.evaluate(() => { window.SIXO_TURNSTILE_SITE_KEY = ''; window.begin('login'); });
    await page.waitForFunction(() => window.outcome?.error);
    assert.match(await page.evaluate(() => window.outcome.error), /temporarily unavailable/);
    console.log('PASS: all four flows, pending verification, single-use tokens, errors, expiry, retries, duplicate requests, cancellation, narrow layout and missing configuration.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
