(function () {
    'use strict';
    const layouts = new WeakMap();
    const icons = {
        heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
        share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>',
        package: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5M12 13v9M7.5 5.5l9 5"/></svg>'
    };

    function buildLayout(modal) {
        const native = modal.id === 'luxury-ad-modal';
        const card = modal.querySelector(native ? '.luxury-ad-modal' : '.marketplace-item-modal');
        const body = modal.querySelector(native ? '.luxury-ad-body' : '.marketplace-item-body');
        if (!card || !body) return null;
        const layout = { modal, card, body, native, moves:new Map(), nodes:[], panels:new Map(), tab:'overview' };
        const create = (tag, className, parent) => {
            const node = document.createElement(tag);
            node.className = className;
            layout.nodes.push(node);
            parent.appendChild(node);
            return node;
        };
        const header = create('header', 'gt-header', card);
        const brand = create('div', 'gt-brand', header);
        brand.innerHTML = '<img src="assets/6ixo-logo.png" alt="6ixo logo" width="52" height="52" decoding="async"><span>6ixo.com</span>';
        layout.header = header;
        layout.headerActions = create('div', 'gt-header-actions', header);
        layout.summary = create('div', 'gt-summary', body);
        layout.tabs = create('div', 'gt-tabs', body);
        layout.tabs.setAttribute('role', 'tablist');
        layout.tabs.setAttribute('aria-label', 'Listing information');
        layout.panelHost = create('div', 'gt-panels', body);
        for (const [name, label] of [['overview','Overview'],['details','Details'],['seller','Seller']]) {
            const button = create('button', 'gt-tab', layout.tabs);
            button.type = 'button';
            button.id = `${modal.id}-${name}-tab`;
            button.dataset.galleryTab = name;
            button.textContent = label;
            button.setAttribute('role', 'tab');
            const panel = create('section', 'gt-panel', layout.panelHost);
            panel.id = `${modal.id}-${name}-panel`;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', button.id);
            button.setAttribute('aria-controls', panel.id);
            layout.panels.set(name, panel);
            button.addEventListener('click', () => selectTab(layout, name));
            button.addEventListener('keydown', event => {
                const order = ['overview','details','seller'];
                let target;
                if (event.key === 'ArrowLeft') target = order[(order.indexOf(name) + 2) % 3];
                if (event.key === 'ArrowRight') target = order[(order.indexOf(name) + 1) % 3];
                if (event.key === 'Home') target = order[0];
                if (event.key === 'End') target = order[2];
                if (!target) return;
                event.preventDefault();
                event.stopPropagation();
                selectTab(layout, target);
                layout.tabs.querySelector(`[data-gallery-tab="${target}"]`).focus();
            });
        }
        layout.condition = create('div', 'gt-condition', layout.panels.get('overview'));
        layout.condition.innerHTML = `${icons.package}<div><strong></strong><small>Condition</small></div>`;
        layout.readmore = create('button', 'gt-readmore', layout.panels.get('overview'));
        layout.readmore.type = 'button';
        layout.readmore.textContent = 'Read full description';
        layout.readmore.addEventListener('click', () => {
            const expanded = layout.readmore.getAttribute('aria-expanded') !== 'true';
            layout.description?.classList.toggle('gt-description-collapsed', !expanded);
            layout.readmore.setAttribute('aria-expanded', String(expanded));
            layout.readmore.textContent = expanded ? 'Show less' : 'Read full description';
        });
        const heading = create('h4', 'gt-section-title', layout.panels.get('details'));
        heading.textContent = 'Key information';
        const sellerHeading = create('h4', 'gt-section-title', layout.panels.get('seller'));
        sellerHeading.textContent = 'Seller & contact';
        layout.sellerEmpty = create('p', 'gt-seller-empty', layout.panels.get('seller'));
        layout.sellerEmpty.textContent = 'Seller details are not provided for this listing.';
        if (!native && !modal.querySelector('#marketplace-item-description-section')) {
            layout.aboutHeading = create('h4', 'gt-section-title', layout.panels.get('overview'));
            layout.aboutHeading.textContent = 'About this item';
        }
        layouts.set(modal, layout);
        return layout;
    }

    function move(layout, node, parent, before = null) {
        if (!node || !parent) return;
        if (!layout.moves.has(node)) {
            const anchor = document.createComment('gallery-tabs original position');
            node.before(anchor);
            layout.moves.set(node, anchor);
        }
        parent.insertBefore(node, before);
    }

    function selectTab(layout, name) {
        if (!layout.panels.has(name)) return;
        layout.tab = name;
        layout.tabs.querySelectorAll('[data-gallery-tab]').forEach(button => {
            const selected = button.dataset.galleryTab === name;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        layout.panels.forEach((panel, key) => { panel.hidden = key !== name; });
    }

    window.configureListingGalleryTabs = function (app, modal, { enabled = true } = {}) {
        if (!modal) return;
        let layout = layouts.get(modal);
        if (!enabled) {
            modal.classList.remove('gallery-tabs-profile');
            if (layout) {
                layout.description?.classList.remove('gt-description-collapsed', 'gt-description-summary');
                modal.querySelectorAll('[data-listing-toggle-for]').forEach(button => { button.hidden = false; });
                layout.moves.forEach((anchor, node) => { if (node.isConnected) anchor.after(node); });
                layout.nodes.forEach(node => { node.hidden = true; });
            }
            return;
        }
        layout = layout || buildLayout(modal);
        if (!layout) return;
        layout.moves.forEach((anchor, node) => {
            if (!node.isConnected) { anchor.remove(); layout.moves.delete(node); }
        });
        layout.nodes.forEach(node => { node.hidden = false; });
        modal.classList.add('gallery-tabs-profile');
        const get = id => document.getElementById(id);
        const overview = layout.panels.get('overview');
        const details = layout.panels.get('details');
        const seller = layout.panels.get('seller');
        const prefix = layout.native ? 'luxury-ad' : 'marketplace-item';
        move(layout, layout.header, layout.card, layout.card.firstChild);
        const save = get(layout.native ? 'luxury-ad-save' : 'marketplace-item-save');
        const share = get(layout.native ? 'luxury-ad-native-share' : 'marketplace-item-share');
        for (const [node, icon, label] of [[save, icons.heart, 'Save listing'],[share, icons.share, 'Share listing']]) {
            if (!node) continue;
            node.innerHTML = icon;
            node.setAttribute('aria-label', node === save && node.getAttribute('aria-pressed') === 'true' ? 'Remove saved listing' : label);
            if (node === save) {
                node.classList.remove('hidden');
                if (!node.dataset.galleryTabsIconBound) {
                    node.addEventListener('click', () => queueMicrotask(() => { node.innerHTML = icons.heart; }));
                    node.dataset.galleryTabsIconBound = '1';
                }
            }
            if (node === share && !layout.native) node.dataset.marketplaceAction = 'share';
            move(layout, node, layout.headerActions);
        }
        move(layout, get(`${prefix}-close`), layout.headerActions);
        const thumbs = get(`${prefix}-thumbs`);
        move(layout, thumbs, layout.card, layout.body);
        if (thumbs) thumbs.classList.add('gt-thumbnails');
        if (layout.native) {
            move(layout, get('luxury-ad-title'), layout.summary);
            move(layout, get('luxury-ad-price'), layout.summary);
            move(layout, modal.querySelector('.native-about-section'), overview, layout.condition);
            move(layout, get('luxury-ad-tags'), overview, layout.condition);
            move(layout, modal.querySelector('.native-details-section'), details);
            move(layout, get('luxury-ad-contact'), seller, layout.sellerEmpty);
            move(layout, modal.querySelector('.native-secondary-actions'), seller, layout.sellerEmpty);
        } else {
            const summary = modal.querySelector('.marketplace-item-header');
            move(layout, summary, layout.summary);
            move(layout, get('marketplace-item-meta'), layout.body, layout.tabs);
            const descriptionSection = get('marketplace-item-description-section');
            if (descriptionSection) move(layout, descriptionSection, overview, layout.condition);
            for (const id of [...(descriptionSection ? [] : ['marketplace-item-description']),'marketplace-item-status','marketplace-item-trust','marketplace-item-trust-panel','marketplace-item-tags']) {
                move(layout, get(id), overview, layout.condition);
            }
            move(layout, layout.aboutHeading, overview, overview.firstChild);
            const descriptionToggle = modal.querySelector('[data-listing-toggle-for="marketplace-item-description"]');
            move(layout, descriptionToggle, overview, get('marketplace-item-description')?.nextSibling || layout.condition);
            move(layout, get('marketplace-item-details'), details);
            move(layout, modal.querySelector('[data-listing-toggle-for="marketplace-item-details"]'), details);
            move(layout, get('marketplace-item-seller'), seller, layout.sellerEmpty);
            for (const id of ['marketplace-item-secure-deal','marketplace-item-gallery']) move(layout, get(id), seller, layout.sellerEmpty);
            move(layout, modal.querySelector('.marketplace-item-actions'), layout.card);
            const category = modal.querySelector('.marketplace-item-header .featured-label');
            if (category && app.activeMarketplaceItem && !app.isMarketplaceItemSold(app.activeMarketplaceItem)) category.textContent = app.marketplaceCategoryLabel(app.activeMarketplaceItem.category);
            if (app.activeMarketplaceItem) {
                const item = app.activeMarketplaceItem;
                get('marketplace-item-meta').textContent = [item.city,item.country].filter(Boolean).join(', ');
                save?.setAttribute('aria-pressed', String(app.isMarketplaceSaved(item.id)));
            }
        }
        const condition = Array.from(modal.querySelectorAll(`#${prefix}-details > div`)).find(row => /^condition$/i.test(row.firstElementChild?.textContent.trim() || ''));
        const conditionValue = condition?.lastElementChild?.textContent.trim() || '';
        layout.condition.querySelector('strong').textContent = conditionValue;
        layout.condition.hidden = !conditionValue;
        layout.sellerEmpty.hidden = Array.from(seller.children).some(node => node !== layout.sellerEmpty && node.tagName !== 'H4' && !node.classList.contains('hidden') && !node.hidden);
        layout.description = get(layout.native ? 'luxury-ad-summary' : 'marketplace-item-description');
        if (layout.description) {
            const existingToggle = modal.querySelector(`[data-listing-toggle-for="${layout.description.id}"]`);
            const item = layout.native ? app.activeLuxuryAd : app.activeMarketplaceItem;
            const scraped = item?.sourceType === 'scraped' || app.isScrapedMarketplaceItem?.(item || {});
            if (scraped && layout.description.textContent.trim().length > 620) {
                layout.description.textContent = app.cleanScrapedListingDescription(layout.description.textContent, item);
            }
            layout.description.classList.toggle('gt-description-summary', Boolean(scraped));
            if (existingToggle) existingToggle.hidden = Boolean(scraped);
            const expandable = !scraped && !existingToggle && layout.description.textContent.trim().length > 150;
            layout.description.classList.toggle('gt-description-collapsed', expandable);
            layout.readmore.hidden = !expandable;
            layout.readmore.setAttribute('aria-expanded', 'false');
            layout.readmore.setAttribute('aria-controls', layout.description.id);
            layout.readmore.textContent = 'Read full description';
            layout.description.after(layout.readmore);
            if (scraped) {
                const heading = get(layout.native ? 'luxury-ad-about-title' : 'marketplace-item-description-title') || layout.aboutHeading;
                if (heading) heading.textContent = 'About this ad';
            }
        }
        layout.card.scrollTop = 0;
        selectTab(layout, 'overview');
    };
})();
