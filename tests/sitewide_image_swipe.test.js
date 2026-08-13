const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const classStart = source.indexOf('class DatingApp');
const classEnd = source.indexOf('// Initialize the app when the page loads');

assert.notEqual(classStart, -1, 'DatingApp class was not found');
assert.notEqual(classEnd, -1, 'DatingApp class boundary was not found');

const context = {
    console,
    document: {
        getElementById() { return null; }
    },
    window: {
        setTimeout(callback) { callback(); }
    }
};
const DatingApp = vm.runInNewContext(
    `${source.slice(classStart, classEnd)}\nDatingApp;`,
    context
);

function createApp() {
    const app = Object.create(DatingApp.prototype);
    app.normalizeSrc = (value) => String(value || '').trim().toLowerCase();
    app.escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    return app;
}

function createImage({ id = '', host = null } = {}) {
    const listeners = new Map();
    const attributes = new Map();
    const classes = new Set();
    return {
        id,
        src: 'one.jpg',
        currentSrc: 'one.jpg',
        dataset: { photoIndex: '0' },
        draggable: true,
        listeners,
        attributes,
        style: {
            values: new Map(),
            setProperty(name, value) { this.values.set(name, value); }
        },
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); }
        },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        closest(selector) {
            if (selector === '[data-images]') return host;
            return null;
        },
        setPointerCapture() {},
        releasePointerCapture() {}
    };
}

function fire(target, name, event = {}) {
    (target.listeners.get(name) || []).forEach((listener) => listener(event));
}

test('normalizes image collections, removes duplicates, and excludes video media', () => {
    const app = createApp();
    const sources = app.getSwipeImageSources({
        image: 'cover.jpg',
        photos: ['one.jpg', 'cover.jpg', { src: 'clip.mp4', type: 'video' }],
        gallery: [{ url: 'two.jpg' }, { publicUrl: 'three.jpg' }],
        raw: { media_urls: ['four.jpg', 'movie.webm'] }
    });

    assert.deepEqual(Array.from(sources), [
        'cover.jpg',
        'one.jpg',
        'two.jpg',
        'three.jpg',
        'four.jpg'
    ]);
});

test('steps standalone images in both directions and wraps at gallery boundaries', () => {
    const app = createApp();
    const host = { dataset: { photoIndex: '0' } };
    const img = createImage({ host });
    const sources = ['one.jpg', 'two.jpg', 'three.jpg'];
    app.getSitewideListingImageContext = () => ({
        sources,
        index: Number(img.dataset.photoIndex || 0),
        label: 'Test listing'
    });

    assert.equal(app.stepStandaloneSwipeableImage(img, 1), true);
    assert.equal(img.src, 'two.jpg');
    assert.equal(img.dataset.photoIndex, '1');
    assert.equal(host.dataset.photoIndex, '1');

    assert.equal(app.stepStandaloneSwipeableImage(img, -1), true);
    assert.equal(img.src, 'one.jpg');
    assert.equal(img.dataset.photoIndex, '0');

    assert.equal(app.stepStandaloneSwipeableImage(img, -1), true);
    assert.equal(img.src, 'three.jpg');
    assert.equal(img.dataset.photoIndex, '2');
    assert.match(img.attributes.get('aria-label'), /photo 3 of 3/i);
});

test('horizontal touch gestures change images and suppress the following tap', () => {
    const app = createApp();
    const img = createImage();
    const directions = [];
    app.getSitewideListingImageContext = () => ({ sources: ['one.jpg', 'two.jpg'], index: 0, label: 'Listing' });
    app.stepStandaloneSwipeableImage = (_img, direction) => {
        directions.push(direction);
        return true;
    };
    app.bindStandaloneSwipeableImage(img);

    fire(img, 'touchstart', { touches: [{ clientX: 120, clientY: 50 }] });
    let movePrevented = false;
    fire(img, 'touchmove', {
        touches: [{ clientX: 60, clientY: 54 }],
        cancelable: true,
        preventDefault() { movePrevented = true; }
    });
    fire(img, 'touchend', { changedTouches: [{ clientX: 30, clientY: 55 }] });

    assert.equal(movePrevented, true);
    assert.deepEqual(directions, [1]);
    assert.ok(Number(img.dataset.touchSwipeSuppressClickUntil) > Date.now());

    const clickState = { prevented: false, stopped: false, immediate: false };
    fire(img, 'click', {
        preventDefault() { clickState.prevented = true; },
        stopPropagation() { clickState.stopped = true; },
        stopImmediatePropagation() { clickState.immediate = true; }
    });
    assert.deepEqual(clickState, { prevented: true, stopped: true, immediate: true });
});

test('vertical touch gestures remain available for page scrolling', () => {
    const app = createApp();
    const img = createImage();
    let stepped = false;
    app.getSitewideListingImageContext = () => ({ sources: ['one.jpg', 'two.jpg'], index: 0, label: 'Listing' });
    app.stepStandaloneSwipeableImage = () => {
        stepped = true;
        return true;
    };
    app.bindStandaloneSwipeableImage(img);

    fire(img, 'touchstart', { touches: [{ clientX: 100, clientY: 20 }] });
    let movePrevented = false;
    fire(img, 'touchmove', {
        touches: [{ clientX: 104, clientY: 100 }],
        cancelable: true,
        preventDefault() { movePrevented = true; }
    });
    fire(img, 'touchend', { changedTouches: [{ clientX: 106, clientY: 130 }] });

    assert.equal(movePrevented, false);
    assert.equal(stepped, false);
});
