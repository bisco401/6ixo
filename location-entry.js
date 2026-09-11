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
    let legacyVisitor = false;
    try { legacyVisitor = !choice && Boolean(window.localStorage?.getItem('sixo_app_build_version')); } catch {}
    const firstVisit = !choice && !legacyVisitor;
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
    let requestHandler = null;
    let attempt = 0;
    let fallbackTimer = null;
    let dismissed = !firstVisit;
    let completed = !firstVisit;
    let observedPermission = 'unknown';
    let pauseAutomaticRequests = false;
    let panel = null;

    const hidePrompt = () => {
        if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
        if (panel) panel.hidden = true;
    };

    const showPrompt = (error = null) => {
        if (dismissed || completed) return false;
        if (!panel) {
            panel = document.createElement('section');
            panel.className = 'location-entry-prompt';
            panel.setAttribute('aria-label', 'Nearby listings location');
            panel.innerHTML = `
                <h2>Find listings near you</h2>
                <p data-location-entry-message role="status"></p>
                <div class="location-entry-actions">
                    <button type="button" data-location-entry-allow>Allow location</button>
                    <button type="button" data-location-entry-dismiss>Not now</button>
                </div>`;
            panel.querySelector('[data-location-entry-allow]').addEventListener('click', () => {
                remember('requested');
                const button = panel.querySelector('[data-location-entry-allow]');
                button.disabled = true;
                button.textContent = 'Locating…';
                panel.querySelector('[data-location-entry-message]').textContent = 'Choose Allow in your browser’s location prompt.';
                // Call geolocation directly during the tap, without awaiting a
                // permission query or loading the main marketplace first.
                const result = requestHandler ? requestHandler() : request({ userInitiated: true });
                void Promise.resolve(result).finally(() => {
                    button.disabled = !navigator.geolocation || window.isSecureContext === false;
                    if (button.textContent === 'Locating…') button.textContent = 'Try location again';
                });
            });
            panel.querySelector('[data-location-entry-dismiss]').addEventListener('click', () => {
                remember('dismissed');
                pauseAutomaticRequests = true;
                dismissed = true;
                completed = true;
                hidePrompt();
            });
            document.body.appendChild(panel);
        }
        const unavailable = !navigator.geolocation || window.isSecureContext === false;
        panel.querySelector('[data-location-entry-message]').textContent = unavailable
            ? 'Open https://6ixo.com in Safari or Chrome to enable location. You can still browse without it.'
            : Number(error?.code) === 1
                ? 'Allow location for 6ixo.com in your browser and device settings, then try again. If you scanned a QR code, open the page in Safari or Chrome.'
                : error
                    ? 'Your location could not be found. Try again, or continue browsing without it.'
                    : 'Choose Allow in your browser’s location prompt. If no prompt appears, tap Allow location below.';
        const allowButton = panel.querySelector('[data-location-entry-allow]');
        allowButton.disabled = unavailable;
        allowButton.textContent = error ? 'Try location again' : 'Allow location';
        panel.hidden = false;
        return true;
    };

    function recordPermission(state) {
        if (state === 'granted') {
            observedPermission = 'granted';
            pauseAutomaticRequests = false;
            remember('allowed');
            completed = true;
            hidePrompt();
        } else if (state === 'denied') {
            observedPermission = 'denied';
            remember('denied');
        }
    }

    function canRequestAutomatically(state = observedPermission) {
        if (state === 'granted') return true;
        // The saved choice controls the introductory panel, not browser access.
        // Safari may not support Permissions.query, so each visit needs a fresh
        // platform check. A denial observed on this page still stops retries.
        return state !== 'denied' && !pauseAutomaticRequests;
    }

    function request({ userInitiated = false } = {}) {
        if (pending && (!userInitiated || pendingUserInitiated)) return pending;
        if (!userInitiated && !canRequestAutomatically()) return Promise.resolve({ skipped: true });
        if (userInitiated) {
            pauseAutomaticRequests = false;
            remember('requested');
        }
        pendingUserInitiated = userInitiated;
        if (!pending) pending = new Promise((resolve) => { resolvePending = resolve; });
        const requestPromise = pending;
        const requestAttempt = ++attempt;
        if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;

        const finish = (result) => {
            // An older automatic request must not overwrite a newer button retry.
            if (requestAttempt !== attempt) return;
            latestResult = { ...result, userInitiated };
            const resolve = resolvePending;
            pending = null;
            pendingUserInitiated = false;
            resolvePending = null;
            hidePrompt();
            if (result.position) recordPermission('granted');
            else if (Number(result.error?.code) === 1) recordPermission('denied');
            if (result.error) showPrompt(result.error);
            try {
                if (resultHandler) resultHandler(latestResult);
            } catch (error) {
                console.warn('Unable to apply entry location:', error);
            } finally {
                resolve(latestResult);
            }
        };

        if (!navigator.geolocation || window.isSecureContext === false) {
            finish({ error: { code: 1, message: 'Location requires a supported browser and HTTPS.' } });
            return requestPromise;
        }
        try {
            navigator.geolocation.getCurrentPosition(
                (position) => finish({ position }),
                (error) => finish({ error }),
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
            );
        } catch (error) {
            finish({ error });
        }
        if (pending) {
            // Keep a visible user-gesture option if the scanner browser leaves
            // the automatic permission request unanswered or quietly suppresses it.
            fallbackTimer = window.setTimeout(() => {
                fallbackTimer = null;
                showPrompt();
            }, 1500);
        }
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
