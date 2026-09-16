(function setupLocationEntry() {
    'use strict';

    if (window.SIXO_APP_VARIANT === 'marketplace-native' || window.SIXO_LOCATION_ENTRY) return;

    const preferenceKey = 'sixo_location_onboarding_v1';
    const validChoices = new Set(['seen', 'requested', 'allowed', 'denied', 'dismissed']);
    const readPreference = () => {
        let saved = '';
        try { saved = window.localStorage?.getItem(preferenceKey) || ''; } catch {}
        if (!validChoices.has(saved)) {
            try {
                saved = String(document.cookie || '').split(';').map(part => part.trim())
                    .find(part => part.startsWith(`${preferenceKey}=`))?.split('=')[1] || '';
            } catch {}
        }
        return validChoices.has(saved) ? saved : '';
    };
    let choice = readPreference();
    const remember = (value) => {
        if (choice === value) return;
        choice = value;
        try { window.localStorage?.setItem(preferenceKey, value); } catch {}
        try {
            document.cookie = `${preferenceKey}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${window.location?.protocol === 'https:' ? '; Secure' : ''}`;
        } catch {}
    };
    // Remember the visit immediately, even if the visitor reloads without
    // answering. Store only the onboarding choice, never device coordinates.
    if (!choice) remember('seen');

    let pending = null;
    let pendingUserInitiated = false;
    let resolvePending = null;
    let latestResult = null;
    let resultHandler = null;
    let attempt = 0;
    let requestTimer = null;
    let observedPermission = 'unknown';
    let pauseAutomaticRequests = false;

    let requestHandler = null;
    let fallbackTimer = null;
    let panel = null;
    let dismissed = false;
    let confirmed = false;

    const hidePrompt = () => {
        if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
        if (panel) panel.hidden = true;
    };
    const showPrompt = (error = null, { force = false } = {}) => {
        if (force) dismissed = false;
        if (dismissed || (!error && confirmed) || document.visibilityState === 'hidden') return false;
        if (!panel) {
            panel = document.createElement('section');
            panel.className = 'location-entry-prompt';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-labelledby', 'location-entry-title');
            panel.innerHTML = `
                <h2 id="location-entry-title">Use your device location</h2>
                <p data-location-entry-message role="status"></p>
                <div class="location-entry-actions">
                    <button type="button" data-location-entry-allow>Use my location</button>
                    <button type="button" data-location-entry-dismiss>Not now</button>
                </div>`;
            panel.querySelector('[data-location-entry-allow]').addEventListener('click', () => {
                dismissed = false;
                hidePrompt();
                // Invoke the device API synchronously during this tap. Some
                // browsers will not open permission UI from a background request.
                void (requestHandler ? requestHandler() : request({ userInitiated: true }));
            });
            panel.querySelector('[data-location-entry-dismiss]').addEventListener('click', () => {
                dismissed = true;
                pauseAutomaticRequests = true;
                hidePrompt();
            });
            document.body.appendChild(panel);
        }
        const unsupported = !navigator.geolocation || window.isSecureContext === false;
        const blocked = Number(error?.code) === 1;
        panel.querySelector('[data-location-entry-message]').textContent = unsupported
            ? 'Open https://6ixo.com in Safari or Chrome to use your device location.'
            : blocked
                ? 'Your browser or device is blocking location. Allow location for 6ixo.com in your browser’s website settings and enable Location Services on your device, then try again.'
                : error
                    ? 'Your location could not be found yet. Try again to show your city and country in the search bar.'
                    : 'Tap Use my location, then choose Allow in your browser. Your city and country will appear in the search bar.';
        const button = panel.querySelector('[data-location-entry-allow]');
        button.disabled = unsupported;
        button.textContent = error ? 'Try again' : 'Use my location';
        panel.hidden = false;
        return true;
    };

    function recordPermission(state) {
        if (state === 'granted') {
            observedPermission = 'granted';
            confirmed = true;
            pauseAutomaticRequests = false;
            remember('allowed');
            hidePrompt();
        } else if (state === 'denied') {
            observedPermission = 'denied';
            confirmed = false;
            remember('denied');
            pauseAutomaticRequests = true;
            hidePrompt();
        }
    }

    function canRequestAutomatically(state = observedPermission) {
        if (state === 'granted') return true;
        // The browser owns permission, including permission expiry and Settings
        // changes. Saved onboarding choices must never suppress a fresh device
        // request on a later visit (Safari may not expose Permissions.query).
        // A denial received on this page still stops automatic retries.
        return state !== 'denied' && !pauseAutomaticRequests;
    }

    function request({ userInitiated = false } = {}) {
        if (pending && (!userInitiated || pendingUserInitiated)) return pending;
        if (!userInitiated && !canRequestAutomatically()) return Promise.resolve({ skipped: true });
        if (userInitiated) {
            dismissed = false;
            pauseAutomaticRequests = false;
            remember('requested');
        }
        pendingUserInitiated = userInitiated;
        if (!pending) pending = new Promise((resolve) => { resolvePending = resolve; });
        const requestPromise = pending;
        const requestAttempt = ++attempt;
        if (requestTimer != null) window.clearTimeout(requestTimer);
        hidePrompt();

        const finish = (result) => {
            // An older automatic request must not overwrite a newer button retry.
            if (requestAttempt !== attempt) return;
            attempt += 1;
            if (requestTimer != null) window.clearTimeout(requestTimer);
            requestTimer = null;
            latestResult = { ...result, userInitiated };
            const resolve = resolvePending;
            pending = null;
            pendingUserInitiated = false;
            resolvePending = null;
            hidePrompt();
            if (result.position) recordPermission('granted');
            else if (Number(result.error?.code) === 1) recordPermission('denied');
            try {
                if (resultHandler) resultHandler(latestResult);
            } catch (error) {
                console.warn('Unable to apply entry location:', error);
            } finally {
                resolve(latestResult);
            }
            if (result.error) showPrompt(result.error, { force: userInitiated });
        };

        if (!navigator.geolocation || window.isSecureContext === false) {
            finish({ error: { code: 1, message: 'Location requires a supported browser and HTTPS.' } });
            return requestPromise;
        }
        // A browser that suppresses a request can omit both callbacks. Settle
        // it so app recovery and a later tap can acquire a fresh device fix.
        requestTimer = window.setTimeout(() => {
            finish({ error: { code: 3, message: 'Device location timed out.' } });
        }, 22000);
        try {
            navigator.geolocation.getCurrentPosition(
                (position) => finish({ position }),
                (error) => finish({ error }),
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
            );
        } catch (error) {
            finish({ error });
        }
        if (pending) fallbackTimer = window.setTimeout(() => {
            fallbackTimer = null;
            showPrompt();
        }, 1500);
        return requestPromise;
    }

    window.SIXO_LOCATION_ENTRY = {
        request,
        get pendingRequest() { return pending; },
        setRequestHandler(handler) { requestHandler = handler; },
        hidePrompt,
        showPrompt,
        recordPermission,
        canRequestAutomatically,
        cancel() {
            if (!pending) return;
            attempt += 1;
            if (requestTimer != null) window.clearTimeout(requestTimer);
            requestTimer = null;
            const resolve = resolvePending;
            pending = null;
            pendingUserInitiated = false;
            resolvePending = null;
            hidePrompt();
            resolve({ cancelled: true });
        },
        connect(handler) {
            resultHandler = handler;
            if (latestResult) handler(latestResult);
        }
    };

    // This runs on the QR landing page, including the coming-soon screen,
    // before the marketplace bundle or its remote dependencies finish loading.
    void request();
})();
