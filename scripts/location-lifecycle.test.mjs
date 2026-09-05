import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const classEnd = source.indexOf('// Initialize the app when the page loads');
if (classEnd < 0) throw new Error('Could not isolate DatingApp.');

let successCallback = null;
let errorCallback = null;
let requestOptions = null;
let requestCount = 0;
const navigatorStub = {
  geolocation: {
    getCurrentPosition(success, error, options) {
      requestCount += 1;
      successCallback = success;
      errorCallback = error;
      requestOptions = options;
    },
    watchPosition() { return 7; },
    clearWatch() {}
  }
};
const windowStub = { setTimeout, clearTimeout, addEventListener() {} };
const documentStub = {
  visibilityState: 'visible',
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }
};
const context = {
  console,
  document: documentStub,
  window: windowStub,
  navigator: navigatorStub,
  Date,
  Map,
  Set,
  URL,
  URLSearchParams,
  Promise,
  setTimeout,
  clearTimeout
};
vm.runInNewContext(
  `${source.slice(0, classEnd)}\nglobalThis.TestDatingApp = DatingApp;`,
  context
);

const app = Object.create(context.TestDatingApp.prototype);
Object.assign(app, {
  locationRequestInFlight: false,
  locationRequestPromise: null,
  locationPermissionState: 'unknown',
  hasBrowserGeolocation: false,
  userLocation: null,
  cityLocationMaxAccuracyMeters: 1000,
  handleLocationSuccess(position) {
    this.hasBrowserGeolocation = true;
    this.userLocation = {
      lat: Number(position.coords.latitude),
      lng: Number(position.coords.longitude),
      accuracy: Number(position.coords.accuracy)
    };
    return true;
  },
  handleLocationError() {}
});

const first = app.requestLocationPermission();
const second = app.requestLocationPermission();
if (first !== second || requestCount !== 1) {
  throw new Error('Concurrent location consumers must share one browser request.');
}
if (!requestOptions?.enableHighAccuracy || requestOptions.maximumAge !== 0) {
  throw new Error('Location requests must require a fresh high-accuracy fix.');
}
successCallback({
  coords: { latitude: 0, longitude: 0, accuracy: 12 },
  timestamp: Date.now()
});
if (!(await first) || !app.hasUsableCurrentLocation()) {
  throw new Error('Valid zero coordinates must remain usable.');
}

const samples = Object.create(context.TestDatingApp.prototype);
Object.assign(samples, {
  cityLocationMaxAccuracyMeters: 1000,
  hasBrowserGeolocation: true,
  userLocation: { lat: 43.4675, lng: -79.6877, accuracy: 15 }
});
if (!samples.shouldAcceptBrowserLocationSample({
  coords: { latitude: 43.4675, longitude: -79.6870, accuracy: 15 }
})) {
  throw new Error('A real movement of about 50 metres must not be frozen.');
}
if (samples.shouldAcceptBrowserLocationSample({
  coords: { latitude: 43.4675, longitude: -79.68762, accuracy: 15 }
})) {
  throw new Error('Stationary GPS jitter must not replace the current fix.');
}

let retries = 0;
const transient = Object.create(context.TestDatingApp.prototype);
Object.assign(transient, {
  hasBrowserGeolocation: false,
  userLocation: null,
  currentUserLocationSource: '',
  googleListingLocationScope: {},
  scheduleLocationTrackingRetry() { retries += 1; },
  updateHomeCurrentLocationDisplay() {},
  showNotification() {}
});
transient.handleLocationError({ code: 2 });
if (retries !== 1) throw new Error('A transient failure must schedule recovery.');

let stopped = false;
const revoked = Object.create(context.TestDatingApp.prototype);
Object.assign(revoked, {
  hasBrowserGeolocation: true,
  userLocation: { lat: 43.65, lng: -79.38 },
  currentUserLocationSource: 'device',
  currentUser: { location: { city: 'Toronto', lat: 43.65, lng: -79.38 } },
  googleListingLocationScope: {},
  stopLocationTracking() { stopped = true; },
  updateHomeCurrentLocationDisplay() {},
  showNotification() {},
  scheduleLocationTrackingRetry() {}
});
revoked.handleLocationError({ code: 1 });
if (!stopped || revoked.userLocation !== null || revoked.currentUser.location.city) {
  throw new Error('Revoked permission must expire the previous live fix.');
}
if (typeof errorCallback !== 'function') throw new Error('Missing geolocation error callback.');

console.log('Location lifecycle test passed.');
