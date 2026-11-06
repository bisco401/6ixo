/* The desktop controller owns breakpoint changes so shared controls move only once. */
(function () {
    'use strict';
    window.createMarketplaceMobileFilters = function (panel) {
        const input = panel.querySelector('#market-search');
        const category = panel.querySelector('#category-filter');
        const categoryItem = category.closest('.filter-item');
        const locationItem = panel.querySelector('.market-location-filter-item');
        const apply = panel.querySelector('#market-apply-filters');
        const min = panel.querySelector('#price-filter-min');
        const max = panel.querySelector('#price-filter-max');
        const quickFilters = [
            ['postedToday', 'Posted today'],
            ['verifiedSeller', 'Verified seller'],
            ['openNow', 'Open now']
        ];
        let enabled = false, shell, locationPanel, locationToggle, locationValue, filtersButton, chips, dialog;
        let draftMin, draftMax, error, originalPlaceholder, previousChips = '', backdropStart = false;
        const anchors = new Map();
        const observer = new MutationObserver(sync);

        function move(node, target) {
            const anchor = document.createComment('mobile filter position');
            node.before(anchor);
            anchors.set(node, anchor);
            target.append(node);
        }

        function setLocationOpen(open, focus = false) {
            locationPanel.hidden = !open;
            locationToggle.setAttribute('aria-expanded', String(open));
            if (focus) locationToggle.focus();
        }

        function create() {
            filtersButton = document.createElement('button');
            filtersButton.id = 'market-mobile-filters-toggle';
            filtersButton.type = 'button';
            filtersButton.setAttribute('aria-haspopup', 'dialog');
            filtersButton.setAttribute('aria-controls', 'market-mobile-filter-sheet');
            filtersButton.innerHTML = '<i class="fas fa-sliders-h" aria-hidden="true"></i><span>Filters</span>';
            panel.querySelector('.filter-panel-header').append(filtersButton);
            shell = document.createElement('div');
            shell.className = 'market-mobile-shell';
            shell.innerHTML = '<div class="market-mobile-fields"><button type="button" id="market-mobile-location-toggle" aria-expanded="false" aria-controls="market-mobile-location-panel"><span class="market-mobile-label">Location</span><span class="market-mobile-location-line"><i class="fas fa-map-marker-alt" aria-hidden="true"></i><span id="market-mobile-location-value">Worldwide</span><i class="fas fa-chevron-down" aria-hidden="true"></i></span></button></div><div class="market-mobile-location-panel" id="market-mobile-location-panel" role="region" aria-label="Choose location" hidden><button type="button" class="market-mobile-location-done">Apply location</button></div><div class="market-mobile-active-filters" role="group" aria-label="Applied filters" hidden></div>';
            panel.querySelector('.filter-search-bar').after(shell);
            locationPanel = shell.querySelector('.market-mobile-location-panel');
            locationToggle = shell.querySelector('#market-mobile-location-toggle');
            locationValue = shell.querySelector('#market-mobile-location-value');
            chips = shell.querySelector('.market-mobile-active-filters');
            dialog = document.createElement('dialog');
            dialog.id = 'market-mobile-filter-sheet';
            dialog.setAttribute('aria-labelledby', 'market-mobile-filter-title');
            dialog.innerHTML = `<div class="market-mobile-sheet-header"><h2 id="market-mobile-filter-title">Filters</h2><button type="button" class="market-mobile-sheet-close" aria-label="Close filters" autofocus><i class="fas fa-times" aria-hidden="true"></i></button></div>
                <form novalidate class="market-mobile-sheet-form">
                    <div class="market-mobile-sheet-body">
                        <fieldset><legend>Price range</legend><div class="market-mobile-price-fields">
                            <label for="market-mobile-price-min">Minimum<input type="number" id="market-mobile-price-min" min="0" inputmode="decimal" placeholder="No minimum"></label>
                            <label for="market-mobile-price-max">Maximum<input type="number" id="market-mobile-price-max" min="0" inputmode="decimal" placeholder="No maximum"></label>
                        </div><p class="market-mobile-filter-error" role="alert" hidden></p></fieldset>
                        <fieldset><legend>Show listings</legend>${quickFilters.map(([key, label]) => `<label class="market-mobile-filter-check"><input type="checkbox" data-mobile-filter="${key}"><span>${label}</span></label>`).join('')}</fieldset>
                    </div>
                    <div class="market-mobile-sheet-footer"><button type="button" class="market-mobile-reset">Reset</button><button type="submit" class="market-mobile-apply">Apply filters</button></div>
                </form>`;
            panel.append(dialog);
            draftMin = dialog.querySelector('#market-mobile-price-min');
            draftMax = dialog.querySelector('#market-mobile-price-max');
            draftMin.step = min.step || '1';
            draftMax.step = max.step || '1';
            error = dialog.querySelector('.market-mobile-filter-error');
            filtersButton.addEventListener('click', openSheet);
            locationToggle.addEventListener('click', () => setLocationOpen(locationPanel.hidden));
            shell.querySelector('.market-mobile-location-done').addEventListener('click', () => setLocationOpen(false, true));
            dialog.querySelector('.market-mobile-sheet-close').addEventListener('click', () => dialog.close());
            dialog.addEventListener('keydown', event => {
                if (event.key !== 'Tab') return;
                const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });
            dialog.addEventListener('close', () => {
                document.documentElement.classList.remove('market-mobile-sheet-open');
                filtersButton.setAttribute('aria-expanded', 'false');
                if (enabled && panel.closest('.content-screen')?.classList.contains('active')) filtersButton.focus();
            });
            dialog.addEventListener('pointerdown', event => { backdropStart = event.target === dialog; });
            dialog.addEventListener('click', event => {
                if (backdropStart && event.target === dialog) dialog.close();
                backdropStart = false;
            });
            dialog.querySelector('form').addEventListener('submit', event => {
                event.preventDefault();
                if (!validateDraft() || !window.app || apply.dataset.boundMarketplaceApply !== '1') return;
                min.value = draftMin.value;
                max.value = draftMax.value;
                max.setCustomValidity('');
                window.app.marketplaceQuickFilters = {
                    ...window.app.marketplaceQuickFilters,
                    ...Object.fromEntries(quickFilters.map(([key]) => [key, dialog.querySelector(`[data-mobile-filter="${key}"]`).checked]))
                };
                window.app.cancelPendingSearch(input);
                apply.click();
                sync();
                dialog.close();
            });
            dialog.querySelector('.market-mobile-reset').addEventListener('click', () => {
                draftMin.value = '';
                draftMax.value = '';
                dialog.querySelectorAll('[data-mobile-filter]').forEach(field => { field.checked = false; });
                clearError();
            });
            dialog.addEventListener('input', clearError);
            chips.addEventListener('click', event => {
                const chip = event.target.closest('[data-remove-filter]');
                if (!chip || !window.app) return;
                const key = chip.dataset.removeFilter;
                if (key === 'price') { min.value = ''; max.value = ''; max.setCustomValidity(''); }
                else window.app.marketplaceQuickFilters = { ...window.app.marketplaceQuickFilters, [key]: false };
                window.app.cancelPendingSearch(input);
                apply.click();
                sync();
                filtersButton.focus();
            });
            window.visualViewport?.addEventListener('resize', fitSheet);
            window.visualViewport?.addEventListener('scroll', fitSheet);
        }

        function fitSheet() {
            if (!dialog?.open) return;
            const viewport = window.visualViewport;
            dialog.style.setProperty('--market-sheet-height', `${Math.max(160, (viewport?.height || window.innerHeight) - 16)}px`);
            dialog.style.setProperty('--market-sheet-bottom', `${Math.max(0, window.innerHeight - (viewport?.height || window.innerHeight) - (viewport?.offsetTop || 0))}px`);
        }

        function clearError() {
            draftMax.setCustomValidity('');
            error.hidden = true;
            for (const field of [draftMin, draftMax]) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
        }

        function validateDraft() {
            clearError();
            if (draftMin.value !== '' && draftMax.value !== '' && Number(draftMin.value) > Number(draftMax.value)) draftMax.setCustomValidity('Maximum price must be at least the minimum.');
            const invalid = [draftMin, draftMax].find(field => !field.checkValidity());
            if (!invalid) return true;
            error.id = 'market-mobile-price-error';
            error.textContent = invalid.validationMessage;
            error.hidden = false;
            invalid.setAttribute('aria-invalid', 'true');
            invalid.setAttribute('aria-describedby', error.id);
            invalid.focus();
            return false;
        }

        function openSheet() {
            if (!enabled || dialog.open) return;
            setLocationOpen(false);
            draftMin.value = min.value;
            draftMax.value = max.value;
            const selected = window.app?.marketplaceQuickFilters || {};
            quickFilters.forEach(([key]) => { dialog.querySelector(`[data-mobile-filter="${key}"]`).checked = Boolean(selected[key]); });
            clearError();
            dialog.showModal();
            filtersButton.setAttribute('aria-expanded', 'true');
            document.documentElement.classList.add('market-mobile-sheet-open');
            fitSheet();
        }

        function sync() {
            if (!enabled) return;
            const country = String(panel.querySelector('#country-filter').value || '').trim();
            const city = String(panel.querySelector('#city-filter').value || '').trim();
            const text = [city, country].filter(Boolean).join(', ') || 'Worldwide';
            if (locationValue.textContent !== text) { locationValue.textContent = text; locationToggle.title = text; }
            const active = [];
            if (min.value || max.value) active.push(['price', min.value && max.value ? `Price: ${min.value}–${max.value}` : min.value ? `Price: ${min.value}+` : `Price: up to ${max.value}`]);
            quickFilters.forEach(([key, label]) => { if (window.app?.marketplaceQuickFilters?.[key]) active.push([key, label]); });
            const signature = JSON.stringify(active);
            if (signature === previousChips) return;
            previousChips = signature;
            chips.replaceChildren(...active.map(([key, label]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.removeFilter = key;
                button.setAttribute('aria-label', `Remove ${label}`);
                button.textContent = label;
                const icon = document.createElement('i');
                icon.className = 'fas fa-times';
                icon.setAttribute('aria-hidden', 'true');
                button.append(icon);
                return button;
            }));
            chips.hidden = !active.length;
            filtersButton.querySelector('span').textContent = active.length ? `Filters (${active.length})` : 'Filters';
        }

        function submitSearch(event) {
            if (!enabled || apply.dataset.boundMarketplaceApply !== '1') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            max.setCustomValidity('');
            if ([min, max].some(field => !field.checkValidity()) || (min.value !== '' && max.value !== '' && Number(min.value) > Number(max.value))) {
                openSheet();
                validateDraft();
                return;
            }
            window.app?.cancelPendingSearch(input);
            apply.click();
            setLocationOpen(false);
            sync();
        }

        panel.addEventListener('click', event => { if (event.target.closest('#market-search-btn')) submitSearch(event); }, true);
        panel.addEventListener('keydown', event => {
            if (!enabled || event.isComposing || event.keyCode === 229) return;
            if (event.target === input && event.key === 'Enter') submitSearch(event);
            else if (event.key === 'Escape' && !locationPanel.hidden && !event.target.matches('.location-search-input[aria-expanded="true"]')) {
                event.preventDefault();
                setLocationOpen(false, true);
            }
        }, true);
        panel.addEventListener('input', sync);
        panel.addEventListener('change', sync);
        document.addEventListener('pointerdown', event => {
            if (enabled && !locationPanel.hidden && !locationPanel.contains(event.target) && !locationToggle.contains(event.target) && !event.target.closest('#screen-location-suggestions, #market-search-btn')) setLocationOpen(false);
        });
        const screen = panel.closest('.content-screen');
        new MutationObserver(() => {
            if (enabled && !screen.classList.contains('active')) { if (dialog.open) dialog.close(); setLocationOpen(false); }
        }).observe(screen, { attributes: true, attributeFilter: ['class'] });

        return {
            enable() {
                if (enabled) return;
                if (!shell) create();
                enabled = true;
                originalPlaceholder = input.getAttribute('placeholder');
                input.placeholder = 'Search listings…';
                input.setAttribute('aria-label', 'Search marketplace listings');
                filtersButton.hidden = false;
                shell.hidden = false;
                move(categoryItem, shell.querySelector('.market-mobile-fields'));
                move(locationItem, locationPanel);
                locationPanel.prepend(locationItem);
                panel.classList.add('market-mobile-ready');
                sync();
                observer.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'disabled'] });
            },
            disable() {
                if (!enabled) return;
                enabled = false;
                observer.disconnect();
                if (dialog.open) dialog.close();
                document.documentElement.classList.remove('market-mobile-sheet-open');
                setLocationOpen(false);
                for (const [node, anchor] of anchors) { anchor.after(node); anchor.remove(); }
                anchors.clear();
                if (originalPlaceholder === null) input.removeAttribute('placeholder');
                else input.setAttribute('placeholder', originalPlaceholder);
                input.removeAttribute('aria-label');
                filtersButton.hidden = true;
                shell.hidden = true;
                panel.classList.remove('market-mobile-ready');
            }
        };
    };
})();
