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
    let cancelDesktopWatch = null;
    let observedPermission = 'unknown';
    // Each new page entry asks visibly, including a returning QR visitor.
    let pauseAutomaticRequests = true;

    let requestHandler = null;
    let dismissHandler = null;
    let fallbackTimer = null;
    let panel = null;
    let dismissed = false;
    let confirmed = false;

    // Desktop location services can report POSITION_UNAVAILABLE before their
    // Wi-Fi scan completes. Keep one fresh, low-power subscription alive while
    // the ordinary request runs; callers bound its lifetime and own the result.
    const watchForDesktopPosition = (onPosition, onDenied) => {
        if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
            || typeof navigator.geolocation?.watchPosition !== 'function') return null;
        let id = null;
        let active = true;
        const watch = {
            cancel() {
                active = false;
                if (id != null) {
                    try { navigator.geolocation.clearWatch(id); } catch {}
                    id = null;
                }
            }
        };
        try {
            id = navigator.geolocation.watchPosition(
                position => {
                    const timestamp = Number(position?.timestamp);
                    const lat = position?.coords?.latitude;
                    const lng = position?.coords?.longitude;
                    if (active && Number.isFinite(timestamp) && timestamp > 0
                        && Date.now() - timestamp < 90000 && timestamp <= Date.now() + 5000
                        && typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
                        && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180) onPosition(position);
                },
                error => { if (active && Number(error?.code) === 1) onDenied(error); },
                { enableHighAccuracy: false, timeout: 60000, maximumAge: 0 }
            );
            // A platform callback may run synchronously before returning its id.
            if (!active) watch.cancel();
            return watch;
        } catch {
            watch.cancel();
            return null;
        }
    };

    const hidePrompt = () => {
        if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
        if (panel) panel.hidden = true;
    };
    const dismiss = () => {
        dismissed = true;
        pauseAutomaticRequests = true;
        remember('dismissed');
        // Retire both the early entry request and an app-owned request/watch.
        // A delayed GPS callback must not replace a deliberate city selection.
        latestResult = null;
        window.SIXO_LOCATION_ENTRY?.cancel();
        dismissHandler?.();
        hidePrompt();
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
                <h2 id="location-entry-title">“6ixo.com” Would Like to Use Your Location</h2>
                <p data-location-entry-message role="status"></p>
                <p data-location-entry-provider class="location-provider-disclosure">Your coordinates may be sent to BigDataCloud to name your city. It also uses GPS/IP data to improve its service. <a href="/privacy/#sharing" target="_blank" rel="noopener noreferrer">Privacy details</a></p>
                <div class="location-entry-actions">
                    <button type="button" data-location-entry-dismiss>Don’t Allow</button>
                    <button type="button" data-location-entry-allow>Allow</button>
                </div>`;
            panel.querySelector('[data-location-entry-allow]').addEventListener('click', () => {
                dismissed = false;
                pauseAutomaticRequests = false;
                remember('requested');
                // A new tap must not reuse a request suppressed by an embedded
                // browser. Retire it before asking during this user gesture.
                window.SIXO_LOCATION_ENTRY?.cancel();
                hidePrompt();
                // Invoke the device API synchronously during this tap. Some
                // browsers will not open permission UI from a background request.
                void (requestHandler ? requestHandler() : request({ userInitiated: true }));
            });
            panel.querySelector('[data-location-entry-dismiss]').addEventListener('click', dismiss);
            document.body.appendChild(panel);
        }
        const unsupported = !navigator.geolocation || window.isSecureContext === false;
        const blocked = Number(error?.code) === 1;
        const isMacSafari = /Macintosh/i.test(navigator.userAgent || '')
            && /Version\/[^ ]+.*Safari\//i.test(navigator.userAgent || '')
            && Number(navigator.maxTouchPoints || 0) === 0;
        const macHelp = isMacSafari
            ? ' On your Mac, enable Safari in System Settings → Privacy & Security → Location Services. In Safari Settings → Websites → Location, allow 6ixo.com.'
            : ' Check your browser’s location permission and your device’s Location Services.';
        panel.querySelector('[data-location-entry-message]').textContent = unsupported
            ? 'Open https://6ixo.com in Safari or Chrome to use your device location.'
            : blocked
                ? 'Your browser or device is blocking location. Allow location for 6ixo.com in your browser’s website settings and enable Location Services on your device, then try again.'
                : error
                    ? `Your browser has not provided a device location.${macHelp} Then try again, or choose your city in the search bar.`
                    : '“6ixo.com” uses your device location to show nearby listings. Would you like to allow access to your location?';
        const button = panel.querySelector('[data-location-entry-allow]');
        button.disabled = unsupported;
        button.textContent = error ? 'Try again' : 'Allow';
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
        if (pauseAutomaticRequests) return false;
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
        let desktopWatch = null;
        let lastError = null;
        if (requestTimer != null) window.clearTimeout(requestTimer);
        hidePrompt();

        const finish = (result) => {
            // An older automatic request must not overwrite a newer button retry.
            if (requestAttempt !== attempt) return;
            attempt += 1;
            if (requestTimer != null) window.clearTimeout(requestTimer);
            requestTimer = null;
            desktopWatch?.cancel();
            cancelDesktopWatch = null;
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
        desktopWatch = watchForDesktopPosition(
            position => finish({ position }),
            error => finish({ error })
        );
        if (!pending || requestAttempt !== attempt) {
            desktopWatch?.cancel();
            return requestPromise;
        }
        // Retiring an early entry request also retires its temporary watch.
        cancelDesktopWatch = () => desktopWatch?.cancel();
        requestTimer = window.setTimeout(() => {
            finish({ error: lastError || { code: 3, message: 'Device location timed out.' } });
        }, desktopWatch ? 62000 : 22000);
        try {
            navigator.geolocation.getCurrentPosition(
                (position) => finish({ position }),
                (error) => {
                    if (desktopWatch && [2, 3].includes(Number(error?.code))) lastError = error;
                    else finish({ error });
                },
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
            );
        } catch (error) {
            finish({ error });
        }
        if (pending && !desktopWatch) fallbackTimer = window.setTimeout(() => {
            fallbackTimer = null;
            showPrompt();
        }, 1500);
        return requestPromise;
    }

    window.SIXO_LOCATION_ENTRY = {
        request,
        get pendingRequest() { return pending; },
        setRequestHandler(handler) { requestHandler = handler; },
        setDismissHandler(handler) { dismissHandler = handler; },
        dismiss,
        hidePrompt,
        showPrompt,
        watchForDesktopPosition,
        recordPermission,
        canRequestAutomatically,
        cancel() {
            if (!pending) return;
            attempt += 1;
            if (requestTimer != null) window.clearTimeout(requestTimer);
            requestTimer = null;
            cancelDesktopWatch?.();
            cancelDesktopWatch = null;
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
    const showEntryPrompt = () => {
        if (!dismissed && pauseAutomaticRequests) showPrompt();
    };
    if (document.body) showEntryPrompt();
    else document.addEventListener('DOMContentLoaded', showEntryPrompt, { once: true });
    // A QR tab opened in the background must show the choice when it becomes visible.
    document.addEventListener('visibilitychange', showEntryPrompt);
})();
