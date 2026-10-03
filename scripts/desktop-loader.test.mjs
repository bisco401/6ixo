import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const refreshSource = html.match(/<script>\s*([\s\S]*?forceFreshMobileBuild[\s\S]*?)<\/script>/)[1];
const build = html.match(/var BUILD = '([^']+)'/)[1];

function refreshPage({ latest = build, savedTarget = '', sessionUnavailable = false, localUnavailable = false } = {}) {
    const listeners = new Map();
    const replacements = [];
    const values = new Map([['sixo_head_build_reload_target', savedTarget]]);
    const window = {
        location: { href: 'https://6ixo.com/?open=login#home', pathname: '/', replace: url => replacements.push(url), reload: () => replacements.push('reload') },
        history: { state: null, replaceState() {} },
        localStorage: { setItem() { if (localUnavailable) throw new Error('Storage unavailable'); } },
        sessionStorage: {
            getItem: key => { if (sessionUnavailable) throw new Error('Storage unavailable'); return values.get(key); },
            setItem: (key, value) => values.set(key, value)
        },
        addEventListener: (name, callback) => listeners.set(name, callback),
        setInterval() {}
    };
    vm.runInNewContext(refreshSource, {
        window, navigator: {}, URL, console,
        document: { addEventListener() {} },
        fetch: () => Promise.resolve({ text: () => Promise.resolve(`var BUILD = '${latest}';`) })
    });
    return { listeners, replacements, values };
}

async function probe(page) {
    page.listeners.get('pageshow')();
    await new Promise(resolve => setImmediate(resolve));
}

test('a stale version response cannot repeatedly reload the desktop page', async () => {
    const page = refreshPage({ latest: String(Number(build) - 1) });
    await probe(page);
    await probe(page);
    assert.deepEqual(page.replacements, []);
});

test('a newer release navigates once with a cache-busting build URL', async () => {
    const latest = String(Number(build) + 1);
    const page = refreshPage({ latest });
    await probe(page);
    await probe(page);
    assert.equal(page.replacements.length, 1);
    const url = new URL(page.replacements[0]);
    assert.equal(url.searchParams.get('build'), latest);
    assert.equal(url.searchParams.get('open'), 'login');
    assert.equal(url.hash, '#home');
});

test('the same cached old page cannot navigate again after a refresh attempt', async () => {
    const latest = String(Number(build) + 1);
    const page = refreshPage({ latest, savedTarget: latest });
    await probe(page);
    assert.deepEqual(page.replacements, []);
});

test('unavailable session storage skips optional automatic navigation', async () => {
    const page = refreshPage({ latest: String(Number(build) + 1), sessionUnavailable: true });
    await probe(page);
    assert.deepEqual(page.replacements, []);
});

test('unavailable local storage does not disable version checks', async () => {
    const page = refreshPage({ localUnavailable: true });
    assert.ok(page.listeners.has('pageshow'));
});

test('the homepage is visible before JavaScript and the blocking splash is hidden', () => {
    assert.doesNotMatch(html.match(/<div id="main-app"[^>]*>/)[0], /\bhidden\b/);
    assert.match(html.match(/<div id="loading-screen"[^>]*>/)[0], /display:none/);
});

