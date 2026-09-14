(function () {
    'use strict';
    window.SIXO_AREA_PICKER = { setup(app) {
        const field = document.getElementById('home-search-location');
        const panel = document.getElementById('area-picker');
        if (!field || !panel || field.dataset.boundAreaPicker) return;
        field.dataset.boundAreaPicker = '1';
        const country = document.getElementById('area-picker-country');
        const countries = document.getElementById('area-picker-countries');
        const city = document.getElementById('area-picker-city');
        const suggestions = document.getElementById('area-picker-cities');
        const status = document.getElementById('area-picker-status');
        const apply = document.getElementById('area-picker-apply');
        const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
        let catalog = [], matches = [], cityRows = [], selectedCode = '';
        let cityRequest = 0, openRequest = 0, active = -1, restoringFocus = false;
        const matchCountry = () => catalog.find(row => normalize(row.name) === normalize(country.value) || normalize(row.code) === normalize(country.value));
        const showCountries = visible => {
            countries.hidden = !visible;
            country.setAttribute('aria-expanded', String(visible));
            if (!visible) country.removeAttribute('aria-activedescendant');
        };
        const suggestCities = () => {
            suggestions.replaceChildren();
            const query = normalize(city.value), names = new Set();
            for (const row of cityRows) {
                if (names.size >= 100) break;
                if ((query && !normalize(row.city).includes(query)) || names.has(row.city)) continue;
                names.add(row.city);
                const option = document.createElement('option');
                option.value = row.city; option.label = row.region;
                suggestions.appendChild(option);
            }
        };
        const loadCities = async row => {
            const generation = ++cityRequest;
            cityRows = []; suggestCities();
            if (!row) return;
            try {
                const rows = await window.SIXO_GEOGRAPHY.cities(row.code);
                if (generation !== cityRequest) return;
                cityRows = rows; suggestCities();
            } catch {
                if (generation === cityRequest && !panel.hidden) status.textContent = 'City suggestions are unavailable. You can still type a city or search the country.';
            }
        };
        const selectCountry = row => {
            if (selectedCode !== row.code) city.value = '';
            selectedCode = row.code;
            country.value = row.name;
            country.setCustomValidity(''); status.textContent = '';
            showCountries(false); void loadCities(row); city.focus();
        };
        const renderCountries = (query = '') => {
            countries.replaceChildren(); active = -1;
            country.removeAttribute('aria-activedescendant');
            const search = normalize(query);
            matches = catalog.filter(row => !search || normalize(row.name).includes(search) || normalize(row.code) === search)
                .sort((a, b) => Number(normalize(b.name).startsWith(search)) - Number(normalize(a.name).startsWith(search)));
            matches.forEach((row, index) => {
                const option = document.createElement('button');
                option.type = 'button'; option.id = `area-country-${row.code}`;
                option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
                option.tabIndex = -1; option.textContent = row.name;
                option.addEventListener('mousedown', event => event.preventDefault());
                option.addEventListener('click', () => selectCountry(matches[index]));
                countries.appendChild(option);
            });
            if (!matches.length) {
                const empty = document.createElement('p'); empty.textContent = 'No matching countries.';
                countries.appendChild(empty);
            }
            showCountries(true);
        };
        const close = (restoreFocus = false) => {
            ++openRequest; ++cityRequest;
            panel.hidden = true; field.setAttribute('aria-expanded', 'false');
            country.removeAttribute('aria-activedescendant');
            if (restoreFocus) { restoringFocus = true; field.focus(); restoringFocus = false; }
        };
        const open = async () => {
            if (restoringFocus || !panel.hidden) return;
            const generation = ++openRequest;
            panel.hidden = false; field.setAttribute('aria-expanded', 'true');
            status.textContent = 'Loading countries…'; apply.disabled = true;
            country.disabled = true; country.setCustomValidity('');
            try {
                catalog = (await window.SIXO_GEOGRAPHY.countries()).slice().sort((a, b) => a.name.localeCompare(b.name));
                if (generation !== openRequest) return;
                const selected = app.getDiscoveryLocationLabelParts();
                const row = catalog.find(item => normalize(item.name) === normalize(selected.country));
                selectedCode = row?.code || '';
                country.value = row?.name || ''; city.value = selected.city || '';
                status.textContent = ''; country.disabled = false; apply.disabled = false;
                renderCountries(); country.focus(); country.select();
                panel.scrollIntoView({ block: 'nearest' });
                void loadCities(row);
            } catch {
                if (generation === openRequest) status.textContent = 'Country data could not load. Close the dropdown and try again.';
            }
        };
        field.addEventListener('focus', () => void open());
        field.addEventListener('click', () => void open());
        field.addEventListener('keydown', event => {
            if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); void open(); }
        });
        country.addEventListener('focus', () => renderCountries());
        country.addEventListener('input', () => {
            country.setCustomValidity(''); status.textContent = '';
            renderCountries(country.value);
            const row = matchCountry();
            if (selectedCode !== (row?.code || '')) {
                selectedCode = row?.code || ''; city.value = ''; void loadCities(row);
            }
        });
        country.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (countries.hidden) renderCountries(country.value);
                if (!matches.length) return;
                active = event.key === 'ArrowDown' ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1);
                [...countries.children].forEach((item, index) => item.setAttribute('aria-selected', String(index === active)));
                const option = countries.children[active];
                country.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter' && !countries.hidden) {
                event.preventDefault();
                const row = active >= 0 ? matches[active] : matchCountry() || matches[0];
                if (row) selectCountry(row);
            }
        });
        city.addEventListener('focus', () => showCountries(false));
        city.addEventListener('input', suggestCities);
        panel.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        });
        document.addEventListener('pointerdown', event => {
            if (!panel.hidden && !panel.contains(event.target) && event.target !== field) close();
        });
        panel.addEventListener('focusout', event => {
            if (event.relatedTarget && !panel.contains(event.relatedTarget) && event.relatedTarget !== field) close();
        });
        document.getElementById('area-picker-cancel').addEventListener('click', () => close(true));
        document.getElementById('area-picker-form').addEventListener('submit', async event => {
            event.preventDefault();
            if (apply.disabled) return;
            const row = matchCountry();
            if (!row) {
                country.setCustomValidity('Select a country from the dropdown.'); country.reportValidity(); return;
            }
            const generation = openRequest;
            apply.disabled = true; status.textContent = 'Loading listings…';
            try {
                await app.applyManualDiscoveryLocation({ city: city.value, country: row.name });
                if (generation === openRequest) close(true);
            } catch {
                if (generation === openRequest) status.textContent = 'Listings could not load. Please try again.';
            } finally { if (generation === openRequest || panel.hidden) apply.disabled = false; }
        });
    } };
})();
