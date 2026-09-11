(function setupLocationEntry() {
    'use strict';

    if (window.SIXO_APP_VARIANT === 'marketplace-native' || window.SIXO_LOCATION_ENTRY) return;

    let pending = null;
    let pendingUserInitiated = false;
    let resolvePending = null;
    let latestResult = null;
    let resultHandler = null;
    let requestHandler = null;
    let attempt = 0;
    let fallbackTimer = null;
    let dismissed = false;
    let panel = null;

    const hidePrompt = () => {
        if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
        if (panel) panel.hidden = true;
    };

    const showPrompt = (error = null) => {
        if (dismissed) return;
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
                // Call geolocation directly during the tap, without awaiting a
                // permission query or loading the main marketplace first.
                if (requestHandler) {
                    dismissed = false;
                    void requestHandler();
                } else {
                    void request({ userInitiated: true });
                }
            });
            panel.querySelector('[data-location-entry-dismiss]').addEventListener('click', () => {
                dismissed = true;
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
    };

    function request({ userInitiated = false } = {}) {
        if (pending && (!userInitiated || pendingUserInitiated)) return pending;
        if (userInitiated) dismissed = false;
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
        showPrompt(error, { force = false } = {}) {
            if (force) dismissed = false;
            showPrompt(error);
        },
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
