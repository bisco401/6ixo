/* Keep real listing photos usable across feeds, galleries and dynamically added cards. */
(() => {
    const fallback = '/assets/listing-photo-unavailable.svg';
    const selector = [
        '.carousel-track img', '.featured-ad-card img', '.home-card-img',
        '.marketplace-item-media > img', '.home-deal-media > img', '.listing-media > img',
        '.community-feed-media > img', '.jobs-feed-image img', '.jobs-logo img',
        '.vehicle-smart-card-media > img', '.vehicle-smart-map-card > img', '.vehicle-rental-map-card > img',
        '.hookup-plus-card-media > img', '.shortstays-map-preview-item > img', '.arrive-discovery-photo > img',
        '.seller-listing-thumb', '.seller-profile-rental-media', '.profile-offer-card img',
        '.my-post-thumb', '.my-auction-thumb', '.category-photo-click',
        '#marketplace-item-track img', '#vehicle-modal-image', '#realestate-modal-image',
        '#service-modal-image', '#luxury-ad-image', '#seller-profile-luxury-image',
        '#ml-frame img', '.ml-thumb img', '.marketplace-media-thumb img', '.vehicle-media-thumb img', '.realestate-media-thumb img'
    ].join(', ');
    function normalizeSource(value, base = 'https://6ixo.com/') {
        if (!value) return '';
        try {
            const url = new URL(value, base);
            if (url.hostname === 'media.kijiji.ca') {
                url.searchParams.set('rule', 'kijijica-1600-webp');
            }
            if (url.hostname === 'images.craigslist.org') {
                url.pathname = url.pathname.replace(/_(?:50x50c|300x300|600x450)(?=\.)/i, '_1200x900');
            }
            if (url.hostname === 'storage.albacars.ae' && url.pathname.startsWith('/vehicles/')) {
                // The unbounded originals are 6000px; explicit JPEG avoids format negotiation on iOS.
                url.searchParams.set('width', '1600');
                url.searchParams.set('format', 'jpeg');
            }
            if (url.hostname === 'via.placeholder.com') return new URL(fallback, base).href;
            return url.href;
        } catch { return ''; }
    }
    if (typeof module === 'object' && module.exports) {
        module.exports = { normalizeSource };
        return;
    }
    window.ListingImageQuality = { normalizeSource };
    const states = new WeakMap();
    let cache = {};
    const absolute = value => { try { return new URL(value, document.baseURI).href; } catch { return ''; } };
    const normalized = value => normalizeSource(value, document.baseURI);
    const cacheKey = value => {
        const url = new URL(normalized(value));
        // Dealer query strings describe renditions of the same original photo.
        if (url.hostname === 'storage.albacars.ae') url.search = '';
        return url.href;
    };
    const cached = value => { try { return cache[absolute(value)] || cache[cacheKey(value)] || ''; } catch { return ''; } };
    const src = image => absolute(image.getAttribute('src') || '');
    function stateFor(image) {
        let state = states.get(image);
        const current = src(image);
        if (!state || state.current !== current) {
            state = { original: current, current, attempted: new Set(), retried: new Set() };
            states.set(image, state);
        }
        return state;
    }
    function assign(image, source, state) {
        state.current = absolute(source);
        image.removeAttribute('srcset');
        image.src = state.current;
    }
    function gallery(image) {
        const values = [];
        const carousel = image.closest('[data-gallery-photos]');
        try { values.push(...JSON.parse(carousel?.dataset.galleryPhotos || '[]')); } catch {}
        const host = image.closest('[data-images]');
        for (const value of String(host?.dataset.images || '').split('|')) {
            try { if (value) values.push(decodeURIComponent(value)); } catch {}
        }
        try {
            const context = window.app?.resolveSitewideListingImageContext?.(image);
            for (const value of context?.sources || []) {
                if (typeof value === 'string') values.push(value);
                else if (value?.type !== 'video') values.push(value?.src || value?.url || '');
            }
        } catch {}
        image.closest('.carousel-track')?.querySelectorAll('img').forEach(other => {
            values.push(states.get(other)?.original || other.getAttribute('src'));
        });
        return values.filter(value => typeof value === 'string' && value && !/\.(mp4|webm|mov)(?:[?#]|$)/i.test(value));
    }
    function recover(image) {
        const state = stateFor(image);
        const current = src(image);
        // Some providers reject the site's Referer. Retry once after removing it,
        // including requests that started before the mutation observer ran.
        if (/^https?:/.test(current) && new URL(current).origin !== location.origin && !state.retried.has(current)) {
            state.retried.add(current);
            image.referrerPolicy = 'no-referrer';
            assign(image, current, state);
            return;
        }
        state.attempted.add(current);
        const candidates = [state.original, ...gallery(image)]
            // A larger CDN rendition can be unavailable even while the original
            // stored URL still works. Preserve that exact-photo fallback.
            .flatMap(value => [cached(value), normalized(value), absolute(value)])
            .filter(Boolean).concat(absolute(fallback));
        const next = candidates.map(absolute).find(value => !state.attempted.has(value));
        if (!next) return;
        assign(image, next, state);
    }
    function prepare(image) {
        if (!image.matches(selector) || !image.getAttribute('src')) return;
        const state = stateFor(image);
        image.referrerPolicy = 'no-referrer';
        const preferred = cached(state.original) || normalized(state.original);
        if (preferred && absolute(preferred) !== src(image) && !state.attempted.has(absolute(preferred)) && (!state.attempted.size || cached(state.original))) assign(image, preferred, state);
        if (image.complete && !image.naturalWidth) recover(image);
    }
    function visit(root) {
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        if (root.matches?.(selector)) prepare(root);
        root.querySelectorAll?.(selector).forEach(prepare);
    }
    // Capture errors before the individual modal handlers replace a usable gallery with a placeholder.
    document.addEventListener('error', event => {
        const image = event.target;
        if (image?.tagName !== 'IMG' || !image.matches(selector)) return;
        event.stopImmediatePropagation();
        recover(image);
    }, true);
    new MutationObserver(changes => {
        for (const change of changes) {
            if (change.type === 'attributes') prepare(change.target);
            else change.addedNodes.forEach(visit);
        }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    visit(document);
    fetch('/data/listing-image-cache.json?v=20261109-quality-1', { cache: 'no-cache' }).then(response => response.ok ? response.json() : {})
        .then(value => { cache = value; visit(document); }).catch(() => {});
})();
