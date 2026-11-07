/* Paired Home fields share the existing committed location and GPS lifecycle. */
(function (root) {
    'use strict';
    root.SIXO_HOME_LOCATION_SEARCH = { setup(app) {
        const source = document.getElementById('home-search-location');
        const country = document.getElementById('home-location-country');
        const city = document.getElementById('home-location-city');
        const group = document.getElementById('home-location-fields');
        const panel = document.getElementById('area-picker');
        const list = document.getElementById('area-picker-countries');
        const status = document.getElementById('area-picker-status');
        const retry = document.getElementById('area-picker-retry');
        if (!country || !city || !source || !group || !panel || !root.SIXO_LOCATION_AUTOCOMPLETE) return false;
        if (source.dataset.boundAreaPicker) return true;
        source.dataset.boundAreaPicker = source.dataset.boundInput = source.dataset.boundEnter = '1';
        let active = null, matches = [], selected = -1, request = 0, revision = 0, timer;
        let dirty = false, composing = false, applying = null, anchor = null;
        let committed = { country: '', city: '', region: '', text: '' };
        const clean = value => String(value || '').trim();
        const same = (a, b) => clean(a).toLocaleLowerCase() === clean(b).toLocaleLowerCase();
        const hasEdits = () => dirty || !same(country.value, committed.country) || !same(city.value, committed.city);
        function position() {
            if (panel.hidden) return;
            const rect = group.getBoundingClientRect(), viewport = root.visualViewport;
            const documentRect = document.documentElement.getBoundingClientRect();
            const top = Math.max(0, (viewport?.offsetTop || 0) + Math.min(0, documentRect.top + (root.scrollY || 0)));
            let bottom = top + (viewport?.height || root.innerHeight);
            const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
            if (nav?.height && nav.top > rect.bottom) bottom = Math.min(bottom, nav.top);
            // The menu stays in document flow below both fields. It cannot
            // cover the cursor, and longer lists scroll within the menu.
            list.style.maxHeight = `${Math.max(88, Math.min(240, bottom - rect.bottom - 55))}px`;
        }
        function close() {
            request++; clearTimeout(timer); matches = []; selected = -1;
            panel.hidden = true;
            for (const input of [country, city]) {
                input.setAttribute('aria-expanded', 'false');
                input.removeAttribute('aria-activedescendant');
            }
            active = null;
        }
        function sync({ force = false } = {}) {
            if (!force && (hasEdits() || app.homeLocationDraft)) return;
            const next = app.getHomeSearchLocationSelection();
            const changed = !same(committed.country, next.country) || !same(committed.city, next.city);
            committed = { ...next };
            country.value = next.country || ''; city.value = next.city || '';
            country.title = country.value; city.title = [city.value, country.value].filter(Boolean).join(', ');
            if (anchor && !same(anchor.country, next.country)) anchor = null;
            if (changed && active) show(active);
        }
        function edit(input) {
            if (!dirty) app.homeLocationDraft = { ...committed };
            dirty = true; revision++;
            country.removeAttribute('aria-invalid'); city.removeAttribute('aria-invalid');
            if (input === country) { city.value = ''; anchor = null; }
        }
        function cancel() {
            revision++; dirty = false; app.homeLocationDraft = null; close();
            sync({ force: true }); app.updateHomeCurrentLocationDisplay(); sync();
        }
        async function countryScope() {
            const query = clean(country.value);
            if (!query) return { country: '' };
            const countries = await root.SIXO_LOCATION_AUTOCOMPLETE.search(query, { type: 'country' });
            const exact = countries.find(result => result.exact);
            if (exact) {
                const nearby = anchor && same(anchor.country, exact.country) ? anchor : null;
                return { country: exact.country, nearCity: nearby?.city || '', nearRegion: nearby?.region || '' };
            }
            const cities = await root.SIXO_LOCATION_AUTOCOMPLETE.search(query, { type: 'city' });
            const namedCity = cities.find(result => result.exact);
            return namedCity ? { country: namedCity.country, nearCity: namedCity.city, nearRegion: namedCity.region } : { country: query, invalid: true };
        }
        async function search(input, query) {
            if (input === country) {
                const countries = await root.SIXO_LOCATION_AUTOCOMPLETE.search(query, { type: 'country' });
                return countries.length ? countries : root.SIXO_LOCATION_AUTOCOMPLETE.search(query, { type: 'city' });
            }
            const scope = await countryScope();
            if (scope.invalid) return [];
            const cities = await root.SIXO_LOCATION_AUTOCOMPLETE.search(query, {
                type: 'city', ...scope, includeNearby: true, limit: 24
            });
            if (!scope.country || clean(query)) return cities;
            return [{ type: 'country', city: '', region: '', country: scope.country,
                label: `All cities in ${scope.country}`, allCities: true }, ...cities];
        }
        function message(input) {
            return input === country ? 'No matching country or city. Try another name.'
                : !clean(country.value) && !clean(city.value) ? 'Choose a country or type a city.'
                : `No matching cities${clean(country.value) ? ` in ${country.value}` : ''}. Check the country or try another city.`;
        }
        function highlight(index) {
            selected = index;
            [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
            const option = list.children[index];
            if (!option || !active) return;
            active.setAttribute('aria-activedescendant', option.id);
            const top = option.offsetTop - list.offsetTop;
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
        }
        async function commit(result) {
            const token = ++revision;
            const location = { country: result.country, city: result.city || '', region: '' };
            dirty = false; app.homeLocationDraft = null;
            for (const input of [country, city]) input.removeAttribute('aria-invalid');
            committed = { ...location, text: [location.city, location.country].filter(Boolean).join(', ') };
            country.value = location.country; city.value = location.city;
            close();
            let loading;
            try { loading = Promise.resolve(app.applyManualDiscoveryLocation(location)); }
            catch (error) { loading = Promise.reject(error); }
            const pending = loading.then(() => {
                if (token !== revision || hasEdits() || app.homeLocationDraft) return false;
                sync(); return true;
            }).catch(() => {
                if (token === revision) {
                    panel.hidden = false; list.replaceChildren();
                    status.textContent = 'Listings could not load. Search again to retry.'; retry.hidden = true;
                }
                return false;
            }).finally(() => { if (applying === pending) applying = null; });
            applying = pending;
            return pending;
        }
        function choose(input, result) {
            anchor = result.city ? result : null;
            if (input === country) {
                // Finish the pair before applying it. In particular, recovery
                // and rental entry points must not navigate away before City.
                if (!dirty) app.homeLocationDraft = { ...committed };
                dirty = true; revision++;
                country.value = result.country; city.value = '';
                for (const field of [country, city]) field.removeAttribute('aria-invalid');
                // City is optional. Keep focus here and wait for the visitor
                // to open City or search the whole country.
                close();
                return Promise.resolve(true);
            }
            return commit(result);
        }
        async function resolveCountry() {
            const query = clean(country.value), token = revision;
            if (!query) { show(country); return false; }
            try {
                const results = await search(country, query);
                if (token !== revision || clean(country.value) !== query) return false;
                if (results.length) return choose(country, results[0]);
                country.setAttribute('aria-invalid', 'true'); show(country); return false;
            } catch { show(country); return false; }
        }
        async function resolve() {
            if (composing) return false;
            if (!hasEdits()) {
                if (applying) return applying;
                if (app.manualDiscoveryLocation && !app.deviceLocationFeedsReady) return commit(committed);
                return true; // A live GPS label remains a device location.
            }
            if (!dirty) { app.homeLocationDraft = { ...committed }; dirty = true; revision++; }
            const token = revision, countryQuery = country.value, cityQuery = city.value;
            try {
                const scope = await countryScope();
                if (token !== revision || country.value !== countryQuery || city.value !== cityQuery) return false;
                if (scope.invalid || (!scope.country && !clean(cityQuery))) {
                    country.setAttribute('aria-invalid', 'true'); show(country); return false;
                }
                if (!clean(cityQuery)) return commit({ country: scope.country, city: '' });
                const results = await root.SIXO_LOCATION_AUTOCOMPLETE.search(cityQuery, { country: scope.country, type: 'city' });
                if (token !== revision || country.value !== countryQuery || city.value !== cityQuery) return false;
                if (results.length) { anchor = results[0]; return commit(results[0]); }
                city.setAttribute('aria-invalid', 'true'); show(city); return false;
            } catch { show(active || city); return false; }
        }
        async function refresh(input, query, token, countryQuery) {
            try {
                const results = await search(input, query);
                if (token !== request || active !== input || input.value !== query || country.value !== countryQuery) return;
                matches = results; list.replaceChildren(); list.setAttribute('aria-busy', 'false');
                status.textContent = results.length ? input === country
                    ? results[0].type === 'city' ? 'Choose a city to set its country' : 'Choose a country'
                    : 'Choose a city, or search the whole country' : message(input);
                results.forEach((result, index) => {
                    const option = document.createElement('button');
                    option.type = 'button'; option.tabIndex = -1; option.id = `home-location-option-${index}`;
                    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
                    const title = document.createElement('span'); title.textContent = result.label;
                    const detail = document.createElement('small');
                    detail.textContent = result.allCities ? 'Countrywide' : result.type === 'country' ? 'Country'
                        : input === country ? `City in ${result.country}` : result.region;
                    option.append(title, detail);
                    option.addEventListener('pointerdown', event => event.preventDefault());
                    option.addEventListener('click', () => { if (token === request) void choose(input, result); });
                    list.appendChild(option);
                });
                position();
            } catch {
                if (token !== request) return;
                list.replaceChildren(); list.setAttribute('aria-busy', 'false');
                status.textContent = 'Location suggestions could not load. Please try again.'; retry.hidden = false;
            }
        }
        function show(input, delay = 0) {
            request++; clearTimeout(timer); matches = []; selected = -1;
            if (active && active !== input) active.setAttribute('aria-expanded', 'false');
            active = input; panel.hidden = false; retry.hidden = true;
            input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
            list.setAttribute('aria-busy', 'true'); list.setAttribute('aria-label', input === country ? 'Countries' : 'Cities');
            status.textContent = input === country ? 'Finding countries…' : 'Finding cities…';
            position();
            const token = request, query = input.value, countryQuery = country.value;
            if (delay) timer = setTimeout(() => void refresh(input, query, token, countryQuery), delay);
            else void refresh(input, query, token, countryQuery);
        }
        for (const input of [country, city]) {
            input.addEventListener('focus', () => show(input));
            input.addEventListener('click', () => { if (active !== input || panel.hidden) show(input); });
            input.addEventListener('input', event => { edit(input); if (!composing && !event.isComposing) show(input, 160); });
            input.addEventListener('compositionstart', () => { composing = true; edit(input); request++; clearTimeout(timer); matches = []; });
            input.addEventListener('compositionend', () => { composing = false; edit(input); show(input, 160); });
            input.addEventListener('keydown', event => {
                if (composing || event.isComposing || event.keyCode === 229) return;
                if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                if (event.key === 'Escape') { cancel(); return; }
                if (event.key === 'Enter') {
                    if (active === input && selected >= 0 && matches[selected]) void choose(input, matches[selected]);
                    else if (input === country) void resolveCountry();
                    else void resolve().then(ok => { if (ok) { close(); app.submitHomeSearch({ scrollToResults: true }); } });
                    return;
                }
                if (panel.hidden) { show(input); return; }
                if (matches.length) highlight((selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
            });
            input.addEventListener('blur', () => setTimeout(() => {
                if (![country, city].includes(document.activeElement) && !panel.contains(document.activeElement)) close();
            }, 0));
        }
        document.addEventListener('pointerdown', event => {
            if (group.contains(event.target) || panel.contains(event.target)) return;
            if (event.target.closest?.('#home-search-btn, #home-search-what')) { close(); return; }
            if (dirty) cancel(); else close();
        });
        for (const id of ['home-use-location', 'site-use-location']) {
            document.getElementById(id)?.addEventListener('click', () => { anchor = null; cancel(); }, true);
        }
        retry.addEventListener('click', () => show(active || city));
        root.addEventListener('resize', position);
        root.addEventListener('scroll', position, true);
        root.visualViewport?.addEventListener('resize', position);
        root.visualViewport?.addEventListener('scroll', position);
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        Object.defineProperty(source, 'value', {
            configurable: true, get() { return descriptor.get.call(this); },
            set(value) { descriptor.set.call(this, value); Promise.resolve().then(sync); }
        });
        source.focus = options => (country.value ? city : country).focus(options);
        source.scrollIntoView = options => group.scrollIntoView(options);
        app.resolveHomeLocationAutocomplete = resolve;
        sync({ force: true }); return true;
    } };
})(window);