test('homepage startup does not depend on external script or font downloads', () => {
    const externalScripts = [...html.matchAll(/<script\b([^>]*\bsrc="https?:[^>]+)>/g)];
    assert.equal(externalScripts.length, 0);
    const fonts = [...html.matchAll(/<link[^>]+href="https:\/\/(?:fonts\.googleapis\.com|cdnjs\.cloudflare\.com)[^>]+>/g)].filter(match => /rel="stylesheet"/.test(match[0]));
    assert.equal(fonts.length, 2);
    fonts.forEach(match => assert.match(match[0], /media="print"/));
    assert.match(html, /assets\/vendor\/supabase-2\.117\.2\.js/);
    assert.ok(fs.existsSync(new URL('../assets/vendor/supabase-2.117.2.js', import.meta.url)));
});

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const paymentMethods = appSource.slice(appSource.indexOf('    loadStripeScript() {'), appSource.indexOf('    setStripePaymentStatus('));

function paymentLoader() {
    const scripts = [];
    const timers = new Map();
    const window = { STRIPE_PUBLISHABLE_KEY: 'pk_test_startup_test', setTimeout: callback => { timers.set(1, callback); return 1; }, clearTimeout: id => timers.delete(id) };
    const document = { createElement: () => ({ remove() {} }), head: { appendChild: script => scripts.push(script) } };
    vm.runInNewContext(`class Payment { ${paymentMethods} } window.Payment = Payment;`, { window, document });
    return { window, scripts, timers, payment: new window.Payment() };
}

test('Stripe only loads when requested and concurrent requests share one script', async () => {
    const loader = paymentLoader();
    assert.equal(loader.scripts.length, 0);
    const first = loader.payment.getStripeClient();
    const second = loader.payment.getStripeClient();
    assert.equal(loader.scripts.length, 1);
    let clients = 0;
    loader.window.Stripe = key => { clients += 1; return { key }; };
    loader.scripts[0].onload();
    const [client, repeated] = await Promise.all([first, second]);
    assert.equal(client, repeated);
    assert.equal(clients, 1);
    assert.equal(loader.timers.size, 0);
});

test('a stalled payment script times out and can be retried', async () => {
    const loader = paymentLoader();
    const pending = loader.payment.getStripeClient();
    loader.timers.get(1)();
    await assert.rejects(pending, /Secure payments could not load/);
    assert.equal(loader.payment.stripeScriptPromise, null);
    const retry = loader.payment.getStripeClient();
    loader.window.Stripe = () => ({ ready: true });
    loader.scripts[1].onload();
    assert.equal((await retry).ready, true);
});

const recoverySource = fs.readFileSync(new URL('../site-startup.js', import.meta.url), 'utf8');
function recoveryMonitor() {
    const listeners = new Map();
    const appended = [];
    const nodes = [];
    let timeout;
    const loading = { style: { display: 'flex' } };
    const main = { classList: { remove() {} } };
    const replacements = [];
    const window = {
        app: null,
        location: { href: 'https://6ixo.com/?open=login#home', replace: url => replacements.push(url) },
        setTimeout: callback => { timeout = callback; return 1; },
        clearTimeout() {},
        addEventListener: (name, callback) => listeners.set(name, callback)
    };
    const document = {
        body: { appendChild: node => appended.push(node) },
        getElementById: id => id === 'loading-screen' ? loading : main,
        createElement: tag => {
            const node = { tag, style: {}, setAttribute() {}, appendChild() {}, addEventListener: (name, callback) => { node[name] = callback; }, remove: () => { node.removed = true; } };
            nodes.push(node);
            return node;
        }
    };
    vm.runInNewContext(recoverySource, { window, document, URL });
    return { window, listeners, appended, nodes, loading, replacements, timeout: () => timeout() };
}

test('failed startup offers a fresh retry instead of an endless loading screen', () => {
    const monitor = recoveryMonitor();
    monitor.timeout();
    monitor.timeout();
    assert.equal(monitor.appended.length, 1);
    assert.equal(monitor.loading.style.display, 'none');
    monitor.nodes.find(node => node.tag === 'button').click();
    const retry = new URL(monitor.replacements[0]);
    assert.ok(retry.searchParams.has('retry'));
    assert.equal(retry.searchParams.get('open'), 'login');
    assert.equal(retry.hash, '#home');
});

test('a delayed successful startup removes its recovery notice', () => {
    const monitor = recoveryMonitor();
    monitor.timeout();
    monitor.window.app = {};
    monitor.listeners.get('sixo:app-ready')();
    assert.equal(monitor.appended[0].removed, true);
});

test('a failed core script shows recovery immediately', () => {
    const monitor = recoveryMonitor();
    monitor.listeners.get('error')({ target: { tagName: 'SCRIPT', src: 'https://6ixo.com/assets/vendor/supabase-2.117.2.js' } });
    assert.equal(monitor.appended.length, 1);
});
