const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const vehicleLayoutStyles = fs.readFileSync(path.join(root, 'vehicle-layout-modes.css'), 'utf8');
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

test('upgrades small Kijiji thumbnails for the full-screen viewer', () => {
    const app = createApp();
    const small = 'https://media.kijiji.ca/api/v1/images/example?rule=kijijica-200-jpg';
    const [item] = app.buildLightboxItems([small], 'Test listing');

    assert.equal(
        item.src,
        'https://media.kijiji.ca/api/v1/images/example?rule=kijijica-640-webp'
    );
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

test('selecting a photo dot and swiping share the image, host, and active-dot state', () => {
    const app = createApp();
    const host = { dataset: { photoIndex: '0' } };
    const img = createImage({ host });
    const dots = Array.from({ length: 3 }, (_, index) => ({
        offsetLeft: index * 27, offsetWidth: 24,
        classList: { toggle(_name, active) { dots[index].active = active; } },
        setAttribute(name, value) { this[name] = value; }
    }));
    const rail = { children: dots, clientWidth: 80, querySelectorAll() { return dots; } };
    app.standalonePhotoDots = new WeakMap([[img, { rail }]]);
    app.getSitewideListingImageContext = () => ({
        sources: ['one.jpg', 'two.jpg', 'three.jpg'],
        index: Number(img.dataset.photoIndex), label: 'Listing'
    });
    assert.equal(app.selectStandaloneSwipeableImage(img, 2), true);
    assert.equal(img.src, 'three.jpg');
    assert.equal(host.dataset.photoIndex, '2');
    assert.deepEqual(dots.map(dot => dot.active), [false, false, true]);
    assert.equal(dots[2]['aria-current'], 'true');

    app.bindStandaloneSwipeableImage(img);
    fire(img, 'touchstart', { touches: [{ clientX: 120, clientY: 50 }] });
    fire(img, 'touchend', { changedTouches: [{ clientX: 30, clientY: 52 }] });
    assert.equal(img.src, 'one.jpg');
    assert.equal(host.dataset.photoIndex, '0');
    assert.deepEqual(dots.map(dot => dot.active), [true, false, false]);
    assert.equal(dots[2]['aria-current'], 'false');
});

test('single-image feeds remove stale dots and release their observers', () => {
    const app = createApp();
    const img = createImage();
    img.matches = () => true;
    img.parentElement = {};
    let disconnected = false;
    let removed = false;
    let listenerRemoved = false;
    img.removeEventListener = () => { listenerRemoved = true; };
    app.standalonePhotoDots = new WeakMap([[img, {
        rail: { remove() { removed = true; } },
        observer: { disconnect() { disconnected = true; } },
        onLoad() {}
    }]]);
    app.getSitewideListingImageContext = () => ({ sources: ['one.jpg'], index: 0 });
    app.ensureStandalonePhotoDots(img);
    assert.equal(removed, true);
    assert.equal(disconnected, true);
    assert.equal(listenerRemoved, true);
    assert.equal(app.standalonePhotoDots.has(img), false);
});

test('generated photo labels do not grow on repeated photo selections', () => {
    const app = createApp();
    const img = createImage();
    img.attributes.set('alt', 'Land in Ghana');
    img.getAttribute = name => img.attributes.get(name);
    img.parentElement = { closest() { return null; } };
    app.getSitewideListingImageContext = () => ({
        sources: ['one.jpg', 'two.jpg'], index: Number(img.dataset.photoIndex),
        label: app.getFullscreenImageLabel(img)
    });
    app.selectStandaloneSwipeableImage(img, 1);
    app.selectStandaloneSwipeableImage(img, 0);
    assert.equal(img.attributes.get('aria-label'), 'View Land in Ghana photo 1 of 2 full screen');
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

test('recognizes feed carousels without classifying full detail galleries', () => {
    const app = createApp();
    let selector = '';
    const feedCarousel = {
        closest(value) {
            selector = value;
            return { className: 'vehicle-feed-card' };
        }
    };
    const detailCarousel = {
        closest() { return null; }
    };

    assert.equal(app.isCompactFeedCarousel(feedCarousel), true);
    assert.match(selector, /\.vehicle-feed-card/);
    assert.match(selector, /\.featured-ad-card/);
    assert.match(selector, /\.jobs-featured-card/);
    assert.equal(app.isCompactFeedCarousel(detailCarousel), false);
});

test('compact mobile feed styles hide arrows and use uniform bottom dots', () => {
    assert.match(styles, /\.image-carousel\.is-compact-feed-carousel \.carousel-btn\s*\{/);
    assert.match(styles, /bottom:\s*0\.42rem\s*!important/);
    assert.match(styles, /\.image-carousel\.is-compact-feed-carousel \.mobile-carousel-dot\.active/);
    assert.match(styles, /width:\s*6px\s*!important/);
});

test('marketplace listing rows remove arrows and keep bottom dots', () => {
    assert.match(source, /const isCompactListingRow = item\.classList\.contains\('marketplace-listing-row'\)/);
    assert.match(source, /const showArrowControls = !isCompactFeedCard/);
    assert.match(styles, /#marketplace-items\.marketplace-list-view \.marketplace-listing-row \.marketplace-item-media\.image-carousel \.carousel-btn/);
    assert.match(styles, /#marketplace-items\.marketplace-list-view \.marketplace-listing-row \.marketplace-item-media\.image-carousel\.has-mobile-carousel-dots \.mobile-carousel-dots/);
    assert.match(styles, /bottom:\s*0\.34rem\s*!important/);
});

test('mobile marketplace listing thumbnails use a visibly larger 136 by 140 frame', () => {
    assert.match(styles, /#marketplace-items\.marketplace-list-view \.marketplace-listing-row\s*\{[\s\S]*?grid-template-columns:\s*136px minmax\(0, 1fr\)\s*!important/);
    assert.match(styles, /#marketplace-items\.marketplace-list-view \.marketplace-listing-row \.marketplace-item-media,[\s\S]*?width:\s*136px\s*!important;[\s\S]*?height:\s*140px\s*!important/);
});

test('marketplace feed images explicitly open the full-screen media viewer', () => {
    assert.match(source, /bindMarketplaceFeedMediaLightbox\(item, media, sources = \[\], label = 'Listing'\)/);
    assert.match(source, /this\.openMediaLightbox\(photoSources, label, imageIndex >= 0 \? imageIndex : activeIndex\)/);
    assert.match(source, /image\.setAttribute\('title', 'View full screen'\)/);
});

test('the media viewer gives photos the full viewport while controls float above them', () => {
    assert.match(styles, /\.media-lightbox-frame\s*\{[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*100dvh;/);
    assert.match(styles, /\.media-lightbox-frame img\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*contain;/);
    assert.match(styles, /\.media-lightbox-thumbs\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(styles, /\.media-lightbox-caption\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(styles, /\.media-lightbox-frame > img\.media-lightbox-image\s*\{[\s\S]*?width:\s*100vw\s*!important;[\s\S]*?height:\s*auto\s*!important;/);
});

test('mobile vehicle listing rows use a large photo and explicitly bind the full-screen viewer', () => {
    assert.match(vehicleLayoutStyles, /#vehicles-content:not\(\.rentals-mode\) #vehicles-items\.vehicle-list-view \.dating-feed-card\.vehicle-feed-card:not\(\.is-rental\):not\(\.marketplace-feed-card\)\s*\{[\s\S]*?grid-template-columns:\s*136px minmax\(0, 1fr\)\s*!important/);
    assert.match(vehicleLayoutStyles, /#vehicles-content:not\(\.rentals-mode\) #vehicles-items\.vehicle-list-view \.dating-feed-card\.vehicle-feed-card:not\(\.is-rental\):not\(\.marketplace-feed-card\) \.vehicle-card-carousel\s*\{[\s\S]*?width:\s*136px\s*!important;[\s\S]*?height:\s*140px\s*!important/);
    assert.match(source, /this\.bindVehicleFeedMediaLightboxes\(container\)/);
    assert.match(source, /bindVehicleFeedMediaLightboxes\(container\)[\s\S]*?this\.bindMarketplaceFeedMediaLightbox\(card, media, \[\], title\)/);
});
