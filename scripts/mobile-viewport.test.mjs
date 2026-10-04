import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const viewportSource = source.slice(source.indexOf('        if (!this.boundCarouselViewportChange)'), source.indexOf('// Swipe events', source.indexOf('        if (!this.boundCarouselViewportChange)')));
const classSource = source.slice(source.indexOf('class DatingApp'), source.indexOf('// Initialize the app when the page loads'));

function fixture({ coarse = true } = {}) {
    const listeners = new Map();
    const timers = new Map();
    const tracks = [{ dataset: { carouselIndex: '2' }, width: 280 }, { dataset: {}, width: 0 }];
    const cards = [];
    const media = { matches: coarse, addEventListener: (event, fn) => listeners.set(`media:${event}`, fn) };
    const document = {
        documentElement: { clientWidth: 390 },
        querySelectorAll(selector) {
            if (selector === '.carousel-track') return tracks;
            if (selector === '.featured-ad-card .image-carousel') return cards;
            throw new Error(`Unexpected global DOM rewrite: ${selector}`);
        }
    };
    const context = { document, navigator: { maxTouchPoints: 0 }, window: {
        innerWidth: 390,
        addEventListener: (event, fn) => listeners.set(event, fn),
        matchMedia: () => media
    }, setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) };
    const App = vm.runInNewContext(`${classSource}\nDatingApp;`, context);
    const app = Object.create(App.prototype);
    const alignments = [];
    app.getCarouselSlideWidth = track => track.width;
    app.scheduleCarouselTrackAlignment = (track, options) => alignments.push({ track, options });
    vm.runInNewContext(`(function () { ${viewportSource} }).call(app);`, { ...context, app });
    return { app, context, document, listeners, timers, tracks, cards, media, alignments,
        flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); } };
}

test('address-bar and keyboard height changes do not realign photo tracks', () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) {
        f.context.window.innerHeight = i % 2 ? 760 : 844;
        f.listeners.get('resize')();
    }
    f.listeners.get('orientationchange')();
    f.flush();
    assert.equal(f.alignments.length, 0);
    assert.equal(f.timers.size, 0);
});

test('rotation realigns visible tracks once and preserves the selected photo', () => {
    const f = fixture();
    f.document.documentElement.clientWidth = 844;
    f.listeners.get('orientationchange')();
    f.listeners.get('resize')();
    f.context.window.innerHeight = 390;
    f.listeners.get('resize')();
    // Android can emit native scroll-snap events before the resize debounce.
    f.tracks[0].dataset.carouselIndex = '0';
    f.flush();
    assert.equal(f.alignments.length, 1);
    assert.equal(f.alignments[0].track, f.tracks[0]);
    assert.equal(f.alignments[0].options.index, 2);
});

test('a burst of layout-width changes is coalesced', () => {
    const f = fixture();
    for (const width of [500, 600, 720]) {
        f.document.documentElement.clientWidth = width;
        f.listeners.get('resize')();
    }
    assert.equal(f.timers.size, 1);
    f.flush();
    assert.equal(f.alignments.length, 1);
});

function card(hover = false) {
    const listeners = new Map();
    const host = { dataset: {}, matches: () => hover, addEventListener: (name, fn) => listeners.set(name, fn) };
    const buttons = [0, 1].map(() => ({ hidden: false, style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }));
    const carousel = { closest: () => host, querySelector: selector => buttons[selector.endsWith('.prev') ? 0 : 1] };
    return { host, carousel, buttons, listeners };
}

test('configuring another card leaves existing photo controls untouched', () => {
    const f = fixture();
    const first = card();
    const second = card();
    f.app.configureFeaturedCardCarouselButtons(first.carousel, ...first.buttons);
    first.buttons[0].style.opacity = 'sentinel';
    f.app.configureFeaturedCardCarouselButtons(second.carousel, ...second.buttons);
    assert.equal(first.buttons[0].style.opacity, 'sentinel');
    assert.equal(second.buttons[0].hidden, false);
    assert.equal(f.listeners.has('media:change'), true);
    f.listeners.get('resize')();
    assert.equal(first.buttons[0].style.opacity, 'sentinel');
});

test('desktop hover and an input-device change still update photo controls', () => {
    const f = fixture({ coarse: false });
    const c = card();
    f.cards.push(c.carousel);
    f.app.configureFeaturedCardCarouselButtons(c.carousel, ...c.buttons);
    assert.equal(c.buttons[0].hidden, true);
    c.listeners.get('mouseenter')();
    assert.equal(c.buttons[0].hidden, false);
    c.listeners.get('mouseleave')();
    assert.equal(c.buttons[0].hidden, true);
    f.media.matches = true;
    f.listeners.get('media:change')();
    assert.equal(c.buttons[0].hidden, false);
});

test('settling an already aligned photo does not write scroll styles', () => {
    const f = fixture();
    const writes = [];
    const track = { width: 280, scrollWidth: 840, scrollLeft: 560, dataset: { carouselIndex: '2' },
        style: new Proxy({}, { set(_object, name, value) { writes.push([name, value]); return true; } }) };
    assert.equal(f.app.alignCarouselTrack(track), 2);
    assert.deepEqual(writes, []);
});
