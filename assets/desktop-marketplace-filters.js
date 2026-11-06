/* Coordinate desktop and mobile layouts around the same native search controls. */
(function () {
    'use strict';
    function setup() {
        const panel = document.querySelector('#marketplace-content .marketplace-filters');
        if (!panel || panel.dataset.desktopFiltersBound) return;
        const media = window.matchMedia('(min-width: 1024px)');
        const queryBar = panel.querySelector('.filter-search-bar');
        const input = document.getElementById('market-search');
        const searchButton = document.getElementById('market-search-btn');
        const applyButton = document.getElementById('market-apply-filters');
        const categoryItem = document.getElementById('category-filter')?.closest('.filter-item');
        const locationItem = panel.querySelector('.market-location-filter-item');
        const advanced = document.getElementById('market-advanced-filters');
        const advancedToggle = document.getElementById('market-advanced-toggle');
        const quick = key => panel.querySelector(`.market-smart-filter[data-quick-filter="${key}"]`);
        if (![queryBar, input, searchButton, applyButton, categoryItem, locationItem, advanced, advancedToggle, quick('price'), quick('posted_today'), quick('verified_seller'), quick('open_now')].every(Boolean)) return;
        panel.dataset.desktopFiltersBound = '1';
        const mobile = window.createMarketplaceMobileFilters?.(panel);
        let shell, toolbar, filterRow, locationPanel, locationToggle, locationValue, searchLabel, searchIcon;
        let enabled = false, originalPlaceholder = '', originalSearchRole = null;
        const positions = new Map();
        const observer = new MutationObserver(syncLocation);

        function move(node, destination) {
            if (!positions.has(node)) {
                const anchor = document.createComment('desktop filter position');
                node.before(anchor);
                positions.set(node, anchor);
            }
            destination.append(node);
        }

        function syncLocation() {
            if (!enabled) return;
            const country = String(document.getElementById('country-filter')?.value || '').trim();
            const city = String(document.getElementById('city-filter')?.value || '').trim();
            const text = [city, country].filter(Boolean).join(', ') || 'Worldwide';
            if (locationValue.textContent !== text) {
                locationValue.textContent = text;
                locationToggle.title = text;
            }
        }

        function setLocationOpen(open, focus = false) {
            if (!locationPanel) return;
            locationPanel.hidden = !open;
            locationToggle.setAttribute('aria-expanded', String(open));
            if (focus) locationToggle.focus();
        }

        function createShell() {
            shell = document.createElement('div');
            shell.className = 'market-desktop-shell';
            shell.innerHTML = '<div class="market-desktop-toolbar" role="search" aria-label="Marketplace search and filters"><div class="market-desktop-location-field"><button type="button" id="market-desktop-location-toggle" aria-expanded="false" aria-controls="market-desktop-location-panel" aria-labelledby="market-desktop-location-label market-desktop-location-value"><span class="market-desktop-label" id="market-desktop-location-label">Location</span><span class="market-desktop-location-line"><i class="fas fa-map-marker-alt" aria-hidden="true"></i><span id="market-desktop-location-value">Worldwide</span><i class="fas fa-chevron-down" aria-hidden="true"></i></span></button></div></div><div class="market-desktop-filter-row" role="group" aria-label="Listing filters"></div><div class="market-desktop-location-panel" id="market-desktop-location-panel" role="region" aria-label="Choose location" hidden></div>';
            panel.querySelector('.filter-panel-header').after(shell);
            toolbar = shell.querySelector('.market-desktop-toolbar');
            filterRow = shell.querySelector('.market-desktop-filter-row');
            locationPanel = shell.querySelector('.market-desktop-location-panel');
            locationToggle = shell.querySelector('#market-desktop-location-toggle');
            locationValue = shell.querySelector('#market-desktop-location-value');
            searchLabel = document.createElement('label');
            searchLabel.htmlFor = 'market-search';
            searchLabel.className = 'market-desktop-label';
            searchLabel.textContent = 'What are you looking for?';
            searchIcon = document.createElement('i');
            searchIcon.className = 'fas fa-search market-desktop-search-icon';
            searchIcon.setAttribute('aria-hidden', 'true');
            locationToggle.addEventListener('click', () => setLocationOpen(locationPanel.hidden));
        }

        function updateLayout() {
            if (media.matches === enabled) {
                if (!enabled) mobile?.enable();
                return;
            }
            if (media.matches) {
                mobile?.disable();
                if (!shell) createShell();
                enabled = true;
                originalPlaceholder = input.getAttribute('placeholder');
                originalSearchRole = queryBar.getAttribute('role');
                queryBar.removeAttribute('role');
                input.placeholder = 'Search listings…';
                shell.hidden = false;
                move(queryBar, toolbar);
                toolbar.prepend(queryBar);
                move(searchButton, toolbar);
                move(categoryItem, toolbar);
                toolbar.append(searchButton);
                move(locationItem, locationPanel);
                for (const key of ['price', 'posted_today', 'verified_seller']) move(quick(key), filterRow);
                move(advancedToggle, filterRow);
                move(quick('open_now'), advanced);
                queryBar.prepend(searchLabel);
                searchButton.prepend(searchIcon);
                categoryItem.classList.add('market-desktop-category');
                panel.classList.add('market-desktop-ready');
                setLocationOpen(false);
                syncLocation();
                observer.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-busy', 'disabled'] });
            } else {
                observer.disconnect();
                enabled = false;
                setLocationOpen(false);
                for (const [node, anchor] of positions) anchor.after(node);
                searchLabel.remove();
                searchIcon.remove();
                if (originalPlaceholder === null) input.removeAttribute('placeholder');
                else input.setAttribute('placeholder', originalPlaceholder);
                if (originalSearchRole !== null) queryBar.setAttribute('role', originalSearchRole);
                categoryItem.classList.remove('market-desktop-category');
                panel.classList.remove('market-desktop-ready');
                shell.hidden = true;
                document.getElementById('price-filter-max').setCustomValidity('');
                mobile?.enable();
            }
        }

        function submit(event) {
            if (!enabled || applyButton.dataset.boundMarketplaceApply !== '1') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const min = document.getElementById('price-filter-min');
            const max = document.getElementById('price-filter-max');
            max.setCustomValidity('');
            if (min.value !== '' && max.value !== '' && Number(min.value) > Number(max.value)) {
                max.setCustomValidity('Maximum price must be at least the minimum.');
            }
            const invalid = [min, max].find(field => !field.checkValidity());
            if (invalid) {
                window.app?.setMarketplaceAdvancedFiltersExpanded(true);
                invalid.reportValidity();
                return;
            }
            window.app?.cancelPendingSearch(input);
            applyButton.click();
            setLocationOpen(false);
            syncLocation();
        }

        panel.addEventListener('click', event => {
            if (event.target.closest('#market-search-btn')) submit(event);
            else if (enabled && event.target.closest('#market-advanced-toggle, [data-quick-filter="price"]')) setLocationOpen(false);
        }, true);
        panel.addEventListener('keydown', event => {
            if (!enabled || event.isComposing || event.keyCode === 229) return;
            if (event.target === input && event.key === 'Enter') submit(event);
            else if (event.key === 'Escape' && !locationPanel.hidden) {
                // Let the shared city/country picker cancel its draft first.
                if (event.target.matches('.location-search-input[aria-expanded="true"]')) return;
                event.preventDefault();
                setLocationOpen(false, true);
            }
        }, true);
        panel.addEventListener('input', event => {
            if (!enabled) return;
            if (event.target.id === 'price-filter-min' || event.target.id === 'price-filter-max') document.getElementById('price-filter-max').setCustomValidity('');
            syncLocation();
        });
        panel.addEventListener('change', syncLocation);
        document.addEventListener('pointerdown', event => {
            if (enabled && !locationPanel.hidden && !locationPanel.contains(event.target) && !locationToggle.contains(event.target) && !event.target.closest('#screen-location-suggestions, #market-search-btn')) setLocationOpen(false);
        });
        media.addEventListener('change', updateLayout);
        updateLayout();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
    else setup();
})();
