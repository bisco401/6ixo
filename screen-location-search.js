/* Shared, same-origin city/country search for discovery screens. */
(function (root) {
    'use strict';
    const groups = [
        ['community-country', 'community-city'],
        ['dating-feed-country', 'dating-feed-city', 'dating-feed-region'],
        ['nearby-country-filter', 'nearby-city-filter', 'nearby-region-filter'],
        ['', 'hookup-plus-city'],
        ['companionship-mini-country', 'companionship-mini-city', 'companionship-mini-region'],
        ['country-filter', 'city-filter'],
        ['electronics-country', 'electronics-city'],
        ['clothing-search-country', 'clothing-search-city', 'clothing-search-region'],
        ['jobs-country', 'jobs-city'],
        ['vehicle-rental-filter-country', 'vehicle-rental-filter-city'],
        ['vehicles-country', 'vehicles-city'],
        ['realestate-country', 'realestate-city'],
        ['services-country-filter', 'services-city-filter'],
        ['other-country', 'other-city'],
        ['geo-search-country', 'geo-search-city', 'geo-search-region']
    ];
    const clean = value => value === 'all' ? '' : String(value || '').trim();
    function setValue(source, value) {
        if (!source) return;
        const next = String(value || '');
        if (source.tagName === 'SELECT' && !Array.from(source.options).some(option => option.value === next)) {
            source.add(new Option(next || 'Any location', next));
        }
        source.value = next;
        source.dataset.countryCityOptionsRequest = '';
    }
    function emit(source, type) {
        if (!source) return;
        const event = new Event(type, { bubbles: true });
        event.sixoLocationCommit = true;
        source.dispatchEvent(event);
    }
    // Country listeners may clear cities or render mirrored controls. Reapply the
    // complete selection after those listeners, then notify the city listeners.
    function applySelection(group, selection, field = 'city') {
        const country = selection ? selection.country : field === 'country' ? '' : clean(group.country?.value);
        const city = selection?.city || '';
        const region = selection?.region || '';
        const write = () => {
            setValue(group.country, country);
            setValue(group.region, region);
            setValue(group.city, city);
            if (group.city) group.city.dataset.locationCountry = country;
        };
        write();
        emit(group.country, 'change');
        emit(group.country, 'input');
        write();
        emit(group.region, 'change');
        emit(group.region, 'input');
        write();
        emit(group.city, 'input');
        emit(group.city, 'change');
    }
    let installed = false;
    function setup() {
        if (installed || !root.SIXO_LOCATION_AUTOCOMPLETE) return;
        installed = true;
        const popup = document.createElement('div');
        popup.id = 'screen-location-suggestions';
        popup.className = 'screen-location-suggestions';
        popup.hidden = true;
        popup.setAttribute('popover', 'manual');
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        const list = document.createElement('div');
        list.id = 'screen-location-options';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', 'Cities and countries');
        popup.append(status, list);
        document.body.append(popup);
        let active = null, draft = null, results = [], selected = -1, request = 0;
        const controls = new Map();

        function position() {
            if (!active || popup.hidden) return;
            const rect = active.input.getBoundingClientRect();
            const viewport = root.visualViewport;
            const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
            const width = viewport?.width || root.innerWidth, height = viewport?.height || root.innerHeight;
            const below = top + height - rect.bottom - 12, above = rect.top - top - 12;
            const useAbove = below < 180 && above > below;
            popup.style.width = `${Math.min(Math.max(rect.width, 300), width - 24)}px`;
            popup.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - popup.offsetWidth - 12))}px`;
            popup.style.maxHeight = `${Math.max(100, Math.min(340, useAbove ? above : below))}px`;
            popup.style.top = `${useAbove ? rect.top - Math.min(popup.scrollHeight, above, 340) - 6 : rect.bottom + 6}px`;
        }
        function close() {
            request++;
            if (active) {
                active.input.setAttribute('aria-expanded', 'false');
                active.input.removeAttribute('aria-activedescendant');
            }
            if (typeof popup.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover();
            popup.hidden = true;
            active = null;
        }
        function committedValue(control) {
            return !control.group.country && control.field === 'city'
                ? [clean(control.source.value), control.source.dataset.locationCountry].filter(Boolean).join(', ')
                : clean(control.source.value);
        }
        function hasDraft(control) {
            return control.dirty || control.input.value.trim().toLocaleLowerCase() !== committedValue(control).toLocaleLowerCase();
        }
        async function search(control, query) {
            const matches = await root.SIXO_LOCATION_AUTOCOMPLETE.search(query);
            const countryControl = control.group.controls.find(member => member.field === 'country');
            const country = clean(countryControl && hasDraft(countryControl) ? countryControl.input.value
                : control.group.country ? control.group.country.value : control.source.dataset.locationCountry);
            if (control.field !== 'city' || !country || !query.trim() || query.includes(',')) return matches;
            // A city-only edit belongs to the selected country. An explicit
            // country option or a qualified city may still change that country.
            const cities = await root.SIXO_LOCATION_AUTOCOMPLETE.search(`${query}, ${country}`);
            return [...matches.filter(result => result.type === 'country'), ...cities];
        }
        function sync(control) {
            if (control.dirty) return;
            const value = committedValue(control);
            // Some filter models normalize names to lowercase. Keep the label
            // selected by the visitor while still reflecting actual value changes.
            if (control.input.value.toLocaleLowerCase() !== value.toLocaleLowerCase()) control.input.value = value;
            control.input.title = control.field === 'city' && control.source.dataset.locationCountry
                ? [clean(control.source.value), control.source.dataset.locationCountry].filter(Boolean).join(', ') : '';
        }
        function choose(control, result) {
            control.group.revision++;
            for (const member of control.group.controls) {
                member.dirty = false;
                member.input.removeAttribute('aria-invalid');
            }
            if (draft?.group === control.group) draft = null;
            applySelection(control.group, result, control.field);
            for (const member of controls.values()) sync(member);
            close();
        }
        async function resolve(control) {
            if (!control || !hasDraft(control)) return true;
            if (!control.dirty) { control.dirty = true; draft = control; control.group.revision++; }
            const query = control.input.value.trim(), revision = control.group.revision;
            if (!query) { choose(control, null); return true; }
            try {
                const matches = await search(control, query);
                if (revision !== control.group.revision || !control.dirty || control.input.value.trim() !== query) return false;
                if (!matches.length) {
                    status.textContent = 'No matches. Try a city or country name.';
                    control.input.setAttribute('aria-invalid', 'true');
                    return false;
                }
                control.input.removeAttribute('aria-invalid');
                choose(control, matches[0]);
                return true;
            } catch {
                status.textContent = 'Suggestions could not load. Type again to retry.';
                return false;
            }
        }
        async function resolveGroup(control) {
            // Preserve both visible edits while country listeners rebuild cities.
            // Confirm the country first, then commit the visitor's city text.
            const pending = control.group.controls.filter(hasDraft)
                .map(member => ({ member, query: member.input.value }));
            for (const { member, query } of pending) {
                member.input.value = query;
                if (!await resolve(member)) return false;
            }
            return true;
        }
        function highlight(index) {
            selected = index;
            Array.from(list.children).forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
            const option = list.children[index];
            if (option && active) {
                active.input.setAttribute('aria-activedescendant', option.id);
                option.scrollIntoView({ block: 'nearest' });
            }
        }
        async function show(control) {
            if (draft && draft !== control && draft.group !== control.group) cancelDraft();
            if (active && active !== control) active.input.setAttribute('aria-expanded', 'false');
            active = control;
            const ticket = ++request;
            results = []; selected = -1; list.replaceChildren();
            status.textContent = 'Loading cities and countries…';
            popup.hidden = false;
            if (typeof popup.showPopover === 'function' && !popup.matches(':popover-open')) popup.showPopover();
            control.input.setAttribute('aria-expanded', 'true');
            position();
            try {
                const query = control.input.value;
                const matches = await search(control, query);
                if (ticket !== request || active !== control || control.input.value !== query) return;
                results = matches;
                status.textContent = matches.length ? 'Choose a city or country' : 'No matches. Try a city or country name.';
                for (const [index, result] of matches.entries()) {
                    const option = document.createElement('button');
                    option.type = 'button'; option.tabIndex = -1;
                    option.id = `screen-location-option-${index}`;
                    option.setAttribute('role', 'option');
                    option.setAttribute('aria-selected', 'false');
                    const label = document.createElement('span');
                    label.textContent = result.label;
                    const detail = document.createElement('small');
                    detail.textContent = result.type === 'country' ? 'Country · all cities' : result.region;
                    option.append(label, detail);
                    option.addEventListener('pointerdown', event => event.preventDefault());
                    option.addEventListener('click', () => choose(control, result));
                    list.append(option);
                }
                position();
            } catch {
                if (ticket === request) status.textContent = 'Suggestions could not load. Type again to retry.';
            }
        }
        function enhance(group, source, field) {
            if (!source || controls.has(source.id)) return;
            const input = document.createElement('input');
            input.type = 'search'; input.id = `${source.id}-autocomplete`;
            input.className = `${source.className.replace(/\bhidden\b/g, '')} location-search-input`;
            input.placeholder = field === 'country' ? 'Country or city' : 'City or country';
            input.autocomplete = 'off'; input.spellcheck = false;
            input.setAttribute('role', 'combobox');
            input.setAttribute('aria-autocomplete', 'list');
            input.setAttribute('aria-controls', list.id);
            input.setAttribute('aria-expanded', 'false');
            input.setAttribute('aria-label', source.getAttribute('aria-label') || (field === 'country' ? 'Country or city' : 'City or country'));
            input.maxLength = 160;
            source.dataset.locationSearchSource = '1';
            source.style.setProperty('display', 'none', 'important');
            source.tabIndex = -1;
            source.setAttribute('aria-hidden', 'true');
            source.insertAdjacentElement('afterend', input);
            for (const label of Array.from(source.labels || [])) label.htmlFor = input.id;
            const control = { source, input, group, field, dirty: false };
            controls.set(source.id, control); group.controls.push(control);
            const descriptor = Object.getOwnPropertyDescriptor(source.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value');
            Object.defineProperty(source, 'value', {
                configurable: true,
                get() { return descriptor.get.call(this); },
                set(value) { descriptor.set.call(this, value); sync(control); }
            });
            source.focus = options => input.focus(options);
            new MutationObserver(() => sync(control)).observe(source, { childList: true, subtree: true });
            source.addEventListener('change', () => sync(control));
            sync(control);
            input.addEventListener('focus', () => show(control));
            input.addEventListener('click', () => { if (active !== control) show(control); });
            input.addEventListener('input', event => {
                event.stopImmediatePropagation();
                control.dirty = true; draft = control; group.revision++;
                input.removeAttribute('aria-invalid');
                if (!input.value.trim()) { choose(control, null); show(control); }
                else show(control);
            }, true);
            input.addEventListener('change', event => event.stopImmediatePropagation(), true);
            input.addEventListener('keydown', event => {
                if (event.isComposing) return;
                if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
                event.stopImmediatePropagation(); event.preventDefault();
                if (event.key === 'Escape') {
                    cancelDraft(); close(); return;
                }
                if (event.key === 'Enter') {
                    if (active === control && selected >= 0 && results[selected]) choose(control, results[selected]);
                    else resolveGroup(control);
                    return;
                }
                if (active !== control) { show(control); return; }
                if (results.length) highlight((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
            }, true);
            input.addEventListener('blur', () => {
                // Keep a draft until the next action: accessibility tools and
                // keyboards can blur the field before activating Search.
                setTimeout(() => {
                    if (document.activeElement === input || control.resolving) return;
                    if (active === control) close();
                }, 0);
            });
        }
        for (const [countryId, cityId, regionId] of groups) {
            const group = { country: document.getElementById(countryId), city: document.getElementById(cityId), region: document.getElementById(regionId), controls: [], revision: 0 };
            enhance(group, group.country, 'country');
            enhance(group, group.city, 'city');
        }
        function cancelDraft() {
            if (!draft) return;
            draft.group.revision++;
            for (const member of draft.group.controls) { member.dirty = false; sync(member); }
            draft = null;
        }
        document.addEventListener('click', async event => {
            const button = event.target.closest('button, input[type="submit"]');
            // Autofill can change a visible control without sending input.
            // Search/Apply must still confirm that value before filtering.
            if (!draft && button && /search|apply|refresh/i.test(button.textContent || button.value)) {
                draft = Array.from(controls.values()).find(control => hasDraft(control)
                    && button.closest('.content-screen') === control.input.closest('.content-screen')) || null;
            }
            if (!draft || popup.contains(event.target)
                || draft.group.controls.some(control => event.target === control.input)) return;
            const sameScreen = button?.closest('.content-screen') === draft.input.closest('.content-screen');
            if (!button || !sameScreen || !/search|apply|refresh/i.test(button.textContent || button.value)) { cancelDraft(); return; }
            const control = draft;
            event.preventDefault(); event.stopImmediatePropagation();
            control.resolving = true;
            const done = await resolveGroup(control);
            control.resolving = false;
            if (done) button.click();
            else control.input.focus();
        }, true);
        root.addEventListener('hashchange', () => { cancelDraft(); close(); });
        root.addEventListener('resize', position);
        root.addEventListener('scroll', position, true);
        root.visualViewport?.addEventListener('resize', position);
        root.visualViewport?.addEventListener('scroll', position);
    }
    root.SIXO_SCREEN_LOCATION_SEARCH = { setup, groups, applySelection };
    if (typeof module === 'object' && module.exports) module.exports = root.SIXO_SCREEN_LOCATION_SEARCH;
    if (typeof document !== 'undefined') setup();
})(typeof window === 'object' ? window : globalThis);
