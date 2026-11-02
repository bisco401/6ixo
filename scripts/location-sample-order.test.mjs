import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const now = Date.now();
class TestDate extends Date { static now() { return now; } }
const context = { Date: TestDate, window: {}, document: {}, navigator: {}, console };
vm.runInNewContext(`${source.slice(source.indexOf('class DatingApp'), source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = () => Object.assign(Object.create(context.App.prototype), { cityLocationMaxAccuracyMeters: 1000 });
const precise = { coords: { latitude: 43.4675, longitude: -79.6877, accuracy: 15 }, timestamp: now };

test('A fresh precise fix replaces an approximate fix even when both timestamps are equal', () => {
    const instance = app();
    instance.userLocation = { lat: 43.2557, lng: -79.8711, accuracy: 25000, timestamp: now };
    assert.equal(instance.shouldAcceptBrowserLocationSample(precise), true);
    instance.userLocation.timestamp = now - 5000;
    assert.equal(instance.shouldAcceptBrowserLocationSample(precise), true);
});

test('A stale precise response cannot overwrite a newer sample', () => {
    const instance = app();
    instance.userLocation = { lat: 43.2557, lng: -79.8711, accuracy: 25000, timestamp: now };
    assert.equal(instance.shouldAcceptBrowserLocationSample({ ...precise, timestamp: now - 1 }), false);
    assert.equal(instance.shouldAcceptBrowserLocationSample({ ...precise, timestamp: now - 180000 }), false);
});

test('Stationary GPS jitter is ignored while real movement remains responsive', () => {
    const instance = app();
    instance.userLocation = { lat: 43.4675, lng: -79.6877, accuracy: 15, timestamp: now - 1000 };
    assert.equal(instance.shouldAcceptBrowserLocationSample({ ...precise, coords: { ...precise.coords, longitude: -79.68762 } }), false);
    assert.equal(instance.shouldAcceptBrowserLocationSample({ ...precise, coords: { ...precise.coords, longitude: -79.6870 } }), true);
});
