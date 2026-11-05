(function (window, document) {
    'use strict';
    const STATE_KEY = 'arrive_discovery_v1';
    const CATEGORIES = ['Restaurants', 'Car rental', 'Airport pickup', 'Events', 'Short stays', 'City tours', 'Gym', 'Nightlife', 'Beach day', 'Shopping', 'Spa & Beauty', 'Excursions', 'Private driver'];
    const text = (value, limit = 300) => String(value ?? '').trim().slice(0, limit);
    const escape = value => text(value, 4000).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fold = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Search by names, country codes and familiar alternatives without changing saved country values.
    const ARRIVE_COUNTRY_SEEDS = [
        { name: 'Canada', code: 'CA' },
        { name: 'United States', code: 'US', aliases: ['USA', 'America', 'United States of America', 'U.S.', 'U.S.A.'] },
        { name: 'United Kingdom', code: 'GB', aliases: ['UK', 'Britain', 'Great Britain'] },
        { name: 'Ghana', code: 'GH' }, { name: 'India', code: 'IN' },
        { name: 'Jamaica', code: 'JM' }, { name: 'Nigeria', code: 'NG' },
        { name: 'Australia', code: 'AU' }, { name: 'Mexico', code: 'MX' },
        { name: 'United Arab Emirates', code: 'AE', aliases: ['UAE'] }
    ];
    function matchingCountries(rows, query) {
        const needle = fold(query), compact = needle.replace(/\s/g, '');
        return rows.map(country => {
            const labels = [country.name, country.code, ...(country.aliases || [])].map(fold).filter(Boolean);
            const score = !needle ? 0 : Math.min(...labels.map(value => {
                if (value === needle || value.replace(/\s/g, '') === compact) return 0;
                if (value.startsWith(needle) || value.replace(/\s/g, '').startsWith(compact)) return 1;
                if (value.split(' ').some(word => word.startsWith(needle))) return 2;
                return value.includes(needle) ? 3 : Infinity;
            }));
            return { country, score };
        }).filter(entry => Number.isFinite(entry.score))
          .sort((a, b) => a.score - b.score || a.country.name.localeCompare(b.country.name))
          .slice(0, needle ? 30 : 70).map(entry => entry.country);
    }
    const ownerOf = app => app.isSignedIn && app.currentUser?.id ? String(app.currentUser.id) : 'guest';
    const countryKey = (app, value) => fold(app.getCountryAliasLabel?.(text(value)) || value);
    const imageUrl = value => /^(https?:\/\/|\/(?!\/)|\.?\.?\/|assets\/|data\/)/i.test(text(value, 2000)) ? text(value, 2000) : 'assets/ad-placeholder.svg';
    const dateKey = value => {
        const raw = text(value, 30);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
        const date = new Date(raw + 'T12:00:00Z');
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : '';
    };
    const timestamp = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const timeout = promise => new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Account sync timed out')), 6000);
        Promise.resolve(promise).then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
    });
    function snapshot(raw) {
        if (!raw || !['service', 'vehicle', 'realestate', 'community', 'marketplace'].includes(raw.kind) || !text(raw.id, 200)) return null;
        const kind = raw.kind, id = text(raw.id, 200);
        return { key: kind + ':' + id, kind, id, title: text(raw.title), city: text(raw.city), country: text(raw.country), image: imageUrl(raw.image), price: text(raw.price), categories: (Array.isArray(raw.categories) ? raw.categories : []).filter(x => CATEGORIES.includes(x)), eventDate: dateKey(raw.eventDate) };
    }
    function normalize(raw) {
        const prefs = raw?.preferences || {};
        const entries = new Map();
        for (const value of Array.isArray(raw?.saved) ? raw.saved.slice(0, 2000) : []) {
            const listing = snapshot(value);
            if (!listing) continue;
            const entry = { ...listing, updatedAt: timestamp(value.updatedAt), deleted: value.deleted === true };
            if (!entries.has(entry.key) || entries.get(entry.key).updatedAt <= entry.updatedAt) entries.set(entry.key, entry);
        }
        return { version: 1, preferences: { country: text(prefs.country), city: text(prefs.city), startDate: dateKey(prefs.startDate), endDate: dateKey(prefs.endDate), categories: [...new Set((Array.isArray(prefs.categories) ? prefs.categories : []).filter(x => CATEGORIES.includes(x)))], updatedAt: timestamp(prefs.updatedAt) }, saved: [...entries.values()] };
    }
    function merge(left, right) {
        const a = normalize(left), b = normalize(right);
        const saved = new Map();
        for (const entry of [...a.saved, ...b.saved]) if (!saved.has(entry.key) || saved.get(entry.key).updatedAt <= entry.updatedAt) saved.set(entry.key, entry);
        return normalize({ preferences: a.preferences.updatedAt > b.preferences.updatedAt ? a.preferences : b.preferences, saved: [...saved.values()].sort((x, y) => y.updatedAt - x.updatedAt) });
    }
    class Store {
        constructor(app, changed = () => {}) {
            this.app = app; this.changed = changed; this.owner = ownerOf(app); this.key = STATE_KEY + ':' + this.owner;
            this.state = normalize({}); this.localOk = true; this.cloudOk = false; this.pending = 0; this.queue = Promise.resolve();
            try { this.state = normalize(JSON.parse(window.localStorage.getItem(this.key) || '{}')); } catch { this.localOk = false; }
            this.ready = this.load();
        }
        current() { return !this.retired && this.owner === ownerOf(this.app); }
        retire() { this.retired = true; this.state = normalize({}); }
        canSync() { return this.current() && this.owner !== 'guest' && this.app.supabaseEnabled && this.app.supabase; }
        cache() {
            if (!this.current()) return;
            try { window.localStorage.setItem(this.key, JSON.stringify(this.state)); this.localOk = true; } catch { this.localOk = false; }
        }
        async authenticated() {
            if (!this.canSync()) return false;
            const { data, error } = await timeout(this.app.supabase.auth.getUser());
            return !error && String(data?.user?.id || '') === this.owner && this.current();
        }
        async readCloud() {
            const result = await timeout(this.app.supabase.from('app_client_state').select('state_value').eq('user_id', this.owner).eq('state_key', STATE_KEY).maybeSingle());
            if (result.error) throw result.error;
            return result.data?.state_value;
        }
        async load() {
            if (!this.canSync()) return;
            this.loading = true;
            try {
                if (!await this.authenticated()) return;
                const cloud = await this.readCloud();
                if (!this.current()) return;
                this.state = merge(cloud, this.state); this.cache();
                this.cloudOk = JSON.stringify(this.state) === JSON.stringify(normalize(cloud));
            } catch { this.cloudOk = false; }
            finally { this.loading = false; if (this.current()) this.changed(true); }
        }
        save() {
            if (!this.current()) return false;
            this.state = normalize(this.state); this.cache();
            if (!this.canSync()) { this.changed(); return this.localOk; }
            this.pending++; this.changed();
            this.queue = this.queue.then(async () => {
                await this.ready;
                if (!await this.authenticated()) { this.cloudOk = false; return; }
                const cloud = await this.readCloud();
                if (!this.current()) return;
                this.state = merge(cloud, this.state); this.cache();
                const { error } = await timeout(this.app.supabase.from('app_client_state').upsert({ user_id: this.owner, state_key: STATE_KEY, state_value: this.state, updated_at: new Date().toISOString() }, { onConflict: 'user_id,state_key' }));
                if (error) throw error;
                if (this.current()) this.cloudOk = true;
            }).catch(() => { if (this.current()) this.cloudOk = false; }).finally(() => { this.pending--; if (this.current()) this.changed(true); });
            return this.localOk;
        }
        status() {
            if (this.loading) return 'Loading saved itinerary…';
            if (this.pending) return 'Syncing your saved itinerary…';
            if (this.cloudOk) return 'Saved to your account';
            if (!this.localOk) return 'Saving is unavailable on this device. Keep this page open and try again.';
            return this.owner === 'guest' ? 'Saved on this device' : 'Saved on this device · Account sync unavailable';
        }
    }
    function categoriesFor(kind, raw) {
        const category = fold(raw.category), subcategory = fold(raw.subcategory || raw.serviceCategory);
        const words = fold([raw.name, raw.title, raw.description, raw.desc, raw.summary, raw.specialty, ...(Array.isArray(raw.tags) ? raw.tags : [])].filter(Boolean).join(' '));
        const selected = new Set();
        if (kind === 'vehicle') {
            if (['rentals', 'rental', 'car rental', 'vehicle rental'].includes(category) || raw.listingType === 'vehicle_rental') selected.add('Car rental');
        }
        if (kind === 'realestate') {
            if ((raw.categories || []).includes('short_term') || raw.listingType === 'short_term' || category === 'short term') selected.add('Short stays');
        }
        if (kind === 'community' && ['events', 'event', 'nightlife'].includes(category)) selected.add('Events');
        if (kind === 'marketplace' && ['clothing', 'fashion', 'electronics', 'other', 'sports'].includes(category)) selected.add('Shopping');
        if (kind === 'marketplace' && category === 'community' && ['events', 'event'].includes(subcategory)) selected.add('Events');
        if (kind === 'service' || kind === 'marketplace' && category === 'services') {
            if (['food', 'restaurant', 'restaurants', 'food restaurants'].includes(category) || ['food', 'restaurant', 'restaurants'].includes(subcategory)) selected.add('Restaurants');
            if (category === 'fitness' || subcategory === 'fitness' || /\b(gym|personal trainer|fitness|yoga|pilates)\b/.test(words)) selected.add('Gym');
            if (['health beauty', 'beauty', 'spa'].includes(category) || ['health beauty', 'beauty', 'spa'].includes(subcategory) || /\b(spa|massage|salon|facial|barber)\b/.test(words)) selected.add('Spa & Beauty');
            if (/\b(airport (pickup|pick up|transfer|shuttle)|airport transport)\b/.test(words)) selected.add('Airport pickup');
            if (/\b(private driver|chauffeur|chauffeured)\b/.test(words)) selected.add('Private driver');
            if (/\b(city tour|city tours|walking tour|local guide|sightseeing)\b/.test(words)) selected.add('City tours');
            if (/\b(excursion|excursions|day tour|day trip)\b/.test(words)) selected.add('Excursions');
            if (/\b(beach|beachfront)\b/.test(words) && ['travel', 'entertainment', 'events services', 'other'].includes(category)) selected.add('Beach day');
        }
        if ((kind === 'service' || kind === 'community') && /\b(nightclub|night club|nightlife|live music|jazz|concert|dj night)\b/.test(words)) selected.add('Nightlife');
        return [...selected];
    }
    function collect(app) {
        const records = new Map();
        const add = (kind, raw) => {
            if (!raw || raw.id == null || raw.isDemo || raw.demo || raw.placeholder || raw.sold === true || raw.available === false) return;
            const status = fold(raw.status || raw.sourceAvailability || raw.source_availability);
            if (['sold', 'unavailable', 'gone', 'draft', 'paused', 'archived', 'rejected', 'deleted', 'expired'].includes(status)) return;
            if (app.isImportedListingPublishable && !app.isImportedListingPublishable(raw)) return;
            const categories = categoriesFor(kind, raw);
            if (!categories.length) return;
            if (kind === 'realestate' && app.isRealestateShortTermListing && !app.isRealestateShortTermListing(raw)) return;
            const location = kind === 'community' ? app.getCommunityPostLocation?.(raw) || raw.location || {} : raw.location || {};
            const country = text(raw.country || location.country), city = text(raw.city || location.city);
            if (!country) return;
            let price = text(raw.priceText || raw.priceLabel || raw.rateLabel || (typeof raw.price === 'string' && !Number.isFinite(Number(raw.price)) ? raw.price : ''));
            const amount = raw.dailyRate ?? raw.rentalDailyRate ?? raw.price ?? raw.rate;
            if (!price && amount != null && amount !== '' && Number.isFinite(Number(amount))) {
                price = app.formatMarketplaceMoney?.(amount, { country, currency: raw.currency || '', fallback: '' }) || '';
                if (price && kind === 'vehicle') price += ' / day';
            }
            const photos = [...(Array.isArray(raw.images) ? raw.images : []), ...(Array.isArray(raw.photos) ? raw.photos : [])];
            const value = snapshot({ kind, id: raw.id, title: raw.title || raw.name || 'Listing', country, city, categories, price: price || 'Contact for price', image: photos[0] || raw.image || raw.photo || raw.logo, eventDate: categories.includes('Events') ? app.inferArrivePlusEventDate?.(raw) || raw.eventDate || raw.event_date : '' });
            if (!value) return;
            if (!records.has(value.key)) records.set(value.key, { ...value, raw, postedAt: Date.parse(raw.postedDate || raw.postedAt || raw.createdAt || '') || 0 });
        };
        (app.serviceProfiles || []).forEach(raw => add('service', raw));
        (app.realestateListings || []).forEach(raw => add('realestate', raw));
        (app.vehicleListings || []).forEach(raw => add('vehicle', raw));
        (app.getCommunityFeedPosts?.() || app.communityPosts || []).forEach(raw => add('community', raw));
        (app.marketplaceItems || []).forEach(raw => {
            if (raw.category === 'services' && records.has('service:' + raw.id)) return;
            if (raw.category === 'community' && [...records.values()].some(item => String(item.raw.marketplaceItemId) === String(raw.id))) return;
            add('marketplace', raw);
        });
        return [...records.values()];
    }
    function matchesCity(app, city, target) {
        if (!text(city) || !text(target)) return false;
        return app.isLooseLocationMatch ? app.isLooseLocationMatch(city, target, { allowFuzzy: false }) : fold(city) === fold(target);
    }
    function discover(app, records, preferences) {
        const country = countryKey(app, preferences.country), selected = preferences.categories || [];
        if (!country || !selected.length) return [];
        const start = dateKey(preferences.startDate), end = dateKey(preferences.endDate);
        return records.filter(item => {
            if (countryKey(app, item.country) !== country || !item.categories.some(c => selected.includes(c))) return false;
            if (item.categories.includes('Events') && (start || end)) {
                if (!item.eventDate || start && end && end < start || start && item.eventDate < start || end && item.eventDate > end) return false;
            }
            return true;
        }).sort((a, b) => Number(matchesCity(app, b.city, preferences.city)) - Number(matchesCity(app, a.city, preferences.city)) || b.postedAt - a.postedAt || a.title.localeCompare(b.title));
    }
    class Discovery {
        constructor(app, root) {
            this.app = app; this.root = root; this.abort = new AbortController(); this.tab = 'discover'; this.limit = 24; this.records = [];
            this.countries = ARRIVE_COUNTRY_SEEDS.slice(); this.cityCatalog = []; this.cityOptions = [];
            this.cityLoadKey = ''; this.cityCacheKey = ''; this.cityRequest = 0; this.menuItems = { country: [], city: [] }; this.activeOption = { country: 0, city: 0 };
            this.store = new Store(app, hydrate => { if (this.store) { if (hydrate) this.hydrate(); this.render(); } });
            this.fields = {
                country: root.querySelector('#arrive-discovery-country'), city: root.querySelector('#arrive-discovery-city'),
                startDate: root.querySelector('#dating-schedule-start'), endDate: root.querySelector('#dating-schedule-end')
            };
            this.countrySearch = root.querySelector('#arrive-discovery-country-search');
            this.hydrate(); this.bind(); this.loadCountries(); this.render(); this.loadCitiesForCountry();
            this.store.ready.then(() => { if (this.store.current()) { this.hydrate(); this.render(); this.loadCitiesForCountry(); } });
        }
        retire() { this.abort.abort(); window.clearTimeout(this.timer); this.store.retire(); }
        stamp() { return Math.max(Date.now(), this.store.state.preferences.updatedAt + 1, ...this.store.state.saved.map(x => x.updatedAt + 1)); }
        hydrate() {
            if (!this.store.current()) return;
            const prefs = this.store.state.preferences;
            this.fields.country.value = prefs.country;
            this.countrySearch.value = '';
            this.fields.city.value = prefs.city;
            this.fields.startDate.value = prefs.startDate; this.fields.endDate.value = prefs.endDate;
            this.root.querySelectorAll('#arrive-plus-checklist input').forEach(input => {
                input.checked = prefs.categories.includes(input.value);
                input.closest('label')?.classList.toggle('checked', input.checked);
            });
            this.syncLegacy(); this.updateCities();
        }
        syncLegacy() {
            const prefs = this.store.state.preferences;
            const destination = this.root.querySelector('#dating-schedule-destination');
            destination.value = [prefs.city, prefs.country].filter(Boolean).join(', ');
            this.app.saveArrivePlusChecklist(prefs.categories);
            this.app.updateArrivePlusChecklistSummary([...this.root.querySelectorAll('#arrive-plus-checklist input')]);
            if (prefs.startDate) this.fields.endDate.min = prefs.startDate; else this.fields.endDate.removeAttribute('min');
        }
        addObservedCountries() {
            for (const name of new Set(this.records.map(item => text(item.country)).filter(Boolean))) {
                if (!this.countries.some(item => countryKey(this.app, item.name) === countryKey(this.app, name) || fold(item.code) === fold(name))) {
                    this.countries.push({ name, code: '' });
                }
            }
        }
        async loadCountries() {
            try {
                const rows = await window.SIXO_GEOGRAPHY?.countries();
                if (!this.store.current() || !rows?.length) return;
                const seedByCode = new Map(ARRIVE_COUNTRY_SEEDS.map(item => [item.code, item]));
                this.countries = rows.filter(row => row.name && row.code).map(row => {
                    const code = text(row.code, 8).toUpperCase();
                    return { name: text(row.name), code, aliases: seedByCode.get(code)?.aliases || [] };
                });
                for (const seed of ARRIVE_COUNTRY_SEEDS) if (!this.countries.some(item => item.code === seed.code)) this.countries.push(seed);
                this.addObservedCountries();
                this.loadCitiesForCountry();
                if (!this.root.querySelector('#arrive-discovery-country-options').hidden) this.showPicker('country');
            } catch { /* Common destinations and countries in the feed still work offline. */ }
        }
        updateCities() {
            const country = countryKey(this.app, this.store.state.preferences.country);
            const observed = this.records.filter(item => countryKey(this.app, item.country) === country).map(item => text(item.city)).filter(Boolean);
            const curated = this.app.getVehicleCountryMajorCities?.(this.store.state.preferences.country, { limit: 50 }) || [];
            const cacheKey = JSON.stringify([country, observed, curated, this.cityCatalog.length]);
            if (cacheKey === this.cityCacheKey) return;
            this.cityCacheKey = cacheKey;
            this.cityOptions = [...new Set([...observed, ...curated, ...this.cityCatalog].filter(Boolean))].sort((a, b) => a.localeCompare(b));
        }
        async loadCitiesForCountry() {
            const country = this.store.state.preferences.country, key = countryKey(this.app, country);
            if (key === this.cityLoadKey) return;
            this.cityLoadKey = key; this.cityCatalog = []; this.cityCacheKey = '';
            const request = ++this.cityRequest;
            this.updateCities();
            const code = this.countries.find(item => countryKey(this.app, item.name) === key || fold(item.code) === fold(country))?.code;
            if (!code || !window.SIXO_GEOGRAPHY?.cities) return;
            try {
                const rows = await window.SIXO_GEOGRAPHY.cities(code);
                if (!this.store.current() || request !== this.cityRequest || key !== countryKey(this.app, this.store.state.preferences.country)) return;
                this.cityCatalog = rows.map(item => text(item.city, 120)).filter(Boolean);
                this.cityCacheKey = ''; this.updateCities();
                if (!this.root.querySelector('#arrive-discovery-city-options').hidden) this.showPicker('city');
            } catch { /* Typing a city and known local destinations remain usable. */ }
        }
        hidePicker(field) {
            const input = this.fields[field], menu = this.root.querySelector('#arrive-discovery-' + field + '-options');
            menu.hidden = true;
            if (field === 'country') this.root.querySelector('#arrive-discovery-country-picker').hidden = true;
            const control = field === 'country' ? this.countrySearch : input;
            control.setAttribute('aria-expanded', 'false'); control.removeAttribute('aria-activedescendant');
        }
        highlightOption(field, index) {
            const list = this.menuItems[field], menu = this.root.querySelector('#arrive-discovery-' + field + '-options');
            if (!list.length) return;
            this.activeOption[field] = Math.min(list.length - 1, Math.max(0, index));
            for (const [position, button] of [...menu.querySelectorAll('[data-arrive-option]')].entries()) {
                const active = position === this.activeOption[field];
                button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
                if (active) (field === 'country' ? this.countrySearch : this.fields[field]).setAttribute('aria-activedescendant', button.id);
            }
            const selected = menu.querySelector('[aria-selected="true"]');
            selected?.scrollIntoView({ block: 'nearest' });
        }
        showPicker(field) {
            const input = field === 'country' ? this.countrySearch : this.fields[field];
            const menu = this.root.querySelector('#arrive-discovery-' + field + '-options');
            const query = text(input.value);
            const matches = field === 'country' ? matchingCountries(this.countries, query)
                : !this.store.state.preferences.country ? []
                    : this.cityOptions.filter(city => !query || fold(city).includes(fold(query))).slice(0, query ? 30 : 70);
            this.menuItems[field] = matches; this.activeOption[field] = 0;
            menu.innerHTML = matches.length ? matches.map((item, index) => {
                const name = field === 'country' ? item.name : item;
                const extra = field === 'country' && item.code ? '<small>' + escape(item.code) + '</small>' : '';
                return '<button type="button" role="option" class="arrive-destination-option" data-arrive-option="' + escape(name) +
                    '" id="arrive-' + field + '-option-' + index + '" aria-selected="' + (index === 0) + '"><span>' + escape(name) + '</span>' + extra + '</button>';
            }).join('') : '<p class="arrive-destination-empty">' + (field === 'country' ? 'No matching country.' : this.store.state.preferences.country ? 'No matching city. You can type a city manually.' : 'Choose a country first.') + '</p>';
            if (field === 'country') this.root.querySelector('#arrive-discovery-country-picker').hidden = false;
            menu.hidden = false; input.setAttribute('aria-expanded', 'true');
            if (matches.length) this.highlightOption(field, 0);
        }
        selectDestination(field, value) {
            const prefs = this.store.state.preferences, chosen = text(value);
            if (!chosen) return;
            if (field === 'country') {
                const country = this.countries.find(item => item.name === chosen);
                if (!country) return;
                const changed = countryKey(this.app, prefs.country) !== countryKey(this.app, chosen);
                prefs.country = chosen; this.fields.country.value = chosen; this.countrySearch.value = '';
                if (changed) { prefs.city = ''; this.fields.city.value = ''; this.cityLoadKey = ''; }
                this.loadCitiesForCountry();
            } else {
                prefs.city = chosen; this.fields.city.value = chosen;
            }
            this.hidePicker(field);
            prefs.updatedAt = this.stamp(); this.tab = 'discover'; this.limit = 24; this.signature = '';
            this.syncLegacy(); this.render(); this.store.save();
        }
        settleCountryText() {
            const raw = fold(this.countrySearch.value);
            const match = this.countries.find(item => [item.name, item.code, ...(item.aliases || [])].some(alias => fold(alias) === raw));
            if (match) this.selectDestination('country', match.name);
            else if (!this.root.querySelector('#arrive-discovery-country-options').contains(document.activeElement)) this.hidePicker('country');
        }
        bind() {
            const options = { signal: this.abort.signal };
            const update = event => {
                const field = Object.keys(this.fields).find(key => this.fields[key] === event.target);
                const checklist = event.target.matches('#arrive-plus-checklist input[type="checkbox"]');
                if (!field && !checklist) return;
                if (field === 'country') return; // Search input is committed only when a country is selected.
                const prefs = this.store.state.preferences;
                if (field) prefs[field] = text(event.target.value);
                if (checklist) prefs.categories = [...this.root.querySelectorAll('#arrive-plus-checklist input:checked')].map(x => x.value).filter(x => CATEGORIES.includes(x));
                prefs.updatedAt = this.stamp(); this.tab = 'discover'; this.limit = 24; this.signature = '';
                this.syncLegacy(); this.render();
                window.clearTimeout(this.timer);
                if (event.type === 'change') this.store.save(); else this.timer = window.setTimeout(() => this.store.save(), 350);
            };
            this.root.addEventListener('input', update, { ...options, capture: true });
            this.root.addEventListener('change', update, { ...options, capture: true });
            // Country and City are side by side; tapping Country opens its searchable popover.
            this.fields.country.addEventListener('click', () => {
                this.showPicker('country');
                this.countrySearch.focus();
            }, options);
            this.fields.country.addEventListener('keydown', event => {
                if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                this.showPicker('country');
                this.countrySearch.focus();
            }, options);
            this.countrySearch.addEventListener('focus', () => this.showPicker('country'), options);
            this.countrySearch.addEventListener('input', () => this.showPicker('country'), options);
            this.countrySearch.addEventListener('keydown', event => {
                const menu = this.root.querySelector('#arrive-discovery-country-options');
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (menu.hidden) this.showPicker('country');
                    else this.highlightOption('country', this.activeOption.country + (event.key === 'ArrowDown' ? 1 : -1));
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const selected = this.menuItems.country[this.activeOption.country];
                    if (!menu.hidden && selected) this.selectDestination('country', selected.name);
                    else this.settleCountryText();
                } else if (event.key === 'Escape') {
                    event.preventDefault(); this.countrySearch.value = ''; this.hidePicker('country');
                }
            }, options);
            this.countrySearch.addEventListener('blur', () => {
                window.setTimeout(() => {
                    if (!this.store.current()) return;
                    if (this.root.querySelector('#arrive-discovery-country-options').contains(document.activeElement)) return;
                    this.settleCountryText();
                }, 180);
            }, options);
            this.root.querySelector('#arrive-discovery-country-options').addEventListener('click', event => {
                const choice = event.target.closest('[data-arrive-option]');
                if (choice) this.selectDestination('country', choice.dataset.arriveOption);
            }, options);
            const cityInput = this.fields.city, cityMenu = this.root.querySelector('#arrive-discovery-city-options');
            cityInput.addEventListener('focus', () => this.showPicker('city'), options);
            cityInput.addEventListener('input', () => this.showPicker('city'), options);
            cityInput.addEventListener('keydown', event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (cityMenu.hidden) this.showPicker('city');
                    else this.highlightOption('city', this.activeOption.city + (event.key === 'ArrowDown' ? 1 : -1));
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const selected = this.menuItems.city[this.activeOption.city];
                    if (!cityMenu.hidden && selected) this.selectDestination('city', selected);
                    else { this.hidePicker('city'); cityInput.blur(); }
                } else if (event.key === 'Escape') {
                    event.preventDefault(); this.hidePicker('city');
                }
            }, options);
            cityMenu.addEventListener('click', event => {
                const choice = event.target.closest('[data-arrive-option]');
                if (choice) this.selectDestination('city', choice.dataset.arriveOption);
            }, options);
            cityInput.addEventListener('blur', () => {
                window.setTimeout(() => { if (this.store.current()) this.hidePicker('city'); }, 180);
            }, options);
            this.root.querySelector('#arrive-discovery-tabs').addEventListener('click', event => {
                const tab = event.target.closest('[data-arrive-tab]');
                if (!tab) return;
                this.tab = tab.dataset.arriveTab; this.limit = 24; this.signature = ''; this.render();
            }, options);
            this.root.querySelector('#arrive-discovery-tabs').addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                this.tab = event.key === 'Home' ? 'discover' : event.key === 'End' ? 'saved' : this.tab === 'saved' ? 'discover' : 'saved';
                this.signature = ''; this.render();
                this.root.querySelector('[data-arrive-tab="' + this.tab + '"]').focus();
            }, options);
            this.root.querySelector('#arrive-plus-preview-list').addEventListener('click', event => {
                const save = event.target.closest('[data-arrive-save]');
                const open = event.target.closest('[data-arrive-open]');
                if (save) this.toggle(save.dataset.arriveSave);
                if (open) this.open(open.dataset.arriveOpen);
            }, options);
            this.root.querySelector('#arrive-discovery-more').addEventListener('click', () => { this.limit += 24; this.signature = ''; this.render(); }, options);
            window.addEventListener('storage', event => {
                if (event.key !== this.store.key || !this.store.current() || !event.newValue) return;
                try { this.store.state = merge(this.store.state, JSON.parse(event.newValue)); this.hydrate(); this.signature = ''; this.render(); } catch {}
            }, options);
        }
        toggle(key) {
            if (!this.store.current()) return;
            const existing = this.store.state.saved.find(x => x.key === key);
            const live = this.records.find(x => x.key === key);
            if (!existing && !live) return;
            const deleted = Boolean(existing && !existing.deleted);
            if (!deleted && this.store.state.saved.filter(x => !x.deleted).length >= 500) { this.announce('You have saved 500 listings. Remove one before saving another.'); return; }
            const entry = { ...(live ? snapshot(live) : existing), updatedAt: this.stamp(), deleted };
            this.store.state.saved = [...this.store.state.saved.filter(x => x.key !== key), entry];
            const ok = this.store.save(); this.signature = ''; this.render();
            this.announce(ok ? deleted ? 'Listing removed from your itinerary.' : 'Saved to your itinerary. Open Saved itinerary to view it.' : 'This listing is kept while the page is open. Device storage is unavailable.');
            const button = [...this.root.querySelectorAll('[data-arrive-save]')].find(x => x.dataset.arriveSave === key);
            if (button) button.focus(); else this.root.querySelector('[data-arrive-tab="saved"]').focus();
        }
        announce(message) { this.root.querySelector('#arrive-discovery-status').textContent = message; }
        open(key) {
            const item = this.records.find(x => x.key === key);
            if (!item) { this.announce('This listing is no longer available. You can remove it from your itinerary.'); return; }
            const raw = item.raw;
            if (item.kind === 'service') this.app.openServiceModal(raw);
            else if (item.kind === 'vehicle') this.app.openVehicleListingModal(raw.id);
            else if (item.kind === 'realestate') this.app.openRealestateModalById(raw.id);
            else if (item.kind === 'community' && raw.marketplaceItemId != null) {
                const original = (this.app.marketplaceItems || []).find(record => String(record.id) === String(raw.marketplaceItemId));
                if (original) this.app.openMarketplaceItemModal(original);
                else this.announce('This listing is no longer available.');
            }
            else if (item.kind === 'community') this.app.openCommunityPostMarketplaceModal(raw.id);
            else this.app.openMarketplaceItemModal(raw);
        }
        render() {
            if (!this.store.current()) return;
            const prefs = this.store.state.preferences;
            const extraCount = prefs.categories.filter(value => !CATEGORIES.slice(0, 6).includes(value)).length;
            this.root.querySelector('.arrive-discovery-more-interests summary').textContent = extraCount ? 'More interests (' + extraCount + ' selected)' : 'More interests';
            this.records = collect(this.app);
            const observed = [...new Set(this.records.map(x => x.country))];
            this.addObservedCountries();
            this.updateCities();
            const saved = this.store.state.saved.filter(x => !x.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
            const live = new Map(this.records.map(item => [item.key, item]));
            const items = this.tab === 'saved' ? saved.map(entry => ({ ...entry, ...(live.get(entry.key) || {}), unavailable: !live.has(entry.key) })) : discover(this.app, this.records, prefs);
            this.root.querySelector('#arrive-discovery-count').textContent = saved.length;
            this.root.querySelector('#arrive-discovery-storage').textContent = this.store.status();
            const title = this.root.querySelector('#arrive-discovery-title');
            title.textContent = this.tab === 'saved' ? 'Your saved itinerary' : prefs.city ? 'Discover ' + prefs.city : prefs.country ? 'Discover ' + prefs.country : 'Discover your destination';
            this.root.querySelectorAll('[data-arrive-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.arriveTab === this.tab)));
            this.root.querySelector('#arrive-plus-preview-list').setAttribute('aria-labelledby', 'arrive-tab-' + this.tab);
            const datesInvalid = prefs.startDate && prefs.endDate && prefs.endDate < prefs.startDate;
            const error = this.root.querySelector('#arrive-discovery-date-error');
            error.hidden = !datesInvalid; error.textContent = datesInvalid ? 'Departure must be on or after arrival.' : '';
            this.root.querySelector('#arrive-plus-preview-subtitle').textContent = this.tab === 'saved' ? 'Open a saved profile to view its details. Your choices stay here when you change the checklist or destination.' : prefs.country ? [prefs.country, prefs.city ? prefs.city + ' first' : '', prefs.startDate && prefs.endDate && !datesInvalid ? this.app.formatScheduleRangeShort(prefs.startDate, prefs.endDate) : ''].filter(Boolean).join(' · ') : 'Choose a country and check your interests to see matching listings.';
            const summary = this.root.querySelector('#arrive-plus-preview-summary');
            summary.textContent = items.length ? items.length + (items.length === 1 ? ' listing' : ' listings') : '';
            summary.classList.toggle('is-empty', !items.length);
            this.root.querySelector('#arrive-discovery-more').hidden = items.length <= this.limit;
            const signature = JSON.stringify([this.tab, this.limit, prefs.country, prefs.city, saved, items.slice(0, this.limit).map(x => [x.key, x.title, x.image, x.price, x.city, x.eventDate, x.unavailable])]);
            if (signature === this.signature) return;
            this.signature = signature;
            const list = this.root.querySelector('#arrive-plus-preview-list');
            if (!items.length) {
                const heading = this.tab === 'saved' ? 'Keep the listings you like.' : !prefs.country ? 'Where are you heading?' : !prefs.categories.length ? 'What would you like to explore?' : 'No matching listings here yet.';
                const detail = this.tab === 'saved' ? 'Tap Save to itinerary on a profile in Discover to find it here later.' : !prefs.country ? 'Choose your destination country to get started.' : !prefs.categories.length ? 'Check a category and matching listings will appear here.' : 'Try another interest or travel window. Your saved choices stay in Saved itinerary.';
                list.innerHTML = '<div class="arrive-discovery-empty"><i class="fas fa-' + (this.tab === 'saved' ? 'bookmark' : 'compass') + '" aria-hidden="true"></i><h4>' + heading + '</h4><p>' + detail + '</p></div>';
                return;
            }
            list.innerHTML = items.slice(0, this.limit).map(item => {
                const isSaved = saved.some(x => x.key === item.key);
                const cityMatch = matchesCity(this.app, item.city, prefs.city) && countryKey(this.app, item.country) === countryKey(this.app, prefs.country);
                const badge = item.unavailable ? 'Unavailable' : cityMatch ? 'In your city' : item.country;
                return '<article class="arrive-discovery-card" data-arrive-listing="' + escape(item.key) + '">' +
                    '<div class="arrive-discovery-photo"><img src="' + escape(item.image) + '" alt="' + escape(item.title) + '" loading="lazy" decoding="async"><span>' + escape(badge) + '</span></div>' +
                    '<div class="arrive-discovery-copy"><p class="arrive-discovery-category">' + escape(item.categories.join(' · ')) + '</p><h4>' + escape(item.title) + '</h4>' +
                    '<p class="arrive-discovery-location"><i class="fas fa-location-dot" aria-hidden="true"></i> ' + escape([item.city, item.country].filter(Boolean).join(', ')) + '</p>' +
                    (item.eventDate ? '<p class="arrive-discovery-event">' + escape(this.app.formatScheduleDate(item.eventDate)) + '</p>' : '') +
                    '<p class="arrive-discovery-price">' + escape(item.unavailable ? 'Listing no longer available' : item.price) + '</p>' +
                    '<div class="arrive-discovery-actions"><button type="button" data-arrive-save="' + escape(item.key) + '" aria-pressed="' + isSaved + '" aria-label="' + (isSaved ? 'Remove ' : 'Save ') + escape(item.title) + (isSaved ? ' from itinerary' : ' to itinerary') + '"><i class="' + (isSaved ? 'fas' : 'far') + ' fa-bookmark" aria-hidden="true"></i> ' + (isSaved ? 'Saved ✓' : 'Save to itinerary') + '</button>' +
                    '<button type="button" data-arrive-open="' + escape(item.key) + '"' + (item.unavailable ? ' disabled' : '') + '>View listing</button></div></div></article>';
            }).join('');
        }
    }
    let controller;
    const api = {
        mount(app) {
            const root = document.getElementById('arrive-plus-schedule');
            if (!root?.querySelector('#arrive-discovery-tabs')) return null;
            if (!controller || controller.app !== app || !controller.store.current()) {
                controller?.retire(); controller = new Discovery(app, root);
            } else controller.render();
            return controller;
        },
        refresh(app) { if (app.activeScreen !== 'arrive') return false; return Boolean(this.mount(app)); },
        restore(app) { if (controller?.app === app && controller.store.current()) { controller.hydrate(); controller.render(); } },
        refreshIdentity(app) { if (controller && controller.app === app && !controller.store.current()) this.mount(app); },
        model: Object.freeze({ CATEGORIES, fold, dateKey, snapshot, normalize, merge, Store, categoriesFor, collect, discover, matchesCity })
    };
    window.SIXO_ARRIVE_DISCOVERY = api;
})(window, document);
