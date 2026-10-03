import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const startupSource = appSource.slice(
    appSource.indexOf('async function refreshClientForNewBuild()'),
    appSource.indexOf('// Disable stale PWA behavior')
);

function createStartup({ readyState = 'loading', cacheMode = 'ok', workerMode = 'ok', storageThrows = false } = {}) {
    const listeners = new Map();
    const values = new Map();
    const loading = { style: { display: 'flex' } };
    let instances = 0;
    const operation = (mode, value) => {
        if (mode === 'pending') return new Promise(() => {});
        if (mode === 'reject') return Promise.reject(new Error('Storage unavailable'));
        return Promise.resolve(value);
    };
    const context = {
        APP_BUILD_VERSION: 'test-build',
        URLSearchParams,
        console: { warn() {}, error() {} },
        requestAnimationFrame: callback => callback(),
        document: {
            readyState,
            addEventListener: (name, callback) => listeners.set(name, callback),
            querySelectorAll: () => [],
            getElementById: id => id === 'loading-screen' ? loading : null
        },
        window: {
            location: { search: '' },
            localStorage: {
                getItem: key => { if (storageThrows) throw new Error('Storage unavailable'); return values.get(key); },
                setItem: (key, value) => values.set(key, value)
            },
            caches: {
                keys: () => operation(cacheMode, ['old-cache']),
                delete: () => operation(cacheMode, true)
            }
        },
        navigator: {
            serviceWorker: {
                getRegistrations: () => operation(workerMode, [{ unregister: () => operation(workerMode, true) }])
            }
        },
        applyComingSoonCategoryLocks() {},
        renderComingSoonGate() {},
        isSupabaseAuthCallbackUrl: () => false,
        DatingApp: class {
            constructor() { instances += 1; loading.style.display = 'none'; }
            openSharedCardFromUrl() {}
        }
    };
    vm.runInNewContext(startupSource, context);
    return { context, listeners, loading, instances: () => instances };
}

for (const scenario of [
    { name: 'cache enumeration never resolves', cacheMode: 'pending' },
    { name: 'service-worker enumeration never resolves', workerMode: 'pending' },
    { name: 'cache cleanup rejects', cacheMode: 'reject' },
    { name: 'service-worker cleanup rejects', workerMode: 'reject' },
    { name: 'local storage is unavailable', storageThrows: true },
    { name: 'normal first visit' }
]) {
    test(`desktop renders when ${scenario.name}`, async () => {
        const startup = createStartup(scenario);
        startup.listeners.get('DOMContentLoaded')();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(startup.instances(), 1);
        assert.equal(startup.loading.style.display, 'none');
        assert.ok(startup.context.window.app);
    });
}

test('app starts when its script arrives after DOMContentLoaded', () => {
    const startup = createStartup({ readyState: 'complete', cacheMode: 'pending' });
    assert.equal(startup.instances(), 1);
    assert.equal(startup.loading.style.display, 'none');
});

test('startup runs once if DOMContentLoaded is delivered twice', async () => {
    const startup = createStartup();
    const initialize = startup.listeners.get('DOMContentLoaded');
    initialize();
    initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(startup.instances(), 1);
});
