(function () {
    'use strict';

    const searchesKey = 'sixo_saved_searches_v1';
    const matchKey = entry => String(entry.raw?.sourceRowId || entry.raw?.publicId || `${entry.type}:${entry.id}`);

    function readSearches() {
        try {
            const searches = JSON.parse(localStorage.getItem(searchesKey) || '[]');
            return Array.isArray(searches) ? searches.filter(search => search?.criteria && Array.isArray(search.seen)) : [];
        } catch {
            return [];
        }
    }

    class SavedHub {
        constructor(app) {
            this.app = app;
            this.dialog = document.getElementById('saved-hub');
            this.list = document.getElementById('saved-hub-list');
            this.action = document.getElementById('home-save-search');
            this.nav = document.getElementById('nav-saved');
            this.status = document.getElementById('saved-hub-status');
            this.nav.addEventListener('click', () => this.open('listings'));
            this.action.addEventListener('click', () => void this.saveSearch());
            this.dialog.addEventListener('click', event => this.handleClick(event));
            document.getElementById('notification-list').addEventListener('click', event => {
                if (!event.target.closest('[data-open-saved-searches]')) return;
                document.getElementById('notification-center').classList.add('hidden');
                this.open('searches');
            });
            window.addEventListener('storage', event => {
                if (['hs_marketplace_saved', 'vehicleFavorites'].includes(event.key)) {
                    this.app.marketplaceSaved = this.app.loadMarketplaceSaved();
                    this.app.loadVehicleState();
                    this.updateCount();
                }
                if (event.key === searchesKey) {
                    this.updateSearchAction(this.app.homeSearchCriteria);
                    if (this.dialog.open && this.view === 'searches') this.render();
                }
            });
        }

        saveSearches(searches) {
            try {
                localStorage.setItem(searchesKey, JSON.stringify(searches));
                return true;
            } catch {
                this.app.showNotification('Your browser could not save this search.', { type: 'warn', force: true });
                return false;
            }
        }

        updateCount() {
            const count = new Set([
                ...Array.from(this.app.marketplaceSaved || [], String),
                ...Array.from(this.app.vehicleFavorites || [], String)
            ]).size;
            this.nav.setAttribute('aria-label', count ? `Saved, ${count} listings` : 'Saved');
            if (this.dialog.open && this.view === 'listings') this.render();
        }

        criteriaKey(criteria) {
            return JSON.stringify([
                criteria.query, criteria.rawCategory, criteria.otherSubcategory, criteria.effectiveLocationScope,
                criteria.minPrice ?? null, criteria.maxPrice ?? null, criteria.dateFilter,
                criteria.openNowActive, Boolean(criteria.quickFilters.verifiedSeller),
                criteria.categoryFilters, criteria.interpreted.intentFlags
            ]);
        }

        updateSearchAction(criteria) {
            this.action.hidden = !criteria || criteria.nearMeActive || criteria.effectiveLocationScope?.pending
                || !(criteria.query || criteria.rawCategory || criteria.effectiveLocationScope?.active
                    || Number.isFinite(criteria.minPrice) || Number.isFinite(criteria.maxPrice)
                    || criteria.openNowActive || criteria.quickFilters.verifiedSeller
                    || (criteria.dateFilter && criteria.dateFilter !== 'all'));
            if (this.action.hidden) return;
            const saved = readSearches().some(search => search.key === this.criteriaKey(criteria));
            this.action.textContent = saved ? 'Search saved' : 'Save search';
        }

        async getMatches(criteria) {
            const { filtered } = await this.app.getHomeMatchingListings(criteria);
            return filtered.filter(entry => !entry.searchRelated && !entry.raw?.sold && entry.type !== 'live_place');
        }

        async saveSearch() {
            const criteria = this.app.homeSearchCriteria;
            if (!criteria || this.action.hidden || this.action.disabled) return;
            const key = this.criteriaKey(criteria);
            if (readSearches().some(search => search.key === key)) {
                this.open('searches');
                return;
            }
            this.action.disabled = true;
            try {
                await this.app.listingInventoryRequest;
                const snapshot = JSON.parse(JSON.stringify(criteria));
                const matches = await this.getMatches(snapshot);
                const searches = readSearches();
                if (searches.length >= 12) {
                    this.app.showNotification('Remove a saved search to make room for another.', { type: 'warn', force: true });
                    this.open('searches');
                    return;
                }
                if (searches.some(search => search.key === key)) return;
                searches.unshift({
                    id: crypto.randomUUID(), key, criteria: snapshot, paused: false,
                    seen: Array.from(new Set(matches.map(matchKey)))
                });
                if (this.saveSearches(searches)) {
                    this.updateSearchAction(this.app.homeSearchCriteria);
                    this.open('searches');
                }
            } catch (error) {
                console.warn('Could not save search:', error);
                this.app.showNotification('Could not save your search. Try again.', { type: 'warn', force: true });
            } finally {
                this.action.disabled = false;
            }
        }

        async checkAlerts() {
            for (const search of readSearches()) {
                if (search.paused) continue;
                try {
                    const matches = await this.getMatches(search.criteria);
                    const searches = readSearches();
                    const current = searches.find(item => item.id === search.id);
                    if (!current || current.paused) continue;
                    const known = new Set(current.seen);
                    const fresh = new Set(matches.map(matchKey).filter(key => !known.has(key)));
                    if (!fresh.size) continue;
                    current.seen = [...known, ...fresh];
                    if (!this.saveSearches(searches)) continue;
                    this.app.addNotification({
                        type: 'saved_search',
                        title: fresh.size === 1 ? '1 new match for your saved search' : `${fresh.size} new matches for your saved search`,
                        message: this.describe(current.criteria)
                    });
                } catch (error) {
                    console.warn('Saved search could not be checked:', error);
                }
            }
        }

        describe(criteria) {
            const scope = criteria.effectiveLocationScope;
            const area = [scope?.city, scope?.region, scope?.country].filter(Boolean).join(', ') || scope?.text || 'Worldwide';
            const category = criteria.rawCategory ? this.app.getHomeResultSectionLabel(criteria.rawCategory) : '';
            const min = criteria.minPrice;
            const max = criteria.maxPrice;
            const price = Number.isFinite(min) && Number.isFinite(max) ? `Price ${min}–${max}`
                : Number.isFinite(min) ? `Price from ${min}` : Number.isFinite(max) ? `Price up to ${max}` : '';
            return [criteria.rawQuery || category || 'Listings', criteria.rawQuery && category, area, price]
                .filter(Boolean).join(' · ');
        }

        getSavedListings() {
            const items = new Map();
            const saved = new Set(Array.from(this.app.marketplaceSaved || [], String));
            const vehicles = new Set(Array.from(this.app.vehicleFavorites || [], String));
            for (const [type, listings] of [
                ['vehicle', this.app.vehicleListings], ['realestate', this.app.realestateListings],
                ['marketplace', this.app.marketplaceItems], ['service', this.app.serviceProfiles],
                ['discovery', this.app.discoveryPosts], ['community', this.app.communityPosts]
            ]) {
                for (const item of listings || []) {
                    for (const key of new Set([item.id, item.publicId, item.sourceRowId].filter(value => value != null && value !== '').map(String))) {
                        if (items.has(key) || (!saved.has(key) && !(type === 'vehicle' && vehicles.has(key)))) continue;
                        items.set(key, { type, id: item.id, title: item.title || item.listing?.title, item });
                    }
                }
            }
            const featuredCards = saved.size ? document.querySelectorAll('.featured-ad-card, .luxury-ad-card') : [];
            for (const card of featuredCards) {
                const data = this.app.getLuxuryAdDataFromCard(card);
                const key = String(this.app.getNativeSponsoredSaveKey(data));
                if (saved.has(key) && !items.has(key)) items.set(key, { type: 'sponsored', data, title: data.title, item: data });
            }
            this.savedEntries = items;
            return [...new Set([...saved, ...vehicles])].reverse();
        }

        open(view) {
            this.view = view;
            this.render();
            if (!this.dialog.open) this.dialog.showModal();
            this.app.listingInventoryRequest?.then(() => {
                if (this.dialog.open && this.view === 'listings') this.render();
            });
        }

        render() {
            const escape = value => this.app.escapeHtml(String(value ?? ''));
            this.dialog.querySelectorAll('[data-saved-view]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.savedView === this.view));
            });
            this.status.textContent = '';
            if (this.view === 'searches') {
                const searches = readSearches();
                this.status.textContent = 'New matches appear in the notification bell when you visit 6ixo on this browser.';
                this.list.innerHTML = searches.map(search => `
                    <li><strong>${escape(this.describe(search.criteria))}</strong>
                        <span>${search.paused ? 'Alerts paused' : 'Alerts on'}</span>
                        <div class="saved-hub-actions">
                            <button type="button" data-saved-matches="${escape(search.id)}">View matches</button>
                            <button type="button" data-saved-pause="${escape(search.id)}">${search.paused ? 'Resume alerts' : 'Pause alerts'}</button>
                            <button type="button" data-saved-delete="${escape(search.id)}">Remove</button>
                        </div>
                    </li>`).join('') || '<li>Run a search on Home and select Save search to get alerts.</li>';
                return;
            }
            const keys = this.getSavedListings();
            this.list.innerHTML = keys.map(key => {
                const entry = this.savedEntries.get(key);
                const title = entry?.title || (this.app.listingInventoryRequest ? 'Loading saved listing…' : 'Listing unavailable');
                const price = entry ? this.app.formatListingPriceText(entry.item.priceText || entry.item.priceLabel || entry.item.price, entry.item) : '';
                return `<li>
                    ${entry ? `<button class="saved-hub-listing" type="button" data-saved-open="${escape(key)}">${escape(title)}</button>` : `<strong>${escape(title)}</strong>`}
                    ${price ? `<span>${escape(price)}</span>` : ''}
                    <div class="saved-hub-actions"><button type="button" data-saved-remove="${escape(key)}">Remove</button></div>
                </li>`;
            }).join('') || '<li>Tap the heart or Save on a listing to find it here later.</li>';
        }

        async showMatches(id) {
            const search = readSearches().find(item => item.id === id);
            if (!search) return;
            this.view = 'matches';
            this.status.textContent = 'Finding matching listings…';
            this.list.replaceChildren();
            await this.app.listingInventoryRequest;
            if (!this.dialog.open || this.view !== 'matches') return;
            try {
                const matches = await this.getMatches(search.criteria);
                if (!this.dialog.open || this.view !== 'matches') return;
                this.matches = matches;
                this.status.textContent = `${this.describe(search.criteria)} · ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`;
                this.renderMatches(30);
            } catch {
                this.status.textContent = 'Could not load matches. Try again from Searches & alerts.';
            }
        }

        renderMatches(limit) {
            this.list.replaceChildren();
            this.matches.slice(0, limit).forEach((entry, index) => {
                const row = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'saved-hub-listing';
                button.dataset.savedMatchIndex = String(index);
                button.textContent = entry.title || 'Listing';
                const detail = document.createElement('span');
                detail.textContent = [this.app.formatListingPriceText(entry.priceText, entry.raw), entry.locationLabel].filter(Boolean).join(' · ');
                row.append(button, detail);
                this.list.append(row);
            });
            if (this.matches.length > limit) {
                const row = document.createElement('li');
                const more = document.createElement('button');
                more.type = 'button';
                more.textContent = 'Show more matches';
                more.dataset.savedMore = String(limit + 30);
                row.append(more);
                this.list.append(row);
            }
        }

        handleClick(event) {
            const button = event.target.closest('button');
            if (!button) return;
            const data = button.dataset;
            if (data.savedView) this.open(data.savedView);
            if (data.savedMatches) void this.showMatches(data.savedMatches);
            if (data.savedMore) this.renderMatches(Number(data.savedMore));
            if (data.savedMatchIndex != null) {
                const { type, id } = this.matches[Number(data.savedMatchIndex)];
                this.dialog.close();
                this.app.openHomeListing(type, id);
            }
            if (data.savedOpen) {
                const entry = this.savedEntries.get(data.savedOpen);
                if (!entry) return;
                this.dialog.close();
                if (entry.type === 'sponsored') this.app.openLuxuryAdModal(entry.data);
                else this.app.openHomeListing(entry.type, entry.id);
            }
            if (data.savedRemove) {
                if (this.app.isMarketplaceSaved(data.savedRemove)) this.app.toggleMarketplaceSaved(data.savedRemove);
                for (const id of this.app.vehicleFavorites || []) {
                    if (String(id) === data.savedRemove) this.app.toggleVehicleFavorite(id);
                }
                this.updateCount();
                this.dialog.querySelector('[data-saved-view="listings"]').focus();
            }
            if (data.savedPause || data.savedDelete) {
                const searches = readSearches();
                const search = searches.find(item => item.id === (data.savedPause || data.savedDelete));
                if (!search) return;
                if (data.savedPause) search.paused = !search.paused;
                if (!this.saveSearches(data.savedDelete ? searches.filter(item => item !== search) : searches)) return;
                this.updateSearchAction(this.app.homeSearchCriteria);
                this.render();
                this.dialog.querySelector('[data-saved-view="searches"]').focus();
                if (!search.paused && data.savedPause) void this.checkAlerts();
            }
        }
    }

    window.SixoSavedHub = { attach: app => new SavedHub(app) };
})();
