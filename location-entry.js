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

    // The browser permission dialog is the only location prompt. Keep these
    // hooks compatible with the app while older cached bundles finish loading.
    const hidePrompt = () => {};
    const showPrompt = () => false;

    function recordPermission(state) {
        if (state === 'granted') {
            observedPermission = 'granted';
            pauseAutomaticRequests = false;
            remember('allowed');
            hidePrompt();
        } else if (state === 'denied') {
            observedPermission = 'denied';
            remember('denied');
            pauseAutomaticRequests = true;
            hidePrompt();
        }
    }

    function canRequestAutomatically(state = observedPermission) {
        if (state === 'granted') return true;
        // A stored choice never grants browser permission. It does prevent
        // prompting again after a refusal, including Safari without Permissions.
        if (state === 'denied' || pauseAutomaticRequests) return false;
        if (choice === 'denied' || choice === 'dismissed') return false;
        if (state === 'prompt' && choice === 'allowed') return false;
        return true;
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
        if (requestTimer != null) window.clearTimeout(requestTimer);

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
        return requestPromise;
    }

    window.SIXO_LOCATION_ENTRY = {
        request,
        get pendingRequest() { return pending; },
        setRequestHandler() {},
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
