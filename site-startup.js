(function monitorSiteStartup(window, document) {
    'use strict';

    var timer;
    var notice = null;

    function recover() {
        if (window.app || notice || !document.body) return;
        var loading = document.getElementById('loading-screen');
        if (loading) loading.style.display = 'none';
        var main = document.getElementById('main-app');
        if (main) main.classList.remove('hidden');
        notice = document.createElement('div');
        notice.id = 'site-startup-notice';
        notice.setAttribute('role', 'status');
        notice.style.cssText = 'position:fixed;top:1rem;left:1rem;right:1rem;z-index:2147483000;max-width:620px;margin:0 auto;padding:1rem;border-radius:12px;background:#fff;color:#172554;box-shadow:0 8px 32px #0003;font-family:system-ui,sans-serif;';
        var message = document.createElement('p');
        message.textContent = 'Some site features did not finish loading.';
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Try again';
        retry.style.cssText = 'padding:.65rem 1rem;border:0;border-radius:8px;background:#1456b8;color:#fff;font:inherit;cursor:pointer;';
        retry.addEventListener('click', function () {
            var next = new URL(window.location.href);
            next.searchParams.set('retry', String(Date.now()));
            window.location.replace(next.toString());
        });
        notice.appendChild(message);
        notice.appendChild(retry);
        document.body.appendChild(notice);
    }

    window.addEventListener('sixo:app-ready', function () {
        window.clearTimeout(timer);
        if (notice) {
            notice.remove();
            notice = null;
        }
    });
    window.addEventListener('error', function (event) {
        var target = event.target;
        if (target && target.tagName === 'SCRIPT' && /\/(?:app\.js|assets\/vendor\/supabase-[^/]+\.js)(?:\?|$)/.test(target.src || '')) {
            recover();
        }
    }, true);
    timer = window.setTimeout(recover, 25000);
})(window, document);
