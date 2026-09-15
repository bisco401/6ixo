(function () {
    'use strict';
    window.SIXO_AREA_PICKER = { setup(app) {
        const field = document.getElementById('home-search-location');
        const panel = document.getElementById('area-picker');
        const list = document.getElementById('area-picker-countries');
        const status = document.getElementById('area-picker-status');
        const retry = document.getElementById('area-picker-retry');
        if (!field || !panel || field.dataset.boundAreaPicker) return;
        field.dataset.boundAreaPicker = '1';
        // This picker commits complete locations, so the legacy input handlers
        // must not search the marketplace for each unfinished prefix.
        field.dataset.boundInput = '1'; field.dataset.boundEnter = '1';
        let matches = [], active = -1, generation = 0, timer, restoringFocus = false;
        let baseline, baselineValue = '', baselineAuto, applying = null, scrollPending = false;
        const remember = () => {
            baseline = app.getHomeSearchLocationSelection();
            baselineValue = field.value; baselineAuto = field.dataset.autoLocationDefault;
        };
        const close = ({ cancel = false, focus = false } = {}) => {
            ++generation; clearTimeout(timer);
            if (cancel && app.homeLocationDraft) {
                field.value = baselineValue;
                if (baselineAuto === undefined) delete field.dataset.autoLocationDefault;
                else field.dataset.autoLocationDefault = baselineAuto;
                app.homeLocationDraft = null;
            }
            panel.hidden = true; field.setAttribute('aria-expanded', 'false');
            field.removeAttribute('aria-activedescendant');
            if (focus) { restoringFocus = true; field.focus({ preventScroll: true }); restoringFocus = false; }
        };
        const show = () => {
            if (panel.hidden) {
                if (!app.homeLocationDraft) remember();
                panel.hidden = false; field.setAttribute('aria-expanded', 'true'); scrollPending = true;
            }
        };
        const setActive = index => {
            active = index;
            [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
            const option = list.children[index];
            if (option) {
                field.setAttribute('aria-activedescendant', option.id);
                option.scrollIntoView({ block: 'nearest' });
            }
        };
        const choose = result => {
            if (applying) return applying;
            ++generation; clearTimeout(timer);
            app.homeLocationDraft = null;
            field.value = result.label; field.dataset.autoLocationDefault = '1';
            field.readOnly = true; field.setAttribute('aria-busy', 'true');
            status.textContent = 'Loading listings…'; retry.hidden = true;
            applying = (async () => {
                try {
                    await app.applyManualDiscoveryLocation({ city: result.city, country: result.country });
                    remember(); close({ focus: document.activeElement === field || panel.contains(document.activeElement) });
                    return true;
                } catch {
                    if (!panel.hidden) { status.textContent = 'Listings could not load. Please try again.'; retry.hidden = false; }
                    return false;
                } finally {
                    field.readOnly = false; field.removeAttribute('aria-busy'); applying = null;
                }
            })();
            return applying;
        };
        const render = (results, query) => {
            matches = results; active = -1; list.replaceChildren();
            field.removeAttribute('aria-activedescendant');
            results.forEach((result, index) => {
                const option = document.createElement('button');
                option.type = 'button'; option.id = `area-result-${index}`; option.tabIndex = -1;
                option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
                const title = document.createElement('span'); title.textContent = result.label;
                const detail = document.createElement('small'); detail.textContent = result.type === 'country' ? 'Country' : result.region;
                option.append(title, detail);
                option.addEventListener('mousedown', event => event.preventDefault());
                option.addEventListener('click', () => void choose(result));
                list.appendChild(option);
            });
            if (scrollPending) { panel.scrollIntoView({ block: 'nearest' }); scrollPending = false; }
            status.textContent = results.length ? (query ? 'Select a location' : 'Type a city or select a country')
                : (Array.from(query.trim()).length < 2 ? 'Type at least 2 letters for city suggestions.' : 'No matching locations. Try more letters or add a country.');
        };
        const refresh = async (query, token) => {
            try {
                const results = await window.SIXO_LOCATION_AUTOCOMPLETE.search(query);
                if (token !== generation || panel.hidden) return;
                render(results, query); retry.hidden = true;
            } catch {
                if (token !== generation || panel.hidden) return;
                status.textContent = 'Location suggestions could not load. Please try again.'; retry.hidden = false;
            }
        };
        const request = (query, delay = 0) => {
            const token = ++generation;
            clearTimeout(timer); show(); matches = []; active = -1; list.replaceChildren();
            field.removeAttribute('aria-activedescendant'); retry.hidden = true;
            status.textContent = 'Finding locations…';
            if (delay) timer = setTimeout(() => void refresh(query, token), delay);
            else void refresh(query, token);
        };
        const open = () => {
            if (restoringFocus || !panel.hidden || applying) return;
            request(app.homeLocationDraft ? field.value : '');
        };
        app.resolveHomeLocationAutocomplete = async () => {
            if (applying) return applying;
            if (!app.homeLocationDraft) return true;
            const query = field.value;
            if (!query.trim()) { close({ cancel: true }); return true; }
            const token = ++generation; clearTimeout(timer); show();
            status.textContent = 'Finding locations…';
            try {
                const results = await window.SIXO_LOCATION_AUTOCOMPLETE.search(query);
                if (token !== generation || field.value !== query || !app.homeLocationDraft) return false;
                if (results.length) return choose(results[0]);
                render([], query); return false;
            } catch {
                if (token === generation) { status.textContent = 'Location suggestions could not load. Please try again.'; retry.hidden = false; }
                return false;
            }
        };
        field.addEventListener('focus', open);
        field.addEventListener('click', open);
        field.addEventListener('input', () => {
            if (!baseline) remember();
            if (!app.homeLocationDraft) app.homeLocationDraft = { ...baseline };
            request(field.value, 160);
        });
        field.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); open();
                if (matches.length) setActive(event.key === 'ArrowDown' ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1));
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (!panel.hidden && active >= 0 && matches[active]) void choose(matches[active]);
                else void app.resolveHomeLocationAutocomplete().then(ok => { if (ok) { close(); app.submitHomeSearch({ scrollToResults: true }); } });
            } else if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); close({ cancel: true });
            }
        });
        document.addEventListener('pointerdown', event => {
            if (panel.hidden || panel.contains(event.target) || event.target === field) return;
            close({ cancel: !event.target.closest('#home-search-btn') });
        });
        field.addEventListener('blur', event => {
            if (panel.hidden || panel.contains(event.relatedTarget)) return;
            close({ cancel: event.relatedTarget?.id !== 'home-search-btn' });
        });
        retry.addEventListener('click', () => request(field.value));
    } };
})();
