/* The homepage's three-card preview and full featured collection. */
(() => {
    const row = document.getElementById('home-featured-carousel');
    if (!row) return;
    const section = row.closest('#home-featured-ads-strip');
    const home = section.closest('#home-content');
    const heading = section.querySelector('.featured-ads-header h2');
    const viewAll = document.createElement('button');
    viewAll.type = 'button';
    viewAll.className = 'home-featured-view-all';
    viewAll.textContent = 'View all →';
    viewAll.setAttribute('aria-controls', row.id);
    viewAll.setAttribute('aria-expanded', 'false');
    section.querySelector('.featured-ads-header').append(viewAll);
    const announcement = document.createElement('span');
    announcement.className = 'home-featured-announcement';
    announcement.setAttribute('role', 'status');
    section.append(announcement);
    let expanded = false;
    let previousPageY = 0;
    let previousRowX = 0;

    const normalize = value => String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    const countryCodes = new Map();
    try {
        const names = new Intl.DisplayNames(['en'], { type: 'region' });
        for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
            const code = String.fromCharCode(a, b);
            const name = names.of(code);
            if (name && name !== code) countryCodes.set(normalize(name), code);
        }
    } catch { /* Full country names remain usable on older browsers. */ }
    for (const [name, code] of Object.entries({
        Canada: 'CA', CAN: 'CA', 'United States': 'US', USA: 'US', 'United States of America': 'US',
        'United Kingdom': 'GB', UK: 'GB', 'United Arab Emirates': 'AE', UAE: 'AE',
        Ghana: 'GH', Jamaica: 'JM', Guyana: 'GY', Ethiopia: 'ET', Kenya: 'KE', China: 'CN',
        'Ivory Coast': 'CI', 'Cape Verde': 'CV', 'Swaziland': 'SZ', 'Czech Republic': 'CZ',
        'South Korea': 'KR', 'North Korea': 'KP', 'East Timor': 'TL', 'Vatican City': 'VA',
        'The Bahamas': 'BS', 'The Gambia': 'GM', 'DR Congo': 'CD', 'Republic of the Congo': 'CG'
    })) countryCodes.set(normalize(name), code);
    function countryCode(country) {
        const text = String(country || '').trim();
        return countryCodes.get(normalize(text)) || (/^[a-z]{2}$/i.test(text) ? text.toUpperCase() : text);
    }
    const meaningful = value => value !== null && value !== undefined && String(value).trim() !== ''
        && !/^(unknown|unspecified|not specified|not available|n\/a|null|undefined|other)$/i.test(String(value).trim());
    function listingFor(card) {
        const id = card.dataset.adResourceId || card.dataset.postItemId || '';
        return window.app?.getMarketplaceItemById?.(id)
            || window.app?.vehicleListings?.find(item => String(item.id) === id)
            || {};
    }
    function basicDetails(item, card) {
        let attributes = item.attributes || {};
        if (typeof attributes === 'string') { try { attributes = JSON.parse(attributes); } catch { attributes = {}; } }
        const facts = new Map();
        function add(key, value) {
            if (meaningful(value) && ['string', 'number'].includes(typeof value)) facts.set(normalize(key), String(value).trim());
        }
        for (const source of [item, attributes, item.vehicle, item.realestate, item.service]) {
            if (source && typeof source === 'object') Object.entries(source).forEach(([key, value]) => add(key, value));
        }
        for (const entries of [attributes?.details, item.listingDetails, item.details]) {
            if (Array.isArray(entries)) entries.forEach(detail => { if (detail && typeof detail === 'object') { add(detail.key || detail.label, detail.value); add(detail.label, detail.value); } });
        }
        for (const entry of String(card.dataset.adDetails || '').split('|')) {
            const colon = entry.indexOf(':');
            if (colon > 0) add(entry.slice(0, colon), entry.slice(colon + 1));
        }
        const claim = `${item.title || card.dataset.adTitle || ''}\n${item.fullDescription || item.description || card.dataset.adDesc || ''}`;
        const capture = (key, pattern) => { if (!facts.has(key)) { const match = claim.match(pattern); if (match) add(key, match[1]); } };
        capture('ram', /\b(\d+\s*(?:GB|TB))\s*(?:of\s+)?RAM\b/i);
        capture('storage', /\b(\d+\s*(?:GB|TB))\s*(?:of\s+)?(?:storage|SSD|HDD)\b/i);
        capture('bedrooms', /\b(\d{1,2}(?:\.5)?)\s*[- ]?(?:bedrooms?|beds?|br)\b/i);
        capture('bathrooms', /\b(\d{1,2}(?:\.5)?)\s*[- ]?(?:bathrooms?|baths?)\b/i);
        const category = normalize(item.category || card.dataset.adCategory);
        const priority = /vehicle|car|rental/.test(category) && !/estate|apartment/.test(category)
            ? ['year', 'mileagekm', 'mileage', 'transmission', 'fueltype', 'condition']
            : /estate|propert|apartment|housing/.test(category)
                ? ['bedrooms', 'bathrooms', 'sqft', 'propertytype']
                : /electronic/.test(category)
                    ? ['ram', 'storage', 'condition', 'brand']
                    : /fashion|clothing/.test(category)
                        ? ['size', 'condition', 'brand', 'material']
                        : /job/.test(category) ? ['employmenttype', 'jobtype', 'workplace']
                            : ['condition', 'type', 'size', 'brand'];
        if (!facts.has('condition')) add('condition', card.dataset.adCondition);
        const result = [];
        for (const key of priority) {
            const value = facts.get(key);
            if (!meaningful(value)) continue;
            let text = value;
            if (key === 'ram' && !/ram/i.test(value)) text += ' RAM';
            if (key === 'storage' && !/storage|ssd|hdd/i.test(value)) text += ' storage';
            if (key === 'bedrooms' && /^\d+(\.\d+)?$/.test(value)) text += Number(value) === 1 ? ' bed' : ' beds';
            if (key === 'bathrooms' && /^\d+(\.\d+)?$/.test(value)) text += Number(value) === 1 ? ' bath' : ' baths';
            if (key === 'mileagekm' && /^[\d,.]+$/.test(value)) text += ' km';
            if (key === 'sqft' && /^[\d,.]+$/.test(value)) text += ' sq ft';
            if (key === 'condition') text = window.app?.marketplaceConditionLabel?.(value) || value;
            if (!result.includes(text)) result.push(text);
            if (result.length === 2) break;
        }
        return result.join(' · ') || card.dataset.adCategory || '';
    }
    function setText(element, text) {
        if (element.textContent !== text) element.textContent = text;
    }
    function savedKey(card) {
        const app = window.app;
        if (app?.getLuxuryAdDataFromCard && app?.getNativeSponsoredSaveKey) {
            return app.getNativeSponsoredSaveKey(app.getLuxuryAdDataFromCard(card));
        }
        return card.dataset.adResourceId || card.dataset.postItemId || '';
    }
    function decorate(card) {
        const body = card.querySelector('.featured-ad-body');
        if (!body || !window.app) return;
        let copy = body.querySelector('.home-featured-detail-copy');
        if (!copy) {
            copy = document.createElement('div');
            copy.className = 'home-featured-detail-copy';
            for (const [tag, className] of [['h4', 'home-featured-title'], ['p', 'home-featured-specs'], ['p', 'home-featured-price'], ['p', 'home-featured-location']]) {
                const element = document.createElement(tag); element.className = className; copy.append(element);
            }
            const pin = document.createElement('i'); pin.className = 'fas fa-location-dot'; pin.setAttribute('aria-hidden', 'true');
            copy.lastElementChild.append(pin, document.createElement('span'));
            body.append(copy);
        }
        const item = listingFor(card);
        const title = card.dataset.adTitle || item.title || 'Featured listing';
        setText(copy.querySelector('h4'), title);
        setText(copy.querySelector('.home-featured-specs'), basicDetails(item, card));
        setText(copy.querySelector('.home-featured-price'), card.dataset.adPrice || item.priceText || 'Contact for price');
        const country = card.dataset.adCountry || card.dataset.adOriginCountry || item.country || '';
        const city = String(card.dataset.adOriginCity || item.city || String(card.dataset.adLocation || '').split(',')[0]).trim().replace(/^City of\s+/i, '');
        const code = countryCode(country);
        const location = [normalize(city) === normalize(country) || normalize(city) === normalize(code) ? '' : city, code].filter(Boolean).join(', ');
        setText(copy.querySelector('.home-featured-location span'), location || 'Location not specified');
        copy.querySelector('.home-featured-location').setAttribute('aria-label', [city, country].filter(Boolean).join(', ') || 'Location not specified');
        let save = card.querySelector('.home-featured-save');
        if (!save) {
            save = document.createElement('button'); save.type = 'button'; save.className = 'home-featured-save';
            const icon = document.createElement('i'); icon.setAttribute('aria-hidden', 'true'); save.append(icon); card.append(save);
        }
        const key = savedKey(card);
        save.dataset.savedKey = key || '';
        save.disabled = !key;
        const saved = Boolean(window.app.isMarketplaceSaved?.(key));
        save.setAttribute('aria-pressed', String(saved));
        save.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${title}`);
        const iconClass = `${saved ? 'fas' : 'far'} fa-heart`;
        if (save.firstElementChild.className !== iconClass) save.firstElementChild.className = iconClass;
    }
    section.addEventListener('click', event => {
        const save = event.target.closest('.home-featured-save');
        if (!save || !section.contains(save)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!save.dataset.savedKey || !window.app?.toggleMarketplaceSaved) return;
        const saved = window.app.toggleMarketplaceSaved(save.dataset.savedKey);
        setText(announcement, saved ? 'Listing saved.' : 'Listing removed from saved.');
        schedule();
    }, true);
    document.addEventListener('click', event => {
        if (event.target.closest('#luxury-ad-save, .marketplace-save-btn')) schedule();
    }, true);
    window.addEventListener('storage', event => {
        if (event.key === 'hs_marketplace_saved' && window.app?.loadMarketplaceSaved) {
            window.app.marketplaceSaved = window.app.loadMarketplaceSaved(); schedule();
        }
    });
    viewAll.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) { previousPageY = window.scrollY; previousRowX = row.scrollLeft; }
        home.dataset.featuredView = expanded ? 'all' : 'preview';
        setText(heading, expanded ? 'All featured listings' : 'Featured listings');
        setText(viewAll, expanded ? '← Back' : 'View all →');
        viewAll.setAttribute('aria-expanded', String(expanded));
        requestAnimationFrame(() => {
            row.scrollTo({ left: expanded ? 0 : previousRowX, behavior: 'instant' });
            if (expanded) section.scrollIntoView({ block: 'start', behavior: 'instant' });
            else window.scrollTo({ top: previousPageY, behavior: 'instant' });
            schedule();
        });
    });
    const nav = document.createElement('nav');
    nav.className = 'home-featured-row-nav';
    nav.setAttribute('aria-label', 'Featured listings');
    nav.hidden = true;
    const previous = document.createElement('button');
    const next = document.createElement('button');
    const count = document.createElement('span');
    previous.type = next.type = 'button';
    previous.textContent = '‹';
    next.textContent = '›';
    previous.setAttribute('aria-label', 'Previous featured listings');
    next.setAttribute('aria-label', 'Next featured listings');
    previous.setAttribute('aria-controls', row.id);
    next.setAttribute('aria-controls', row.id);
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
    nav.append(previous, count, next);
    row.after(nav);

    let frame = 0;
    function cards() {
        return [...row.querySelectorAll('.featured-ad-card')].filter(card => card.getBoundingClientRect().width > 0);
    }
    function update() {
        frame = 0;
        row.querySelectorAll('.featured-ad-card').forEach(decorate);
        const items = cards();
        const overflow = row.scrollWidth - row.clientWidth;
        nav.hidden = expanded || items.length <= 3 || overflow < 2;
        previous.disabled = row.scrollLeft < 2;
        next.disabled = row.scrollLeft >= overflow - 2;
        if (!items.length) return;
        const left = row.getBoundingClientRect().left;
        let first = items.reduce((nearest, card, index) =>
            Math.abs(card.getBoundingClientRect().left - left) < Math.abs(items[nearest].getBoundingClientRect().left - left) ? index : nearest, 0);
        first = Math.min(first, Math.max(0, items.length - 3));
        const text = `${first + 1}–${Math.min(first + 3, items.length)} / ${items.length}`;
        if (count.textContent !== text) count.textContent = text;
    }
    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }
    function move(direction) {
        if (expanded) return;
        const items = cards();
        if (!items.length) return;
        const gap = parseFloat(getComputedStyle(row).columnGap) || 8;
        const step = 3 * (items[0].getBoundingClientRect().width + gap);
        const left = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, row.scrollLeft + direction * step));
        // The shared carousel settles on individual cards; moving immediately
        // keeps its settling handler from interrupting a three-card advance.
        row.scrollTo({ left, behavior: 'instant' });
        schedule();
    }
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    row.addEventListener('keydown', event => {
        if (event.target !== row || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        move(event.key === 'ArrowLeft' ? -1 : 1);
    }, true);
    row.addEventListener('scroll', schedule, { passive: true });
    new ResizeObserver(schedule).observe(row);
    new MutationObserver(schedule).observe(row, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'class', 'data-featured-country-hidden', 'data-ad-price', 'data-ad-location', 'data-ad-country', 'data-ad-origin-city', 'data-ad-title', 'data-ad-details', 'data-ad-condition']
    });
    new MutationObserver(schedule).observe(section, { attributes: true, attributeFilter: ['class', 'hidden'] });
    schedule();
})();
