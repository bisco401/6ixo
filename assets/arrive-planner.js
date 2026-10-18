(function (window, document) {
    'use strict';

    const STATE_KEY = 'arrive_planner_v1';
    const DAY = 86400000;
    const text = (value, limit = 300) => String(value ?? '').trim().slice(0, limit);
    const escape = value => text(value, 4000).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const uid = () => window.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    function requestTimeout(promise, milliseconds = 6000) {
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('Account sync timed out')), milliseconds);
            Promise.resolve(promise).then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
        });
    }
    function dateNumber(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return NaN;
        const n = Date.parse(`${value}T12:00:00Z`);
        return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? n : NaN;
    }
    function dates(start, end) {
        const a = dateNumber(start), b = dateNumber(end);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || (b - a) / DAY >= 366) return [];
        return Array.from({ length: Math.round((b - a) / DAY) + 1 }, (_, i) => new Date(a + i * DAY).toISOString().slice(0, 10));
    }
    const label = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
    function cents(value) {
        const raw = text(value, 30);
        if (!raw) return null;
        const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(raw);
        return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : NaN;
    }
    function money(value, currency) {
        try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100); }
        catch { return `${currency} ${(value / 100).toFixed(2)}`; }
    }
    function normalizeItem(raw, trip) {
        if (!raw || typeof raw !== 'object' || !text(raw.id) || !text(raw.title)) return null;
        const day = Number.isFinite(dateNumber(raw.date)) && raw.date >= trip.startDate && raw.date <= trip.endDate ? raw.date : '';
        const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time || '') ? raw.time : '';
        const currency = /^[A-Z]{3}$/.test(raw.currency || '') ? raw.currency : 'USD';
        const cost = Number.isSafeInteger(raw.cost) && raw.cost >= 0 && raw.cost <= 9999999999 ? raw.cost : null;
        const period = time ? (Number(time.slice(0, 2)) < 12 ? 'morning' : Number(time.slice(0, 2)) < 18 ? 'afternoon' : 'evening') : (['morning', 'afternoon', 'evening'].includes(raw.period) ? raw.period : 'morning');
        const source = raw.source && ['restaurant', 'business', 'short_stay', 'car_rental', 'event', 'job', 'marketplace'].includes(raw.source.kind) && text(raw.source.id)
            ? { kind: raw.source.kind, id: text(raw.source.id, 200) } : null;
        return { id: text(raw.id), title: text(raw.title), date: day, time: day ? time : '', period, notes: text(raw.notes, 2000), cost, currency, source, updatedAt: Number(raw.updatedAt) || 0, deleted: raw.deleted === true };
    }
    function normalize(raw) {
        const trips = [];
        for (const entry of Array.isArray(raw?.trips) ? raw.trips.slice(0, 100) : []) {
            if (!entry || !text(entry.id) || !text(entry.destination) || !dates(entry.startDate, entry.endDate).length) continue;
            const trip = { id: text(entry.id), destination: text(entry.destination), startDate: entry.startDate, endDate: entry.endDate, sourceTripId: text(entry.sourceTripId), updatedAt: Number(entry.updatedAt) || 0, deleted: entry.deleted === true };
            const items = new Map();
            for (const value of Array.isArray(entry.items) ? entry.items.slice(0, 2000) : []) {
                const item = normalizeItem(value, trip);
                if (item && (!items.has(item.id) || items.get(item.id).updatedAt <= item.updatedAt)) items.set(item.id, item);
            }
            trip.items = [...items.values()];
            trips.push(trip);
        }
        return { version: 1, trips };
    }
    function merge(left, right) {
        const trips = new Map();
        for (const trip of [...normalize(left).trips, ...normalize(right).trips]) {
            const previous = trips.get(trip.id);
            if (!previous) { trips.set(trip.id, trip); continue; }
            const newer = previous.updatedAt > trip.updatedAt ? previous : trip;
            const items = new Map();
            for (const item of [...previous.items, ...trip.items]) if (!items.has(item.id) || items.get(item.id).updatedAt <= item.updatedAt) items.set(item.id, item);
            trips.set(trip.id, { ...newer, items: [...items.values()] });
        }
        return normalize({ trips: [...trips.values()] });
    }
    function resizeTrip(trip, startDate, endDate, destination) {
        const range = dates(startDate, endDate);
        if (!range.length) throw new Error('Choose a valid trip of up to 366 days.');
        const now = Date.now();
        let moved = 0;
        const items = trip.items.map(item => {
            if (!item.deleted && item.date && !range.includes(item.date)) { moved++; return { ...item, date: '', time: '', updatedAt: now }; }
            return item;
        });
        return { trip: { ...trip, destination, startDate, endDate, items, updatedAt: now }, moved };
    }
    function totals(items) {
        const values = {};
        for (const item of items) if (!item.deleted && item.cost !== null) values[item.currency] = (values[item.currency] || 0) + item.cost;
        return values;
    }

    // Account keys keep shared-browser plans separate. Cloud responses are also
    // checked against the initiating account before touching the current view.
    class PlanStore {
        constructor(app, changed = () => {}) {
            this.app = app; this.changed = changed;
            this.owner = app.isSignedIn && app.currentUser?.id ? String(app.currentUser.id) : 'guest';
            this.key = `${STATE_KEY}:${this.owner}`;
            this.state = normalize({}); this.pending = false; this.localOk = true;
            try { this.state = normalize(JSON.parse(window.localStorage.getItem(this.key) || '{}')); } catch { this.localOk = false; }
            this.cloudOk = false; this.queue = Promise.resolve(); this.writes = 0;
            this.ready = this.load();
            this.ready.then(() => { if (this.needsUpload && this.current()) this.save(this.state); });
        }
        current() { return !this.retired && this.owner === (this.app.isSignedIn && this.app.currentUser?.id ? String(this.app.currentUser.id) : 'guest'); }
        retire() { this.retired = true; this.state = normalize({}); }
        canSync() { return this.owner !== 'guest' && this.app.supabaseEnabled && this.app.supabase && this.current(); }
        cache() {
            try { window.localStorage.setItem(this.key, JSON.stringify(this.state)); this.localOk = true; }
            catch { this.localOk = false; }
        }
        async authenticated() {
            if (!this.canSync()) return false;
            const { data, error } = await requestTimeout(this.app.supabase.auth.getUser());
            return !error && data?.user?.id === this.owner && this.current();
        }
        async load() {
            if (!this.canSync()) return;
            this.pending = true; this.loading = true;
            try {
                if (!await this.authenticated()) { this.cloudOk = false; return; }
                const { data, error } = await requestTimeout(this.app.supabase.from('app_client_state').select('state_value').eq('user_id', this.owner).eq('state_key', STATE_KEY).maybeSingle());
                if (error) throw error;
                if (!this.current()) return;
                this.state = merge(this.state, data?.state_value);
                this.needsUpload = JSON.stringify(this.state) !== JSON.stringify(normalize(data?.state_value));
                this.cache(); this.cloudOk = !this.needsUpload;
            } catch { this.cloudOk = false; }
            finally { this.pending = false; this.loading = false; if (this.current()) this.changed(); }
        }
        save(state) {
            if (!this.current()) return false;
            this.state = normalize(state); this.cache(); this.changed();
            if (!this.canSync()) return this.localOk;
            this.writes++; this.pending = true; this.changed();
            this.queue = this.queue.then(async () => {
                await this.ready;
                if (!await this.authenticated()) { this.cloudOk = false; return; }
                const { data, error } = await requestTimeout(this.app.supabase.from('app_client_state').select('state_value').eq('user_id', this.owner).eq('state_key', STATE_KEY).maybeSingle());
                if (error) throw error;
                if (!this.current()) return;
                this.state = merge(data?.state_value, this.state);
                this.cache();
                const result = await requestTimeout(this.app.supabase.from('app_client_state').upsert({ user_id: this.owner, state_key: STATE_KEY, state_value: this.state, updated_at: new Date().toISOString() }, { onConflict: 'user_id,state_key' }));
                if (result.error) throw result.error;
                if (this.current()) this.cloudOk = true;
            }).catch(() => { if (this.current()) this.cloudOk = false; }).finally(() => { this.writes--; this.pending = this.writes > 0; if (this.current()) this.changed(); });
            return true;
        }
        status() {
            if (this.loading) return 'Loading your itineraries…';
            if (this.pending) return 'Saving your itinerary…';
            if (this.cloudOk) return 'Saved to your account';
            if (this.localOk) return this.owner === 'guest' ? 'Saved on this device' : 'Saved on this device · Account sync unavailable';
            return 'Unable to save on this device. Keep this page open and try again.';
        }
    }

    class Planner {
        constructor(app) {
            this.app = app; this.root = document.getElementById('arrive-day-planner');
            this.activeId = ''; this.selected = ''; this.month = ''; this.notice = ''; this.undo = null;
            this.store = new PlanStore(app, () => this.render());
            this.bind(); this.render();
            this.store.ready.then(() => {
                const input = this.inputs();
                if (this.trip() && !input.destination && !input.startDate && !input.endDate && this.store.current()) this.fillInputs(this.trip());
                this.render();
            });
        }
        trip() { return this.store.state.trips.find(t => t.id === this.activeId && !t.deleted); }
        async available() { await this.store.ready; return this.store.current(); }
        notify(message) { this.notice = message; this.render(); }
        inputs() {
            return { destination: text(document.getElementById('dating-schedule-destination')?.value), startDate: document.getElementById('dating-schedule-start')?.value || '', endDate: document.getElementById('dating-schedule-end')?.value || '' };
        }
        fillInputs(trip) {
            for (const [suffix, value] of [['destination', trip.destination], ['start', trip.startDate], ['end', trip.endDate]]) {
                const field = document.getElementById(`dating-schedule-${suffix}`); if (field) field.value = value;
            }
            const end = document.getElementById('dating-schedule-end'); if (end) end.min = trip.startDate;
            this.app.renderArrivePlusPreview();
        }
        choose(trip, fill = true) {
            this.activeId = trip.id; this.selected = trip.startDate; this.month = trip.startDate.slice(0, 7);
            this.notice = ''; this.undo = null;
            if (fill) this.fillInputs(trip);
            this.render();
            this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        async create(update = false) {
            if (!await this.available()) return null;
            const input = this.inputs();
            if (!input.destination || !dates(input.startDate, input.endDate).length) {
                this.notify('Enter a destination and valid travel dates above. Each itinerary can cover up to 366 days.');
                document.getElementById(!input.destination ? 'dating-schedule-destination' : 'dating-schedule-start')?.focus();
                return null;
            }
            let trip;
            if (update && this.trip()) {
                const result = resizeTrip(this.trip(), input.startDate, input.endDate, input.destination);
                trip = result.trip;
                this.store.state.trips = this.store.state.trips.map(t => t.id === trip.id ? trip : t);
                this.notice = result.moved ? `${result.moved} ${result.moved === 1 ? 'activity moved' : 'activities moved'} to Unscheduled because the trip dates changed.` : 'Trip dates updated.';
            } else {
                trip = this.store.state.trips.find(t => !t.deleted && t.destination.toLowerCase() === input.destination.toLowerCase() && t.startDate === input.startDate && t.endDate === input.endDate);
                if (!trip) {
                    if (this.store.state.trips.length >= 100) { this.notify('You have reached the limit of 100 itineraries.'); return null; }
                    trip = { ...input, id: uid(), items: [], updatedAt: Date.now() };
                    this.store.state.trips.push(trip);
                }
                this.notice = 'Itinerary ready. Add listings or your own activities.';
            }
            this.activeId = trip.id; this.selected = trip.startDate; this.month = trip.startDate.slice(0, 7);
            this.store.save(this.store.state); this.render();
            return trip;
        }
        bind() {
            const createButton = document.getElementById('arrive-planner-create');
            if (createButton) createButton.onclick = async event => {
                event.preventDefault();
                if (await this.create()) this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
            };
            this.root.addEventListener('change', async event => {
                if (event.target.id !== 'arrive-planner-trip' || !await this.available()) return;
                const value = event.target.value;
                if (value.startsWith('saved:')) {
                    const entry = (this.app.datingSchedule || []).find(t => String(t.id) === value.slice(6));
                    if (!entry || !dates(entry.startDate, entry.endDate).length) return;
                    if (this.store.state.trips.length >= 100) { this.notify('You have reached the limit of 100 itineraries.'); return; }
                    const trip = { id: uid(), sourceTripId: String(entry.id), destination: entry.destination, startDate: entry.startDate, endDate: entry.endDate, items: [], updatedAt: Date.now() };
                    this.store.state.trips.push(trip); this.choose(trip); this.store.save(this.store.state);
                } else {
                    const trip = this.store.state.trips.find(t => t.id === value && !t.deleted); if (trip) this.choose(trip);
                }
            });
            this.root.addEventListener('click', async event => {
                const button = event.target.closest('button[data-planner-action]');
                if (!button || !await this.available()) return;
                const action = button.dataset.plannerAction;
                if (action === 'new') { document.getElementById('dating-schedule-destination')?.focus(); return; }
                if (action === 'update') { await this.create(true); return; }
                const trip = this.trip(); if (!trip) return;
                if (action === 'day') { this.selected = button.dataset.day; if (this.selected !== 'unscheduled') this.month = this.selected.slice(0, 7); this.notice = ''; this.render(); document.getElementById('arrive-plan-day-title')?.focus({ preventScroll: true }); }
                if (action === 'month') { this.month = button.dataset.month; this.render(); document.getElementById('arrive-month-title')?.focus({ preventScroll: true }); }
                if (action === 'add') this.edit();
                if (action === 'edit') this.edit(trip.items.find(i => i.id === button.dataset.id));
                if (action === 'view') this.openSource(trip.items.find(i => i.id === button.dataset.id));
                if (action === 'remove') {
                    const item = trip.items.find(i => i.id === button.dataset.id); if (!item) return;
                    this.undo = { tripId: trip.id, item: { ...item } }; item.deleted = true; item.updatedAt = Date.now();
                    this.notice = 'Activity removed.'; this.store.save(this.store.state);
                }
                if (action === 'undo' && this.undo) {
                    const old = this.undo; const target = this.store.state.trips.find(t => t.id === old.tripId);
                    if (target) target.items = target.items.map(i => i.id === old.item.id ? { ...old.item, updatedAt: Date.now() } : i);
                    this.undo = null; this.notice = 'Activity restored.'; this.store.save(this.store.state);
                }
            });
        }
        render() {
            if (!this.root || !this.store.current()) return;
            const trips = this.store.state.trips.filter(t => !t.deleted);
            if (!this.trip() && trips.length) this.activeId = trips[0].id;
            const trip = this.trip();
            if (trip && this.selected !== 'unscheduled' && !dates(trip.startDate, trip.endDate).includes(this.selected)) this.selected = trip.startDate;
            if (trip && (!this.month || this.month < trip.startDate.slice(0, 7) || this.month > trip.endDate.slice(0, 7))) this.month = this.selected === 'unscheduled' ? trip.startDate.slice(0, 7) : this.selected.slice(0, 7);
            const saved = (this.app.datingSchedule || []).filter(t => dates(t.startDate, t.endDate).length && !trips.some(p => p.sourceTripId === String(t.id)));
            const signature = JSON.stringify([this.store.state, this.activeId, this.selected, this.month, this.notice, this.undo, saved]);
            const status = this.root.querySelector('.arrive-planner-save');
            if (signature === this.lastRender && status) { status.textContent = this.store.status(); return; }
            this.lastRender = signature;
            const focusedId = this.root.contains(document.activeElement) ? document.activeElement.id : '';
            const options = trips.map(t => `<option value="${escape(t.id)}" ${t.id === this.activeId ? 'selected' : ''}>${escape(t.destination)} · ${escape(label(t.startDate, { month: 'short', day: 'numeric' }))} – ${escape(label(t.endDate, { month: 'short', day: 'numeric', year: 'numeric' }))}</option>`).join('');
            this.root.innerHTML = `
                <header class="arrive-planner-heading"><div><p class="arrive-planner-kicker">YOUR TRIP, ONE DAY AT A TIME</p><h3>Your itinerary</h3><p>Save listings, choose a day, and make room for the things you want to do.</p></div><span class="arrive-planner-save" role="status">${escape(this.store.status())}</span></header>
                <div class="arrive-planner-toolbar"><label for="arrive-planner-trip">Itinerary<select id="arrive-planner-trip" ${!trips.length && !saved.length ? 'disabled' : ''}>${!trips.length ? '<option value="">Choose an itinerary</option>' : options}${saved.length ? `<optgroup label="Existing trips">${saved.map(t => `<option value="saved:${escape(t.id)}">${escape(t.destination)} · ${escape(t.startDate)}</option>`).join('')}</optgroup>` : ''}</select></label><button type="button" data-planner-action="new">Set up another trip</button>${trip ? '<button type="button" data-planner-action="update">Use dates from form</button>' : ''}</div>
                ${this.notice ? `<div class="arrive-planner-notice" role="status">${escape(this.notice)} ${this.undo ? '<button type="button" data-planner-action="undo">Undo</button>' : ''}</div>` : ''}
                ${trip ? this.renderTrip(trip) : '<div class="arrive-planner-empty"><i class="fas fa-calendar-days" aria-hidden="true"></i><h4>Your next trip starts here</h4><p>Enter your destination and travel dates above, then choose “Create itinerary”. You can also start from an existing trip.</p></div>'}
                <p class="arrive-planner-footnote">Times are local to your destination. Cost estimates are optional. Saving a listing adds it to your plan; reservations are confirmed with the provider.</p>`;
            const strip = this.root.querySelector('.arrive-trip-days');
            const selectedButton = strip?.querySelector('button.active');
            if (strip?.clientWidth && selectedButton) strip.scrollLeft += selectedButton.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - selectedButton.offsetWidth) / 2;
            if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
        }
        dayButton(trip, date, compact = false) {
            const count = trip.items.filter(i => !i.deleted && i.date === date).length;
            const active = this.selected === date;
            const accessible = `${label(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, ${count} ${count === 1 ? 'activity' : 'activities'}`;
            return `<button type="button" data-planner-action="day" data-day="${date}" class="${active ? 'active' : ''}" aria-pressed="${active}" aria-label="${escape(accessible)}">${compact ? `<span>${escape(label(date, { weekday: 'short' }))}</span>` : ''}<strong>${Number(date.slice(8))}</strong><span class="arrive-day-count">${count ? `${count}<span class="sr-only"> activities</span>` : '·'}</span></button>`;
        }
        calendar(trip) {
            const first = `${this.month}-01`, n = dateNumber(first);
            const offset = (new Date(n).getUTCDay() + 6) % 7;
            const monthNumber = Number(this.month.slice(5)), year = Number(this.month.slice(0, 4));
            const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
            const adjacent = delta => new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7);
            const range = new Set(dates(trip.startDate, trip.endDate));
            let cells = '<span aria-hidden="true"></span>'.repeat(offset);
            for (let d = 1; d <= days; d++) {
                const date = `${this.month}-${String(d).padStart(2, '0')}`;
                cells += range.has(date) ? this.dayButton(trip, date) : `<span class="arrive-calendar-outside" aria-hidden="true">${d}</span>`;
            }
            return `<aside class="arrive-mini-calendar" aria-label="Trip calendar"><div class="arrive-month-heading"><button type="button" data-planner-action="month" data-month="${adjacent(-1)}" ${this.month <= trip.startDate.slice(0, 7) ? 'disabled' : ''} aria-label="Previous month">‹</button><h4 id="arrive-month-title" tabindex="-1">${escape(label(first, { month: 'long', year: 'numeric' }))}</h4><button type="button" data-planner-action="month" data-month="${adjacent(1)}" ${this.month >= trip.endDate.slice(0, 7) ? 'disabled' : ''} aria-label="Next month">›</button></div><div class="arrive-calendar-week" aria-hidden="true">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span>${d}</span>`).join('')}</div><div class="arrive-calendar-days">${cells}</div><p>Highlighted dates are part of your trip.</p></aside>`;
        }
        renderTrip(trip) {
            const live = trip.items.filter(i => !i.deleted);
            const unscheduled = this.selected === 'unscheduled';
            const items = live.filter(i => unscheduled ? !i.date : i.date === this.selected).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
            const costs = Object.entries(totals(items)).map(([currency, value]) => money(value, currency));
            const title = unscheduled ? 'Unscheduled' : label(this.selected, { weekday: 'long', month: 'long', day: 'numeric' });
            const group = (key, name) => `<section class="arrive-day-period"><h5>${name}</h5>${items.filter(i => i.period === key).map(i => this.item(i)).join('') || '<p class="arrive-period-empty">Room for a plan.</p>'}</section>`;
            return `<div class="arrive-trip-days" aria-label="Trip days">${dates(trip.startDate, trip.endDate).map(d => this.dayButton(trip, d, true)).join('')}</div><div class="arrive-planner-layout">${this.calendar(trip)}<div class="arrive-day-agenda"><div class="arrive-agenda-toolbar"><button type="button" class="${unscheduled ? 'active' : ''}" data-planner-action="day" data-day="unscheduled" aria-pressed="${unscheduled}">Unscheduled <span>${live.filter(i => !i.date).length}</span></button><button type="button" class="arrive-planner-primary" data-planner-action="add">+ Add activity</button></div><header class="arrive-agenda-heading"><p>${escape(trip.destination)}</p><h4 id="arrive-plan-day-title" tabindex="-1">${escape(title)}</h4><span>${items.length} ${items.length === 1 ? 'activity' : 'activities'} · ${costs.length ? `Estimated ${escape(costs.join(' · '))}` : 'No cost estimates added'}</span></header>${unscheduled ? (items.map(i => this.item(i)).join('') || '<div class="arrive-agenda-empty">Save listings here and choose a day later.</div>') : `${group('morning', 'Morning')}${group('afternoon', 'Afternoon')}${group('evening', 'Evening')}`}</div></div>`;
        }
        item(item) {
            return `<article class="arrive-agenda-item"><div class="arrive-item-clock">${escape(item.time || 'Flexible')}<span>Planned</span></div><div class="arrive-item-copy"><h6>${escape(item.title)}</h6>${item.notes ? `<p>${escape(item.notes)}</p>` : ''}${item.cost !== null ? `<span class="arrive-item-cost">Estimated ${escape(money(item.cost, item.currency))}</span>` : ''}<div class="arrive-item-actions">${item.source ? `<button type="button" data-planner-action="view" data-id="${escape(item.id)}">View listing</button>` : ''}<button type="button" data-planner-action="edit" data-id="${escape(item.id)}">Edit / move</button><button type="button" data-planner-action="remove" data-id="${escape(item.id)}" aria-label="Remove ${escape(item.title)}">Remove</button></div></div></article>`;
        }
        async addListing(preview) {
            if (!await this.available() || preview?.kind === 'profile') return;
            let trip = this.trip();
            if (!trip || (this.inputs().destination && this.inputs().destination.toLowerCase() !== trip.destination.toLowerCase())) trip = await this.create();
            if (!trip) return;
            const record = preview.service || preview.listing || preview.vehicle || preview.post || preview.job;
            if (!record) return;
            this.edit({ title: text(record.title || record.name || record.company || 'Saved listing'), source: record.id != null ? { kind: preview.kind, id: String(record.id) } : null });
        }
        edit(item = {}) {
            const trip = this.trip(); if (!trip) return;
            if (!this.dialog) {
                this.dialog = document.createElement('dialog'); this.dialog.className = 'arrive-item-dialog'; this.dialog.setAttribute('aria-labelledby', 'arrive-item-title'); document.body.appendChild(this.dialog);
                this.dialog.addEventListener('click', e => { if (e.target.closest('[data-arrive-cancel]')) this.dialog.close(); });
                this.dialog.addEventListener('submit', e => this.saveEditor(e));
                this.closeOnRoute = () => this.dialog.close();
                window.addEventListener('hashchange', this.closeOnRoute);
            }
            this.editing = { owner: this.store.owner, tripId: trip.id, itemId: item.id || '', source: item.source || null };
            const selected = item.id ? item.date : (this.selected === 'unscheduled' ? '' : this.selected);
            this.dialog.innerHTML = `<form><header><div><p class="arrive-planner-kicker">YOUR ITINERARY</p><h3 id="arrive-item-title">${item.id ? 'Edit activity' : 'Add to itinerary'}</h3></div><button type="button" data-arrive-cancel aria-label="Close activity editor">×</button></header><label>Activity<input name="title" value="${escape(item.title || '')}" maxlength="300" required autocomplete="off"></label><label>Day<select name="date"><option value="" ${!selected ? 'selected' : ''}>Unscheduled — decide later</option>${dates(trip.startDate, trip.endDate).map(d => `<option value="${d}" ${d === selected ? 'selected' : ''}>${escape(label(d, { weekday: 'short', month: 'short', day: 'numeric' }))}</option>`).join('')}</select></label><div class="arrive-editor-row"><label>Time (optional)<input name="time" type="time" value="${escape(item.time || '')}"></label><label>Part of day<select name="period">${['morning', 'afternoon', 'evening'].map(v => `<option value="${v}" ${v === (item.period || 'morning') ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label></div><div class="arrive-editor-row"><label>Estimated cost (optional)<input name="cost" type="text" inputmode="decimal" placeholder="e.g. 25.00" value="${item.cost != null ? (item.cost / 100).toFixed(2) : ''}"></label><label>Currency<input name="currency" value="${escape(item.currency || trip.items.find(i => !i.deleted && i.cost !== null)?.currency || 'USD')}" maxlength="3" pattern="[A-Za-z]{3}" list="arrive-currencies" required><datalist id="arrive-currencies">${['USD', 'CAD', 'EUR', 'GBP', 'GHS', 'KES', 'AED', 'JMD', 'GYD', 'AUD', 'ZAR'].map(v => `<option value="${v}">`).join('')}</datalist></label></div><label>Notes (optional)<textarea name="notes" rows="3" maxlength="2000">${escape(item.notes || '')}</textarea></label><p class="arrive-editor-help">Times are local to your destination. A time sets the activity’s part of day. Unscheduled items keep their title, notes and cost estimate.</p><p class="arrive-editor-error" role="alert"></p><footer><button type="button" data-arrive-cancel>Cancel</button><button type="submit" class="arrive-planner-primary">Save activity</button></footer></form>`;
            this.dialog.showModal();
        }
        async saveEditor(event) {
            event.preventDefault();
            const form = event.target;
            const editing = this.editing;
            if (!editing) return;
            if (!await this.available() || editing.owner !== this.store.owner) { this.dialog.close(); return; }
            if (this.editing !== editing) return;
            const trip = this.store.state.trips.find(t => t.id === this.editing.tripId && !t.deleted); if (!trip) return;
            const value = name => form.elements.namedItem(name).value;
            const cost = cents(value('cost'));
            if (!Number.isFinite(cost) && cost !== null) { form.querySelector('[role="alert"]').textContent = 'Enter a non-negative estimate with up to two decimal places.'; return; }
            if (value('date') && !dates(trip.startDate, trip.endDate).includes(value('date'))) { form.querySelector('[role="alert"]').textContent = 'Choose a day within this trip.'; return; }
            if (!this.editing.itemId && trip.items.length >= 2000) { form.querySelector('[role="alert"]').textContent = 'This itinerary has reached its activity limit.'; return; }
            const item = normalizeItem({ id: this.editing.itemId || uid(), title: value('title'), date: value('date'), time: value('time'), period: value('period'), cost, currency: value('currency').toUpperCase(), notes: value('notes'), source: this.editing.source, updatedAt: Date.now() }, trip);
            if (!item) return;
            const existing = trip.items.findIndex(i => i.id === item.id);
            if (existing >= 0) trip.items[existing] = item; else trip.items.push(item);
            this.selected = item.date || 'unscheduled'; if (item.date) this.month = item.date.slice(0, 7);
            this.notice = 'Activity saved to your itinerary.'; this.undo = null; this.editing = null;
            this.store.save(this.store.state); this.dialog.close(); this.render();
            this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        openSource(item) {
            const source = item?.source; if (!source) return;
            const collections = { restaurant: 'serviceProfiles', business: 'serviceProfiles', short_stay: 'realestateListings', car_rental: 'vehicleListings', event: 'communityPosts', job: 'marketplaceItems', marketplace: 'marketplaceItems' };
            const record = (this.app[collections[source.kind]] || []).find(i => String(i.id) === source.id);
            if (!record) { this.notify('This listing is unavailable. Your itinerary note is still saved.'); return; }
            if (source.kind === 'restaurant' || source.kind === 'business') this.app.openServiceModal(record);
            else if (source.kind === 'short_stay') this.app.openRealestateModal(record);
            else if (source.kind === 'car_rental') this.app.openVehicleModal(record);
            else if (source.kind === 'event') this.app.openCommunityPostMarketplaceModal(record.id);
            else this.app.openMarketplaceItemModal(record);
        }
    }

    let planner;
    window.SIXO_ARRIVE_PLANNER = {
        mount(app) {
            const root = document.getElementById('arrive-day-planner'); if (!root) return null;
            if (!planner || planner.app !== app || !planner.store.current()) {
                if (planner) {
                    planner.store.retire();
                    if (planner.closeOnRoute) window.removeEventListener('hashchange', planner.closeOnRoute);
                    if (planner.dialog) { planner.dialog.close(); planner.dialog.replaceChildren(); planner.dialog.remove(); }
                    for (const suffix of ['destination', 'start', 'end', 'wants', 'notes']) {
                        const input = document.getElementById(`dating-schedule-${suffix}`); if (input) input.value = '';
                    }
                    document.getElementById('dating-schedule-end')?.removeAttribute('min');
                    const preview = document.getElementById('arrive-plus-preview-list'); if (preview) preview.replaceChildren();
                    const subtitle = document.getElementById('arrive-plus-preview-subtitle'); if (subtitle) subtitle.textContent = 'Enter a destination to explore listings for your trip.';
                    const summary = document.getElementById('arrive-plus-preview-summary'); if (summary) summary.textContent = '';
                }
                // Replace the root to retire listeners belonging to a previous account.
                if (planner) root.replaceWith(root.cloneNode(false));
                planner = new Planner(app);
            } else planner.render();
            return planner;
        },
        refreshIdentity(app) { if (planner && planner.app === app && !planner.store.current()) this.mount(app); },
        refresh(app) { if (planner && planner.app === app && planner.store.current() && app.activeScreen === 'arrive') planner.render(); },
        addListing(app, item) { return this.mount(app)?.addListing(item); },
        model: Object.freeze({ dates, dateNumber, cents, money, normalize, normalizeItem, merge, resizeTrip, totals, requestTimeout, PlanStore })
    };
    window.addEventListener('storage', event => {
        if (!planner || !planner.store.current() || event.key !== planner.store.key || !event.newValue) return;
        try { planner.store.state = merge(planner.store.state, JSON.parse(event.newValue)); planner.render(); } catch {}
    });
})(window, document);
