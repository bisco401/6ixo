(function setupDeviceLocationCheck() {
    'use strict';
    const button = document.getElementById('check-location');
    const result = document.getElementById('location-result');
    const title = document.getElementById('location-result-title');
    const details = document.getElementById('location-details');
    const nextStep = document.getElementById('location-next-step');
    if (!button || !result || !title || !details || !nextStep) return;
    let attempt = 0;
    let timer = null;
    const show = (heading, message, next = '') => {
        title.textContent = heading;
        details.textContent = message;
        nextStep.textContent = next;
        result.hidden = false;
    };
    button.addEventListener('click', () => {
        const currentAttempt = ++attempt;
        let settled = false;
        const finish = (heading, message, next) => {
            if (settled || currentAttempt !== attempt) return;
            settled = true;
            window.clearTimeout(timer);
            timer = null;
            button.disabled = false;
            button.textContent = 'Check again';
            show(heading, message, next);
        };
        if (!navigator.geolocation || window.isSecureContext === false) {
            finish('Location API unavailable', 'This browser cannot request device location on this page.', 'Open this page at https://6ixo.com/location-check/ in Safari or Chrome.');
            return;
        }
        button.disabled = true;
        button.textContent = 'Checking…';
        show('Waiting for your browser', 'If a browser permission prompt appears, choose Allow. This check may take up to one minute.');
        timer = window.setTimeout(() => finish('The browser did not respond', 'No location or error was returned within one minute. Reference: NO_CALLBACK.', 'Check your browser’s location permission and Location Services, then try again.'), 65000);
        try {
            // Call synchronously during the tap, without Permissions.query or
            // the marketplace’s scripts, watch, filters or reverse geocoding.
            navigator.geolocation.getCurrentPosition(position => {
                const lat = position?.coords?.latitude;
                const lng = position?.coords?.longitude;
                const timestamp = Number(position?.timestamp);
                const age = Number.isFinite(timestamp) ? Date.now() - timestamp : NaN;
                const validCoordinates = typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
                    && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180;
                const fresh = Number.isFinite(timestamp) && timestamp > 0 && age < 90000 && age >= -5000;
                if (!validCoordinates || !fresh) {
                    finish('The browser returned an unusable position', `Reference: ${validCoordinates ? 'STALE_TIMESTAMP' : 'INVALID_COORDINATES'}.\nSample age: ${Number.isFinite(age) ? Math.round(age / 1000) + ' seconds' : 'unavailable'}.`, 'Share this reference so the site can be checked against your browser’s actual response.');
                    return;
                }
                const accuracy = position.coords.accuracy;
                finish('Your browser can find your location', `Reference: DEVICE_POSITION_OK.\nAccuracy: ${typeof accuracy === 'number' && Number.isFinite(accuracy) ? Math.round(accuracy) + ' metres' : 'unavailable'}.\nSample age: ${Math.max(0, Math.round(age / 1000))} seconds.`, 'If Allow still fails on the marketplace, share this reference. The remaining issue is in the site’s location flow.');
            }, error => {
                const code = Number(error?.code);
                const reference = code === 1 ? 'PERMISSION_DENIED' : code === 2 ? 'POSITION_UNAVAILABLE' : code === 3 ? 'TIMEOUT' : 'PLATFORM_ERROR';
                finish(code === 1 ? 'Location access is blocked' : 'Your browser could not find a position', `Reference: ${reference}${Number.isFinite(code) ? ' (' + code + ')' : ''}.\nBrowser message: ${String(error?.message || 'No message was provided.').slice(0, 300)}`, code === 1 ? 'Allow 6ixo.com in your browser’s website settings and enable location for the browser in your device settings.' : 'If Location Services and browser permission are enabled, this points to the device’s positioning service. Share this reference so we can distinguish it from a site error.');
            }, {enableHighAccuracy: false, timeout: 60000, maximumAge: 0});
        } catch (error) {
            finish('The browser could not start the request', `Reference: PLATFORM_EXCEPTION.\n${String(error?.message || 'Device location is unavailable.').slice(0, 300)}`, 'Check browser location permission and Location Services, then try again.');
        }
    });
})();
