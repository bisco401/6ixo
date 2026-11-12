(function (window) {
    'use strict';
    const MODES = Object.freeze({
        solo: { title: 'Good days, at your own pace.', day: 'Make the day your own.', subtitle: 'Explore a little, meet a few people, or simply slow down.', adults: 1, children: 0, budget: 150, defaults: ['Short stays', 'City tours', 'Beach day'], order: ['City tours', 'Gym', 'Excursions', 'Beach day', 'Restaurants', 'Shopping', 'Events', 'Spa & Beauty', 'Nightlife'] },
        couple: { title: 'A little more time for two.', day: 'Your day together, sorted.', subtitle: 'Time to explore, unwind, and enjoy an evening together.', adults: 2, children: 0, budget: 200, defaults: ['Short stays', 'Beach day', 'Restaurants'], order: ['Spa & Beauty', 'City tours', 'Beach day', 'Excursions', 'Restaurants', 'Events', 'Shopping', 'Nightlife', 'Gym'] },
        family: { title: 'Made for your family.', day: 'One lovely day. Planned together.', subtitle: 'A relaxed day with breaks and room for everyone.', adults: 2, children: 2, budget: 250, defaults: ['Short stays', 'Beach day', 'Airport pickup'], order: ['City tours', 'Shopping', 'Beach day', 'Excursions', 'Restaurants', 'Events', 'Gym', 'Spa & Beauty'] }
    });
    const ESSENTIALS = ['Airport ride', 'Place to stay', 'Mobile data', 'Travel essentials'];
    const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'GYD', 'JMD', 'GHS', 'NGN', 'KES', 'AED', 'INR', 'AUD'];
    const escape = value => String(value ?? '').slice(0, 4000).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const number = (value, fallback, min, max) => value !== '' && value != null && Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
    function normalize(raw = {}) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const mode = Object.prototype.hasOwnProperty.call(MODES, raw.mode) ? raw.mode : 'solo';
        return {
            mode, adults: number(raw.adults, MODES[mode].adults, 1, 12), children: mode === 'family' ? number(raw.children, MODES[mode].children, 0, 10) : 0,
            budget: number(raw.budget, MODES[mode].budget, 0, 1000000), currency: /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : 'USD',
            hideAboveBudget: raw.hideAboveBudget === true, interestsCustomized: raw.interestsCustomized === true,
            essentials: [...new Set((Array.isArray(raw.essentials) ? raw.essentials : []).filter(value => ESSENTIALS.includes(value)))],
            planOpen: raw.planOpen === true
        };
    }
    // Compare explicit advertised amounts only. Do not infer exchange rates,
    // parse a price range as one amount, or turn an unknown price into zero.
    function quote(app, item) {
        const raw = item.raw || {};
        const options = { country: item.country, currency: raw.currency || raw.realestate?.currency || raw.vehicle?.currency || '' };
        const formatted = String(app.formatListingPriceText?.(item.price, options) || item.price || '').trim();
        const match = formatted.match(/^(?:From\s+)?([A-Z]{3})\s+((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(?:\/|per)\s*(?:night|day|person|hour|week|month))?(?:\s*\+\s*tax)?$/i);
        if (!match) return null;
        const amount = Number(match[2].replace(/,/g, ''));
        return Number.isFinite(amount) && amount >= 0 ? { amount, currency: match[1].toUpperCase() } : null;
    }
    function aboveBudget(app, item, rawTrip) {
        const trip = normalize(rawTrip), price = quote(app, item);
        return Boolean(price && price.currency === trip.currency && price.amount > trip.budget);
    }
    function capacity(item) {
        const raw = item.raw || {};
        const stay = item.categories.includes('Short stays');
        const ride = item.categories.some(category => ['Car rental', 'Airport pickup', 'Private driver'].includes(category));
        const value = stay ? raw.maxGuests ?? raw.realestate?.maxGuests : ride ? raw.seats ?? raw.vehicle?.seats ?? raw.passengerCapacity : null;
        return value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0 ? { count: Number(value), label: stay ? 'Sleeps' : 'Seats' } : null;
    }
    function score(item, rawTrip) {
        const trip = normalize(rawTrip), room = capacity(item);
        if (room && room.count < trip.adults + trip.children) return -100;
        const positions = item.categories.map(category => MODES[trip.mode].order.indexOf(category)).filter(index => index >= 0);
        return (room ? 20 : 0) + (positions.length ? 10 - Math.min(...positions) : 0);
    }
    function facts(app, item, rawTrip) {
        const trip = normalize(rawTrip), room = capacity(item), labels = [];
        if (room) labels.push(room.label + ' ' + room.count + (room.count < trip.adults + trip.children ? ' · smaller than your group' : ''));
        if (aboveBudget(app, item, trip)) labels.push('Above your ' + trip.currency + ' ' + trip.budget.toLocaleString('en-US') + ' guide');
        return labels;
    }
    function buildDay(items, rawTrip, savedKeys = []) {
        const trip = normalize(rawTrip);
        const businessOffer = item => /\b(?:chair|booth|station|salon space|treatment room)\s+(?:for\s+)?rent(?:al)?\b|\b(?:hiring|staff wanted|job vacancy|equipment for sale|house cleaner|house cleaning)\b/i.test(item.title);
        const choices = items.filter(item => !businessOffer(item) && item.categories.some(category => category !== 'Shopping' && MODES[trip.mode].order.includes(category)) && !(trip.mode === 'family' && item.categories.includes('Nightlife')));
        const used = new Set();
        const slots = [
            { time: 'Morning', categories: trip.mode === 'couple' ? ['Spa & Beauty', 'City tours', 'Shopping', 'Gym'] : ['City tours', 'Gym', 'Shopping', 'Spa & Beauty'] },
            { time: 'Afternoon', categories: ['Beach day', 'Excursions', 'City tours', 'Shopping'] },
            { time: 'Evening', categories: trip.mode === 'family' ? ['Restaurants', 'Events'] : ['Restaurants', 'Events', 'Nightlife'] }
        ];
        return slots.map(slot => {
            const ranked = choices.filter(item => !used.has(item.key) && item.categories.some(category => slot.categories.includes(category)))
                .sort((a, b) => Number(savedKeys.includes(b.key)) - Number(savedKeys.includes(a.key)) || score(b, trip) - score(a, trip));
            const item = ranked[0] || null;
            if (item) used.add(item.key);
            return { time: slot.time, item };
        });
    }
    class Planner {
        constructor(discovery) {
            this.d = discovery; this.root = discovery.root; this.planItems = []; this.signature = '';
            const options = { signal: discovery.abort.signal };
            this.root.addEventListener('click', event => {
                const mode = event.target.closest('[data-arrive-trip-type]');
                if (mode) {
                    const prefs = this.d.store.state.preferences, previous = normalize(prefs.trip), next = MODES[mode.dataset.arriveTripType];
                    if (!next) return;
                    prefs.trip = normalize({ ...previous, mode: mode.dataset.arriveTripType, adults: next.adults, children: next.children, budget: previous.budget === MODES[previous.mode].budget ? next.budget : previous.budget });
                    if (!previous.interestsCustomized || !prefs.categories.length) {
                        prefs.categories = next.defaults.slice(); prefs.activeCategory = prefs.categories[0];
                    }
                    this.commit();
                    this.d.announce('Trip suggestions updated for ' + (mode.dataset.arriveTripType === 'solo' ? 'a solo trip.' : mode.dataset.arriveTripType === 'couple' ? 'a couple’s trip.' : 'your family.'));
                }
                if (event.target.closest('#arrive-trip-build-day')) {
                    const prefs = this.d.store.state.preferences;
                    prefs.trip = normalize({ ...prefs.trip, planOpen: !prefs.trip.planOpen });
                    this.commit(false, true);
                    this.d.announce(prefs.trip.planOpen ? 'Your suggested day is ready. Confirm times and availability with each provider.' : 'Day plan closed.');
                }
                if (event.target.closest('[data-arrive-save-day]')) this.saveDay();
            }, options);
            this.root.addEventListener('change', event => {
                const field = event.target.dataset.arriveTripField;
                const essential = event.target.dataset.arriveEssential;
                if (!field && !essential) return;
                const prefs = this.d.store.state.preferences, trip = normalize(prefs.trip);
                if (field) trip[field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
                if (essential) trip.essentials = [...this.root.querySelectorAll('[data-arrive-essential]:checked')].map(input => input.dataset.arriveEssential);
                prefs.trip = normalize(trip); this.commit(false, Boolean(essential));
            }, options);
            this.root.querySelector('#arrive-trip-budget-range').addEventListener('input', event => {
                const prefs = this.d.store.state.preferences;
                prefs.trip = normalize({ ...prefs.trip, budget: event.target.value });
                this.commit(true);
            }, options);
            this.root.querySelector('#arrive-trip-budget-range').addEventListener('change', () => {
                window.clearTimeout(this.d.timer); this.d.store.save();
            }, options);
        }
        commit(debounce = false, preserveView = false) {
            if (!this.d.store.current()) return;
            const prefs = this.d.store.state.preferences;
            prefs.updatedAt = this.d.stamp(); if (!preserveView) this.d.tab = 'discover'; this.d.limit = 24; this.d.signature = '';
            this.d.hydrate(); this.d.render();
            window.clearTimeout(this.d.timer);
            if (debounce) this.d.timer = window.setTimeout(() => this.d.store.save(), 350); else this.d.store.save();
        }
        saveDay() {
            if (!this.d.store.current()) return;
            const keys = this.planItems.map(item => item.key), saved = this.d.store.state.saved;
            const additions = this.d.records.filter(item => keys.includes(item.key) && !saved.some(entry => entry.key === item.key && !entry.deleted));
            if (saved.filter(item => !item.deleted).length + additions.length > 500) { this.d.announce('Remove some saved ideas before adding this day.'); return; }
            const snapshot = window.SIXO_ARRIVE_DISCOVERY.model.snapshot;
            for (const item of additions) {
                this.d.store.state.saved = this.d.store.state.saved.filter(entry => entry.key !== item.key);
                this.d.store.state.saved.push({ ...snapshot(item), updatedAt: this.d.stamp(), deleted: false });
            }
            const ok = this.d.store.save(); this.d.signature = ''; this.d.render();
            this.d.announce(ok ? keys.length ? 'Day ideas saved. Find them in Saved itinerary.' : 'Choose a destination and matching activities to add ideas to your day.' : 'Your ideas are kept while this page is open. Device storage is unavailable.');
            this.root.querySelector('[data-arrive-save-day]')?.focus({ preventScroll: true });
        }
        render(items, saved) {
            const prefs = this.d.store.state.preferences, trip = normalize(prefs.trip), mode = MODES[trip.mode];
            const q = selector => this.root.querySelector(selector);
            this.root.querySelectorAll('[data-arrive-trip-type]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.arriveTripType === trip.mode)));
            q('#arrive-trip-adults').value = trip.adults; q('#arrive-trip-children').value = trip.children;
            q('#arrive-trip-children-label').hidden = trip.mode !== 'family';
            q('#arrive-trip-budget').value = trip.budget;
            const slider = q('#arrive-trip-budget-range'); slider.max = Math.max(600, Math.ceil(trip.budget / 500) * 500); slider.value = trip.budget;
            const localCurrency = this.d.app.getListingCurrency?.('', { country: prefs.country });
            const currencies = [...new Set([...CURRENCIES, trip.currency, localCurrency].filter(value => /^[A-Z]{3}$/.test(value)))];
            const currency = q('#arrive-trip-currency');
            if (currencies.join(',') !== this.currencySignature) { currency.innerHTML = currencies.map(code => '<option value="' + code + '">' + code + '</option>').join(''); this.currencySignature = currencies.join(','); }
            currency.value = trip.currency;
            q('#arrive-trip-budget-filter').checked = trip.hideAboveBudget;
            q('#arrive-trip-budget-currency-label').textContent = '(' + trip.currency + ')';
            q('#arrive-trip-day-title').textContent = mode.day; q('#arrive-trip-day-subtitle').textContent = mode.subtitle;
            const button = q('#arrive-trip-build-day'); button.textContent = trip.planOpen ? 'Close day plan' : 'Build my day'; button.setAttribute('aria-expanded', String(trip.planOpen));
            q('#arrive-trip-day-plan').hidden = !trip.planOpen;
            // Country-wide discovery is useful, but a day plan needs a city to
            // avoid presenting providers in distant cities as consecutive stops.
            const slots = buildDay(prefs.city ? items : [], trip, saved.map(item => item.key));
            this.planItems = slots.map(slot => slot.item).filter(Boolean);
            const signature = JSON.stringify([trip, prefs.country, prefs.city, slots.map(slot => slot.item ? [slot.item.key, slot.item.title, slot.item.price] : null), saved.map(item => item.key)]);
            if (trip.planOpen && signature !== this.signature) {
                this.signature = signature;
                const destination = [prefs.city, prefs.country].filter(Boolean).join(', ');
                const lead = !prefs.country ? 'Choose your destination to find ideas for the day.' : !prefs.city ? 'Add a city above so your day’s ideas stay in one place.' : !this.planItems.length ? 'No matching activities for this day yet. Choose activities above or try another city.' : 'Suggested order for ' + destination + '. Confirm opening hours, availability, group suitability, and travel time.';
                q('#arrive-trip-day-plan').innerHTML = '<p class="arrive-trip-plan-note">' + escape(lead) + '</p><div class="arrive-trip-stops">' + slots.map(slot => '<article class="arrive-trip-stop"><span>' + slot.time + '</span>' + (slot.item
                    ? '<h4>' + escape(slot.item.title) + '</h4><p>' + escape(slot.item.categories.join(' · ')) + '</p><strong>' + escape(slot.item.price) + '</strong><button type="button" data-arrive-open="' + escape(slot.item.key) + '">View listing</button>'
                    : '<h4>Keep some time free</h4><p>Add a matching activity when you find one you like.</p>') + '</article>').join('') + '</div><div class="arrive-trip-plan-footer"><span>Ideas for ' + trip.adults + (trip.adults === 1 ? ' adult' : ' adults') + (trip.children ? ' and ' + trip.children + (trip.children === 1 ? ' child' : ' children') : '') + ' · No bookings made</span><button type="button" data-arrive-save-day' + (this.planItems.length ? '' : ' disabled') + '>Save day’s listings</button></div>';
            }
            this.root.querySelectorAll('[data-arrive-essential]').forEach(input => input.checked = trip.essentials.includes(input.dataset.arriveEssential));
            q('#arrive-trip-essential-count').textContent = trip.essentials.length + ' of 4 ready';
        }
    }
    window.SIXO_ARRIVE_TRIP = Object.freeze({ MODES, normalize, quote, aboveBudget, score, facts, buildDay, mount: discovery => new Planner(discovery) });
})(window);
