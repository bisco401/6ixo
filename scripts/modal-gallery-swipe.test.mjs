import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const context = { window: {}, document: {}, console };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
let open = true;
app.isModalOpen = () => open;
const listeners = new Map();
const surface = {
    dataset: {}, style: { setProperty() {} },
    addEventListener(name, callback) { listeners.set(name, callback); }
};
let index = 0;
app.bindModalSwipeSurface(surface, { modalId: 'vehicle-modal', onNext: () => index++, onPrevious: () => index-- });
const image = { closest: () => null };
const button = { closest: () => ({}) };
let prevented = false;
const emit = (type, values = {}) => listeners.get(type)?.({ target: image, cancelable: true, preventDefault() { prevented = true; }, stopPropagation() {}, ...values });
const touch = (x, y, identifier = 1) => ({ clientX: x, clientY: y, identifier });
const start = (x = 200, y = 50) => emit('touchstart', { touches: [touch(x, y)] });
const end = (x = 100, y = 50) => emit('touchend', { changedTouches: [touch(x, y)] });

// iPhone sends both event families and can cancel only the pointer stream.
emit('pointerdown', { pointerType: 'touch', pointerId: 5, clientX: 200, clientY: 50 });
start();
emit('pointercancel', { pointerType: 'touch', pointerId: 5 });
emit('touchmove', { touches: [touch(130, 55)] });
assert.equal(prevented, true, 'horizontal swipe must reserve the gesture');
end();
emit('pointerup', { pointerType: 'touch', pointerId: 5, clientX: 100, clientY: 50 });
assert.equal(index, 1, 'dual event streams advance exactly once');
prevented = false;
emit('click');
assert.equal(prevented, true, 'swiping must not open fullscreen');
start(100); end(200);
assert.equal(index, 0, 'right swipe returns to previous photo');
start(); end(190);
assert.equal(index, 0, 'tap or short movement does not change photos');
start(); prevented = false;
emit('touchmove', { touches: [touch(205, 100)] });
assert.equal(prevented, false, 'vertical scrolling remains native');
end(100, 120);
assert.equal(index, 0, 'vertical gesture stays vertical even when it drifts sideways');
start(); emit('touchcancel'); end();
assert.equal(index, 0, 'cancelled touch does not navigate');
start(); emit('touchstart', { touches: [touch(200, 50), touch(210, 50, 2)] }); end();
assert.equal(index, 0, 'pinch gesture does not navigate');
emit('touchstart', { target: button, touches: [touch(200, 50)] }); end();
assert.equal(index, 0, 'controls keep their own gestures');
start(); open = false; end(); open = true;
assert.equal(index, 0, 'closed modal cannot navigate');
emit('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 8, clientX: 200, clientY: 50 });
emit('pointerup', { pointerType: 'mouse', pointerId: 9, clientX: 100, clientY: 50 });
assert.equal(index, 0, 'unrelated pointers cannot finish a drag');
emit('pointerup', { pointerType: 'mouse', pointerId: 8, clientX: 100, clientY: 50 });
assert.equal(index, 1, 'mouse dragging still navigates');
console.log('Modal gallery swipe tests passed.');

prevented = false;
emit('click', { target: button });
assert.equal(prevented, false, 'gallery controls remain clickable immediately after a swipe');
