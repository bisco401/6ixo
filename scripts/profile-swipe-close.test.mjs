import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const context = { window: {}, document: {}, console };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);

function fixture({ onGallery = false, originSelector = onGallery ? '[data-modal-swipe-surface-bound="1"]' : '' } = {}) {
    const app = Object.create(context.App.prototype);
    const makeSurface = () => ({
        dataset: {}, style: { setProperty() {} }, listeners: new Map(),
        addEventListener(type, callback) {
            assert.ok(!this.listeners.has(type), `${type} must bind once`);
            this.listeners.set(type, callback);
        }
    });
    const modal = makeSurface();
    const gallery = makeSurface();
    let open = true;
    let closes = 0;
    let history = 0;
    let photo = 1;
    app.isModalOpen = () => open;
    app.popModalHistoryState = id => {
        assert.equal(id, 'profile-modal');
        assert.equal(open, false, 'dismiss immediately, before history completes');
        history++;
    };
    const close = options => {
        assert.equal(options.useHistory, false);
        open = false;
        closes++;
    };
    const button = { ...makeSurface(), closest: () => modal };
    app.bindProfileCloseButton(button, close, 'profile-modal');
    app.bindProfileSwipeClose(modal, close, 'profile-modal');
    app.bindModalSwipeSurface(gallery, { modalId: 'profile-modal', onPrevious: () => photo--, onNext: () => photo++ });
    const target = { closest: selector => originSelector && selector.split(',').map(part => part.trim()).includes(originSelector) ? gallery : null };
    const touch = (x, y = 100, identifier = 1) => ({ clientX: x, clientY: y, identifier });
    const emit = (type, data = {}) => {
        const event = {
            target, cancelable: true, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; },
            ...data
        };
        modal.listeners.get(type)?.(event);
        if (onGallery && !event.stopped) gallery.listeners.get(type)?.(event);
        return event;
    };
    return {
        emit, touch, start: (x = 80, y = 100) => emit('touchstart', { touches: [touch(x, y)] }),
        move: (x, y = 100) => emit('touchmove', { touches: [touch(x, y)] }),
        end: (x = 240, y = 100) => emit('touchend', { changedTouches: [touch(x, y)] }),
        state: () => ({ open, closes, history, photo }), reopen: () => { open = true; }, hide: () => { open = false; }
    };
}

test('right swipe outside the gallery closes once, even with cancelled touch pointers', () => {
    const f = fixture();
    f.emit('pointerdown', { pointerType: 'touch', pointerId: 1 });
    f.start();
    f.emit('pointercancel', { pointerType: 'touch', pointerId: 1 });
    assert.equal(f.move(160).defaultPrevented, true);
    f.end();
    f.end();
    assert.deepEqual(f.state(), { open: false, closes: 1, history: 1, photo: 1 });
    assert.equal(f.emit('click').defaultPrevented, true, 'dismissal must not also open the photo');
    f.reopen();
    f.start();
    f.end();
    assert.equal(f.state().closes, 2, 'a rapidly reopened profile can be dismissed');
});

test('left swipe shows the previous photo and right mouse drag shows the next', () => {
    const f = fixture({ onGallery: true });
    f.start(240);
    assert.equal(f.move(160).defaultPrevented, true, 'gallery owns left swipe');
    f.end(80);
    assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 0 });
    f.emit('pointerdown', { pointerType: 'mouse', pointerId: 3, button: 0, clientX: 80, clientY: 100 });
    f.emit('pointerup', { pointerType: 'mouse', pointerId: 3, clientX: 240, clientY: 100 });
    assert.equal(f.state().photo, 1);
    assert.equal(f.state().open, true);
});

test('finger swipes browse the gallery in both directions without dismissing the listing', () => {
    const f = fixture({ onGallery: true, originSelector: 'img' });
    f.start(240);
    f.move(160);
    f.end(80);
    assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 0 });
    f.start(80);
    assert.equal(f.move(160).defaultPrevented, true, 'gallery owns right swipe');
    f.end(240);
    assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 1 });
    f.start(80);
    f.end(240);
    assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 2 });
    assert.equal(f.emit('click').defaultPrevented, true, 'swiping must not also open fullscreen');
});

test('images and the full gallery area never start profile dismissal, even before swipe binding', () => {
    for (const originSelector of [
        'img', 'picture', '.cb-profile-hero', '.marketplace-item-hero', '.luxury-ad-hero',
        '.vehicle-modal-media', '.realestate-modal-media', '.service-modal-media',
        '.profile-modal-media', '.seller-profile-luxury-hero'
    ]) {
        const f = fixture({ originSelector });
        f.start();
        assert.equal(f.move(160).defaultPrevented, false, `${originSelector} must not reserve dismissal`);
        f.end(260);
        assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 1 }, originSelector);
        assert.equal(f.emit('click').defaultPrevented, false, 'dismissal must not suppress image taps');
    }
});

test('a swipe that starts on an image cannot become dismissal when the finger leaves the image', () => {
    const f = fixture({ originSelector: 'img', onGallery: true });
    f.start();
    const outside = { closest: () => null };
    f.emit('touchmove', { target: outside, touches: [f.touch(160)] });
    f.emit('touchend', { target: outside, changedTouches: [f.touch(260)] });
    assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 2 });
});

test('vertical scrolling stays native even if the gesture later drifts right', () => {
    const f = fixture();
    f.start();
    assert.equal(f.move(85, 150).defaultPrevented, false);
    f.end(280, 180);
    assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 1 });
});

test('taps, short right drags, reversed drags, cancellations, and pinches do not dismiss', () => {
    for (const gesture of [
        f => f.end(80),
        f => { f.move(120); f.end(130); },
        f => { f.move(240); f.end(90); },
        f => { f.emit('touchcancel'); f.end(); },
        f => { f.emit('touchstart', { touches: [f.touch(80), f.touch(90, 100, 2)] }); f.end(); },
        f => { f.emit('touchmove', { touches: [f.touch(80), f.touch(90, 100, 2)] }); f.end(); }
    ]) {
        const f = fixture();
        f.start();
        gesture(f);
        assert.deepEqual(f.state(), { open: true, closes: 0, history: 0, photo: 1 });
    }
});

test('controls retain their gestures, and unrelated or hidden touches cannot dismiss', () => {
    const f = fixture();
    f.emit('touchstart', { target: { closest: () => ({}) }, touches: [f.touch(80)] });
    assert.equal(f.move(240).defaultPrevented, false);
    f.end();
    assert.equal(f.state().closes, 0);
    f.start();
    f.emit('touchend', { changedTouches: [f.touch(240, 100, 2)] });
    assert.equal(f.state().closes, 0);
    f.hide();
    f.end();
    assert.equal(f.state().closes, 0);
});

test('a new tap works immediately after an incomplete dismissal gesture', () => {
    const f = fixture();
    f.start();
    f.move(120);
    f.end(130);
    assert.equal(f.emit('click').defaultPrevented, true);
    f.start();
    f.end(80);
    assert.equal(f.emit('click').defaultPrevented, false);
});
