import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class DatingApp'), source.indexOf('// Initialize the app when the page loads'));

function fixture(options = {}) {
    let now = 0, sequence = 0;
    const timers = new Map();
    const context = { window: {
        setTimeout(callback, delay) { timers.set(++sequence, { callback, at: now + delay }); return sequence; },
        clearTimeout(id) { timers.delete(id); }
    } };
    vm.runInNewContext(`${classSource}\nglobalThis.App = DatingApp;`, context);
    const app = Object.create(context.App.prototype);
    app.activeScreen = 'home';
    const listeners = new Map();
    const input = { value: '', isConnected: true, selectionStart: 0, selectionEnd: 0,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        }
    };
    const searches = [], drafts = [];
    app.bindSearchInput(input, () => searches.push(input.value), { onDraft: () => drafts.push(input.value), ...options });
    const dispatch = (type, props = {}) => {
        const event = { type, preventDefault() { this.defaultPrevented = true; }, ...props };
        for (const listener of listeners.get(type) || []) listener(event);
        return event;
    };
    const tick = (ms) => {
        now += ms;
        for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    };
    return { app, input, searches, drafts, dispatch, tick };
}

test('Rapid typing updates the draft immediately and searches once after a pause', () => {
    const f = fixture();
    for (const character of 'Toyota Corolla ') {
        f.input.value += character;
        f.dispatch('input');
        f.tick(25);
    }
    assert.deepEqual(f.searches, []);
    assert.equal(f.drafts.at(-1), 'Toyota Corolla ');
    f.tick(200);
    assert.deepEqual(f.searches, ['Toyota Corolla ']);
    assert.equal(f.input.value, 'Toyota Corolla ');
});

test('Enter commits immediately and cancels the pending repeat', () => {
    const f = fixture();
    f.input.value = 'New York';
    f.dispatch('input');
    assert.equal(f.dispatch('keydown', { key: 'Enter' }).defaultPrevented, true);
    assert.deepEqual(f.searches, ['New York']);
    f.tick(1000);
    assert.equal(f.searches.length, 1);
});

test('Composition pauses search and Enter does not interrupt the composing keyboard', () => {
    const f = fixture();
    f.input.value = 'to';
    f.dispatch('input');
    f.dispatch('compositionstart');
    f.input.value = '東京';
    f.dispatch('input', { isComposing: true });
    assert.equal(f.dispatch('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, undefined);
    f.tick(500);
    assert.deepEqual(f.searches, []);
    f.dispatch('compositionend');
    f.dispatch('input');
    f.tick(200);
    assert.deepEqual(f.searches, ['東京']);
});

test('Cursor edits, clearing, and pasting use the latest value without moving the caret', () => {
    const f = fixture();
    f.input.value = 'Toyota Corolla';
    f.dispatch('input');
    f.input.value = '';
    f.dispatch('input');
    f.input.value = 'Toyota  Corolla ';
    f.input.selectionStart = f.input.selectionEnd = 7;
    f.dispatch('input', { inputType: 'insertFromPaste' });
    f.tick(200);
    assert.deepEqual(f.searches, ['Toyota  Corolla ']);
    assert.equal(f.input.selectionStart, 7);
    assert.equal(f.input.selectionEnd, 7);
});

test('Cancelled searches and searches belonging to a previous screen do not run', () => {
    const f = fixture();
    f.dispatch('input');
    f.app.cancelPendingSearch(f.input);
    f.tick(500);
    f.dispatch('input');
    f.app.activeScreen = 'vehicles';
    f.tick(500);
    f.dispatch('input');
    f.input.isConnected = false;
    f.tick(500);
    assert.deepEqual(f.searches, []);
});

test('Binding again does not duplicate listeners and committed changes cancel pending work', () => {
    const f = fixture();
    f.app.bindSearchInput(f.input, () => assert.fail('Duplicate handler'));
    f.input.value = 'Camera';
    f.dispatch('input');
    f.dispatch('change');
    f.tick(500);
    assert.deepEqual(f.searches, ['Camera']);
});
