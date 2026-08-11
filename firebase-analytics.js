(function initializeFirebaseAnalytics(window, document) {
    'use strict';

    const measurementId = 'G-S7TXHGY6RB';
    const storageKey = 'sixo_analytics_consent_v1';
    const allowedChoices = new Set(['granted', 'denied']);
    let analyticsLoaded = false;
    let preferencePanel = null;

    function readChoice() {
        try {
            const value = String(window.localStorage.getItem(storageKey) || '');
            return allowedChoices.has(value) ? value : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function saveChoice(choice) {
        try {
            window.localStorage.setItem(storageKey, choice);
        } catch {}
    }

    function updateStatus() {
        const choice = readChoice();
        document.documentElement.dataset.sixoAnalytics = analyticsLoaded ? 'loaded' : choice;
        window.sixoAnalyticsStatus = Object.freeze({
            configured: true,
            loaded: analyticsLoaded,
            consent: choice,
            measurementId
        });
    }

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() {
        window.dataLayer.push(arguments);
    };
    window.gtag('consent', 'default', {
        analytics_storage: readChoice() === 'granted' ? 'granted' : 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        wait_for_update: 500
    });

    function loadAnalytics() {
        if (analyticsLoaded || readChoice() !== 'granted') return;
        analyticsLoaded = true;
        window.gtag('consent', 'update', {
            analytics_storage: 'granted',
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied'
        });
        window.gtag('js', new Date());
        window.gtag('config', measurementId, {
            anonymize_ip: true,
            allow_google_signals: false,
            allow_ad_personalization_signals: false
        });

        if (!document.querySelector(`script[data-sixo-analytics="${measurementId}"]`)) {
            const analyticsScript = document.createElement('script');
            analyticsScript.async = true;
            analyticsScript.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
            analyticsScript.dataset.sixoAnalytics = measurementId;
            analyticsScript.addEventListener('load', updateStatus);
            analyticsScript.addEventListener('error', () => {
                analyticsLoaded = false;
                updateStatus();
                console.warn('6ixo analytics could not load.');
            });
            document.head.appendChild(analyticsScript);
        }
        updateStatus();
    }

    function clearAnalyticsCookies() {
        const cookieNames = String(document.cookie || '')
            .split(';')
            .map((part) => part.trim().split('=')[0])
            .filter((name) => name === '_ga' || name.startsWith('_ga_'));
        cookieNames.forEach((name) => {
            document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
            document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${window.location.hostname}; SameSite=Lax`;
        });
    }

    function closePreferences() {
        preferencePanel?.remove();
        preferencePanel = null;
    }

    function chooseAnalytics(choice) {
        if (!allowedChoices.has(choice)) return;
        saveChoice(choice);
        window.gtag('consent', 'update', {
            analytics_storage: choice,
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied'
        });
        if (choice === 'granted') loadAnalytics();
        else clearAnalyticsCookies();
        updateStatus();
        closePreferences();
        window.dispatchEvent(new CustomEvent('sixo:privacy-choice-changed', {
            detail: { analytics: choice }
        }));
    }

    function ensurePreferenceStyles() {
        if (document.getElementById('sixo-privacy-choice-styles')) return;
        const style = document.createElement('style');
        style.id = 'sixo-privacy-choice-styles';
        style.textContent = `
            .sixo-privacy-choice {
                position: fixed;
                inset: auto 0.75rem 0.75rem;
                z-index: 2147483000;
                max-width: 620px;
                margin: 0 auto;
                padding: 1rem;
                border: 1px solid rgba(116, 144, 188, 0.35);
                border-radius: 18px;
                background: rgba(8, 23, 50, 0.98);
                color: #fff;
                box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
                font-family: "Space Grotesk", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .sixo-privacy-choice__head {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 1rem;
            }
            .sixo-privacy-choice h2 {
                margin: 0;
                color: #fff;
                font-size: 1.05rem;
                line-height: 1.25;
            }
            .sixo-privacy-choice p {
                margin: 0.5rem 0 0;
                color: rgba(255, 255, 255, 0.76);
                font-size: 0.88rem;
                line-height: 1.5;
            }
            .sixo-privacy-choice a { color: #a9ceff; }
            .sixo-privacy-choice__close {
                display: grid;
                flex: 0 0 auto;
                width: 34px;
                height: 34px;
                padding: 0;
                place-items: center;
                border: 1px solid rgba(255, 255, 255, 0.22);
                border-radius: 50%;
                background: transparent;
                color: #fff;
                font: inherit;
                cursor: pointer;
            }
            .sixo-privacy-choice__actions {
                display: flex;
                flex-wrap: wrap;
                gap: 0.55rem;
                margin-top: 0.9rem;
            }
            .sixo-privacy-choice__button {
                min-height: 42px;
                padding: 0.62rem 0.9rem;
                border: 1px solid #77afff;
                border-radius: 11px;
                background: #1456b8;
                color: #fff;
                font: inherit;
                font-size: 0.86rem;
                font-weight: 800;
                cursor: pointer;
            }
            .sixo-privacy-choice__button--secondary {
                background: transparent;
                color: #d9eaff;
            }
        `;
        document.head.appendChild(style);
    }

    function openPreferences() {
        if (!document.body) return;
        closePreferences();
        ensurePreferenceStyles();
        const choice = readChoice();
        const panel = document.createElement('section');
        panel.className = 'sixo-privacy-choice';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'sixo-privacy-choice-title');
        panel.setAttribute('aria-describedby', 'sixo-privacy-choice-description');
        panel.innerHTML = `
            <div class="sixo-privacy-choice__head">
                <div>
                    <h2 id="sixo-privacy-choice-title">Privacy choices</h2>
                    <p id="sixo-privacy-choice-description">We use necessary storage to run 6ixo. Optional Google Analytics helps us understand site performance and loads only if you accept. <a href="/privacy/">Read the Privacy Policy</a>.</p>
                </div>
                <button class="sixo-privacy-choice__close" type="button" aria-label="Close privacy choices">&times;</button>
            </div>
            <div class="sixo-privacy-choice__actions">
                <button class="sixo-privacy-choice__button" type="button" data-analytics-choice="granted">Accept analytics</button>
                <button class="sixo-privacy-choice__button sixo-privacy-choice__button--secondary" type="button" data-analytics-choice="denied">Only necessary</button>
            </div>
            ${choice === 'unknown' ? '' : `<p>Your current analytics choice is <strong>${choice === 'granted' ? 'accepted' : 'only necessary'}</strong>.</p>`}
        `;
        panel.querySelector('.sixo-privacy-choice__close')?.addEventListener('click', closePreferences);
        panel.querySelectorAll('[data-analytics-choice]').forEach((button) => {
            button.addEventListener('click', () => chooseAnalytics(button.dataset.analyticsChoice));
        });
        document.body.appendChild(panel);
        preferencePanel = panel;
        panel.querySelector('[data-analytics-choice="denied"]')?.focus({ preventScroll: true });
    }

    window.sixoAnalytics = Object.freeze({
        logEvent: (eventName, eventParameters) => {
            if (readChoice() !== 'granted') return;
            loadAnalytics();
            window.gtag('event', eventName, eventParameters || {});
        }
    });

    window.sixoPrivacy = Object.freeze({
        analyticsChoice: readChoice,
        openPreferences,
        setAnalyticsChoice: chooseAnalytics
    });

    function initializePrivacyControls() {
        document.addEventListener('click', (event) => {
            const trigger = event.target.closest?.('[data-open-privacy-choices]');
            if (!trigger) return;
            event.preventDefault();
            openPreferences();
        });
        if (readChoice() === 'unknown') openPreferences();
    }

    updateStatus();
    if (readChoice() === 'granted') loadAnalytics();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializePrivacyControls, { once: true });
    } else {
        initializePrivacyControls();
    }

    window.dispatchEvent(new CustomEvent('sixo:analytics-ready', {
        detail: window.sixoAnalytics
    }));
})(window, document);
