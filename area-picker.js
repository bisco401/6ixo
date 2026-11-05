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
        let baseline, baselineValue = '', baselineAuto, applying = null, submitting = null, composing = false;
        const search = query => window.SIXO_LOCATION_AUTOCOMPLETE.search(query, {
            regions: Array.from(new Set(app.getRegionAliasMap?.().values() || []))
        });
        const remember = () => {
            baseline = app.getHomeSearchLocationSelection();
            baselineValue = field.value; baselineAuto = field.dataset.autoLocationDefault;
        };
        const position = () => {
            if (panel.hidden || !field.getBoundingClientRect) return;
            const rect = field.getBoundingClientRect(), viewport = window.visualViewport;
            const top = viewport?.offsetTop || 0;
            let bottom = top + (viewport?.height || window.innerHeight);
            const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
            if (nav?.height && nav.top > rect.bottom) bottom = Math.min(bottom, nav.top);
            const below = bottom - rect.bottom - 12;
            const above = rect.top - top - 12;
            const useAbove = below < 180 && above > below;
            const height = Math.max(80, Math.min(420, useAbove ? above : below));
            panel.style.top = useAbove ? 'auto' : 'calc(100% + 8px)';
            panel.style.bottom = useAbove ? 'calc(100% + 8px)' : 'auto';
            panel.style.maxHeight = `${height}px`;
            list.style.maxHeight = `${Math.max(40, height - 64)}px`;
        };
        const close = ({ cancel = false, focus = false } = {}) => {
            ++generation; clearTimeout(timer);
            if (cancel && app.homeLocationDraft) {
                field.value = baselineValue;
                if (baselineAuto === undefined) delete field.dataset.autoLocationDefault;
                else field.dataset.autoLocationDefault = baselineAuto;
                app.homeLocationDraft = null;
                // GPS may have resolved while the visitor was typing. Restore
                // that confirmed label when cancelling an empty/automatic draft.
                app.updateHomeCurrentLocationDisplay();
            }
            panel.hidden = true; field.setAttribute('aria-expanded', 'false');
            field.removeAttribute('aria-activedescendant');
            if (focus) { restoringFocus = true; field.focus({ preventScroll: true }); restoringFocus = false; }
        };
        const show = () => {
            if (panel.hidden) {
                if (!app.homeLocationDraft) remember();
                panel.hidden = false; field.setAttribute('aria-expanded', 'true');
            }
            position();
        };
        const setActive = index => {
            active = index;
            [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
            const option = list.children[index];
            if (option) {
                field.setAttribute('aria-activedescendant', option.id);
                const top = option.offsetTop - list.offsetTop;
                if (top < list.scrollTop) list.scrollTop = top;
                else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) {
                    list.scrollTop = top + option.offsetHeight - list.clientHeight;
                }
            }
        };
        const choose = result => {
            if (applying) {
                const pending = generation;
                return applying.then(() => pending === generation ? choose(result) : false);
            }
            const token = ++generation; clearTimeout(timer);
            app.homeLocationDraft = null;
            field.value = result.label; field.dataset.autoLocationDefault = '1';
            field.setAttribute('aria-busy', 'true');
            status.textContent = 'Loading listings…'; retry.hidden = true;
            applying = (async () => {
                try {
                    const loading = app.applyManualDiscoveryLocation({ city: result.city, country: result.country,
                        region: result.type === 'region' ? result.region : '' });
                    // The confirmed selection is available synchronously. Keep the
                    // field editable while its listings load in the background.
                    remember();
                    await loading;
                    if (token !== generation || app.homeLocationDraft) return false;
                    remember(); close({ focus: document.activeElement === field || panel.contains(document.activeElement) });
                    return true;
                } catch {
                    if (token === generation && !panel.hidden) { status.textContent = 'Listings could not load. Please try again.'; retry.hidden = false; }
                    return false;
                } finally {
                    field.removeAttribute('aria-busy'); applying = null;
                }
            })();
            return applying;
        };
        const render = (results, query) => {
            const token = generation;
            matches = results; active = -1; list.replaceChildren();
            list.setAttribute('aria-busy', 'false');
            field.removeAttribute('aria-activedescendant');
            results.forEach((result, index) => {
                const option = document.createElement('button');
                option.type = 'button'; option.id = `area-result-${index}`; option.tabIndex = -1;
                option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
                const title = document.createElement('span'); title.textContent = result.label;
                const detail = document.createElement('small'); detail.textContent = result.type === 'country' ? 'Country' : result.type === 'region' ? 'State / Province' : result.region;
                option.append(title, detail);
                option.addEventListener('pointerdown', event => event.preventDefault());
                option.addEventListener('click', () => { if (token === generation) void choose(result); });
                list.appendChild(option);
            });
            status.textContent = results.length ? (query ? 'Select a location' : 'Type a city or select a country')
                : (Array.from(query.trim()).length < 2 ? 'Type at least 2 letters for city suggestions.' : 'No matching locations. Try more letters or add a country.');
        };
        const refresh = async (query, token) => {
            try {
                const results = await search(query);
                if (token !== generation || panel.hidden) return;
                render(results, query); retry.hidden = true;
            } catch {
                if (token !== generation || panel.hidden) return;
                list.replaceChildren(); list.setAttribute('aria-busy', 'false');
                status.textContent = 'Location suggestions could not load. Please try again.'; retry.hidden = false;
            }
        };
        const request = (query, delay = 0) => {
            const token = ++generation;
            clearTimeout(timer); show(); matches = []; active = -1;
            // Retain the menu's height until replacement results are ready.
            // Stale options cannot be selected while another query is pending.
            list.setAttribute('aria-busy', 'true');
            field.removeAttribute('aria-activedescendant'); retry.hidden = true;
            status.textContent = 'Finding locations…';
            if (delay) timer = setTimeout(() => void refresh(query, token), delay);
            else void refresh(query, token);
        };
        const open = () => {
            if (restoringFocus || !panel.hidden) return;
            request(app.homeLocationDraft ? field.value : '');
        };
        app.resolveHomeLocationAutocomplete = async () => {
            if (composing) return false;
            if (applying) await applying;
            const query = field.value;
            const confirmed = app.getCurrentLocationDisplayText?.() || '';
            // A GPS label is never a manual destination, including while the
            // device is moving and the next area lookup is still in flight.
            if (!app.homeLocationDraft && !app.manualDiscoveryLocation && field.dataset.autoLocationDefault === '1'
                && (query === confirmed || query === app.lastConfirmedDeviceLocation?.label)) return true;
            if (!app.homeLocationDraft && (!query.trim()
                || (query.trim() === confirmed && app.deviceLocationFeedsReady))) return true;
            if (!app.homeLocationDraft) {
                if (!baseline) remember();
                app.homeLocationDraft = { ...baseline };
            }
            if (!query.trim()) { close({ cancel: true }); return true; }
            const token = ++generation; clearTimeout(timer); show();
            submitting = token;
            status.textContent = 'Finding locations…';
            try {
                const results = await search(query);
                if (token !== generation || field.value !== query || !app.homeLocationDraft) return false;
                if (results.length) return choose(results[0]);
                render([], query); return false;
            } catch {
                if (token === generation) { status.textContent = 'Location suggestions could not load. Please try again.'; retry.hidden = false; }
                return false;
            } finally {
                if (submitting === token) submitting = null;
            }
        };
        field.addEventListener('focus', open);
        field.addEventListener('click', open);
        const edit = () => {
            if (!baseline) remember();
            if (!app.homeLocationDraft) app.homeLocationDraft = { ...baseline };
        };
        field.addEventListener('compositionstart', () => {
            composing = true; edit(); ++generation; clearTimeout(timer);
            matches = []; active = -1; field.removeAttribute('aria-activedescendant');
            list.setAttribute('aria-busy', 'true');
        });
        field.addEventListener('compositionend', () => {
            composing = false; edit(); request(field.value, 160);
        });
        field.addEventListener('input', event => {
            edit();
            if (!composing && !event?.isComposing) request(field.value, 160);
        });
        field.addEventListener('keydown', event => {
            if (composing || event.isComposing || event.keyCode === 229) return;
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
            if ((panel.hidden && !app.homeLocationDraft) || panel.contains(event.target) || event.target === field) return;
            close({ cancel: !event.target.closest('#home-search-btn') });
        });
        field.addEventListener('blur', event => {
            // Safari can blur without identifying the clicked Search button.
            // An explicit search already owns this draft until lookup finishes.
            if (submitting !== null || applying) return;
            if (panel.hidden || panel.contains(event.relatedTarget)) return;
            // Mobile keyboards can blur without a navigation action. Preserve
            // the draft; Escape and an explicit outside tap still cancel it.
            close();
        });
        retry.addEventListener('click', () => request(field.value));
        window.addEventListener?.('resize', position);
        window.addEventListener?.('scroll', position, true);
        window.visualViewport?.addEventListener('resize', position);
        window.visualViewport?.addEventListener('scroll', position);
    } };
})();
