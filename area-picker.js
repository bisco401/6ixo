(function () {
    'use strict';
    window.SIXO_AREA_PICKER = { setup(app) {
        const button = document.getElementById('choose-area-button');
        const dialog = document.getElementById('area-picker');
        if (!button || !dialog || button.dataset.boundAreaPicker) return;
        button.dataset.boundAreaPicker = '1';
        const country = document.getElementById('area-picker-country');
        const city = document.getElementById('area-picker-city');
        const suggestions = document.getElementById('area-picker-cities');
        const status = document.getElementById('area-picker-status');
        const apply = document.getElementById('area-picker-apply');
        let catalog = [], cityRows = [], cityRequest = 0;
        const suggest = () => {
            suggestions.replaceChildren();
            const query = city.value.trim().toLocaleLowerCase();
            const names = new Set();
            for (const row of cityRows) {
                if (names.size >= 100) break;
                if (query && !row.city.toLocaleLowerCase().includes(query)) continue;
                if (names.has(row.city)) continue;
                names.add(row.city);
                const option = document.createElement('option');
                option.value = row.city; option.label = row.region;
                suggestions.appendChild(option);
            }
        };
        const loadCities = async () => {
            const generation = ++cityRequest;
            cityRows = []; suggest();
            if (!country.value) return;
            try {
                const rows = await window.SIXO_GEOGRAPHY.cities(country.value);
                if (generation !== cityRequest) return;
                cityRows = rows; suggest(); status.textContent = '';
            } catch {
                if (generation === cityRequest) status.textContent = 'City suggestions are unavailable. Type a city or browse the country.';
            }
        };
        country.addEventListener('change', () => { city.value = ''; void loadCities(); });
        city.addEventListener('input', suggest);
        document.getElementById('area-picker-cancel').addEventListener('click', () => dialog.close());
        button.addEventListener('click', async () => {
            dialog.showModal(); status.textContent = 'Loading areas…'; apply.disabled = true;
            try {
                catalog = await window.SIXO_GEOGRAPHY.countries();
                country.replaceChildren();
                const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose a country'; country.appendChild(blank);
                catalog.sort((a, b) => a.name.localeCompare(b.name)).forEach(row => {
                    const option = document.createElement('option'); option.value = row.code; option.textContent = row.name; country.appendChild(option);
                });
                const selected = app.getDiscoveryLocationLabelParts();
                country.value = catalog.find(row => row.name === selected.country)?.code || '';
                city.value = selected.city || '';
                status.textContent = ''; apply.disabled = false;
                await loadCities();
            } catch { status.textContent = 'Area data could not load. Close this window and try again.'; }
        });
        document.getElementById('area-picker-form').addEventListener('submit', async event => {
            event.preventDefault();
            const selected = catalog.find(row => row.code === country.value);
            if (!selected || apply.disabled) return;
            apply.disabled = true; status.textContent = 'Loading listings…';
            try {
                await app.applyManualDiscoveryLocation({ city: city.value, country: selected.name });
                dialog.close();
            } catch { status.textContent = 'Listings could not load. Please try again.'; }
            finally { apply.disabled = false; }
        });
    } };
})();
