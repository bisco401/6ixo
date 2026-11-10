/* A fresh, single-use Turnstile token for every Supabase auth request. */
(() => {
    'use strict';
    let loading = null;
    let busy = false;
    const unavailable = 'The security check could not load. Check your connection or content blocker, then try again.';
    const failure = message => Object.assign(new Error(message), { code: 'client_captcha_failed' });

    function loadTurnstile() {
        if (window.turnstile?.render) return Promise.resolve(window.turnstile);
        if (loading) return loading;
        loading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                delete window.__sixoTurnstileReady;
                if (error) { script.remove(); reject(error); }
                else resolve(window.turnstile);
            };
            const timer = setTimeout(() => finish(failure(unavailable)), 20000);
            window.__sixoTurnstileReady = () => finish(window.turnstile?.render ? null : failure(unavailable));
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__sixoTurnstileReady&render=explicit';
            script.async = true;
            script.onerror = () => finish(failure(unavailable));
            document.head.append(script);
        }).catch(error => { loading = null; throw error; });
        return loading;
    }

    function activeScreen(action) {
        const id = { signup: 'signup-screen', login: 'login-screen', resend: 'verify-email-screen' }[action];
        const screen = id ? document.getElementById(id) : document.querySelector('.auth-screen:not(.hidden)');
        if (!screen || screen.classList.contains('hidden')) throw failure('Open the form and try again.');
        return screen;
    }

    async function getOptions(action) {
        if (!['signup', 'login', 'recovery', 'resend'].includes(action)) throw failure('This security check is unavailable.');
        if (busy) throw failure('Please finish the current security check first.');
        const sitekey = String(window.SIXO_TURNSTILE_SITE_KEY || '').trim();
        if (!sitekey) throw failure('Sign-in security is temporarily unavailable. Please refresh and try again.');
        busy = true;
        let host;
        try {
            const screen = activeScreen(action);
            host = screen.querySelector('.auth-captcha');
            if (!host) {
                host = document.createElement('div');
                host.className = 'auth-captcha';
                const anchor = screen.querySelector('button[type="submit"], #verify-email-resend');
                if (!anchor) throw failure('Refresh this page before trying again.');
                anchor.before(host);
            }
            host.replaceChildren();
            const status = document.createElement('p');
            status.className = 'auth-captcha-status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.textContent = 'Checking your browser…';
            const widget = document.createElement('div');
            host.append(status, widget);
            host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            const turnstile = await loadTurnstile();
            if (screen.classList.contains('hidden')) throw failure('Security check cancelled. Please try again.');
            const captchaToken = await new Promise((resolve, reject) => {
                let widgetId;
                let finished = false;
                const finish = (error, token) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    observer.disconnect();
                    if (widgetId !== undefined) {
                        try { turnstile.remove(widgetId); } catch { /* Cleanup must not prevent settlement. */ }
                    }
                    if (error) reject(error);
                    else resolve(token);
                };
                const observer = new MutationObserver(() => {
                    if (screen.classList.contains('hidden')) finish(failure('Security check cancelled. Please try again.'));
                });
                observer.observe(screen, { attributes: true, attributeFilter: ['class'] });
                const timer = setTimeout(() => finish(failure('The security check timed out. Please try again.')), 90000);
                try {
                    widgetId = turnstile.render(widget, {
                        sitekey, action, theme: 'auto',
                        size: host.clientWidth < 300 ? 'compact' : 'flexible',
                        appearance: 'always', retry: 'never', 'response-field': false,
                        callback: token => queueMicrotask(() => {
                            if (screen.classList.contains('hidden')) return finish(failure('Security check cancelled. Please try again.'));
                            if (typeof token !== 'string' || !token.trim()) return finish(failure('Please try the security check again.'));
                            finish(null, token);
                        }),
                        'before-interactive-callback': () => { status.textContent = 'Complete the security check to continue.'; },
                        'error-callback': () => { finish(failure(unavailable)); return true; },
                        'expired-callback': () => finish(failure('The security check expired. Please try again.')),
                        'timeout-callback': () => finish(failure('The security check timed out. Please try again.')),
                        'unsupported-callback': () => finish(failure('Please use an up-to-date browser to complete the security check.'))
                    });
                    if (finished && widgetId !== undefined) turnstile.remove(widgetId);
                } catch { finish(failure(unavailable)); }
            });
            host.remove();
            return { captchaToken };
        } catch (error) {
            const status = host?.querySelector('.auth-captcha-status');
            if (status) status.textContent = error.message;
            throw error;
        } finally { busy = false; }
    }
    window.SixoAuthCaptcha = Object.freeze({ getOptions });
})();
