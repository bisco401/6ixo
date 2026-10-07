(function () {
    'use strict';
    const layouts = new WeakMap();
    const icons = {
        back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14"/></svg>',
        photos: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="15" height="15" rx="2"/><path d="m6 12 4-4 4 4 3-3 4 4M3 7v12a2 2 0 0 0 2 2h12"/></svg>',
        heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
        share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>'
    };

    function buildLayout(modal, app) {
        const native = modal.id === 'luxury-ad-modal';
        const card = modal.querySelector(native ? '.luxury-ad-modal' : '.marketplace-item-modal');
        const body = modal.querySelector(native ? '.luxury-ad-body' : '.marketplace-item-body');
        if (!card || !body) return null;
        const layout = { modal, card, body, native, moves:new Map(), nodes:[], panels:new Map() };
        const create = (tag, className, parent) => {
            const node = document.createElement(tag);
            node.className = className;
            layout.nodes.push(node);
            parent.appendChild(node);
            return node;
        };
        const header = create('header', 'gt-header', card);
        const back = create('button', 'cb-back', header);
        back.type = 'button';
        back.setAttribute('aria-label', 'Back to listings');
        back.innerHTML = icons.back;
        app.bindProfileCloseButton(back, options => native ? app.closeLuxuryAdModal(options) : app.closeMarketplaceItemModal(options), modal.id);
        const brand = create('div', 'gt-brand', header);
        brand.innerHTML = '<span>6ixo<span class="cb-brand-dot">.</span></span>';
        layout.header = header;
        layout.headerActions = create('div', 'gt-header-actions', header);
        layout.scroll = create('div', 'cb-scroll', card);
        layout.photoLabel = create('span', 'cb-photo-label', card);
        layout.photoLabel.innerHTML = `${icons.photos} Photos`;
        layout.summary = create('div', 'gt-summary', body);
        layout.panelHost = create('div', 'gt-panels', body);
        for (const [name, label] of [['details','Item details'],['overview','About this item'],['seller','Seller and contact']]) {
            const panel = create('section', 'gt-panel', layout.panelHost);
            panel.id = `${modal.id}-${name}-panel`;
            panel.setAttribute('aria-label', label);
            layout.panels.set(name, panel);
        }
        layout.readmore = create('button', 'gt-readmore', layout.panels.get('overview'));
        layout.readmore.type = 'button';
        layout.readmore.textContent = 'Read more';
        layout.readmore.addEventListener('click', () => {
            const expanded = layout.readmore.getAttribute('aria-expanded') !== 'true';
            layout.description?.classList.toggle('gt-description-collapsed', !expanded);
            layout.readmore.setAttribute('aria-expanded', String(expanded));
            layout.readmore.textContent = expanded ? 'Read less' : 'Read more';
        });
        layout.detailsHeading = create('h4', 'gt-section-title', layout.panels.get('details'));
        layout.detailsHeading.textContent = 'Item details';
        layout.shareActions = create('div', 'cb-share-actions', layout.panels.get('seller'));
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
            const anchor = document.createComment('listing profile original position');
            node.before(anchor);
            layout.moves.set(node, anchor);
        }
        parent.insertBefore(node, before?.parentNode === parent ? before : null);
    }

    // Keep the existing entry point used by listing open/close handlers.
    window.configureListingGalleryTabs = function (app, modal, { enabled = true } = {}) {
        if (!modal) return;
        let layout = layouts.get(modal);
        if (!enabled) {
            modal.classList.remove('gallery-tabs-profile', 'clean-blue-profile');
            if (layout) {
                layout.description?.classList.remove('gt-description-collapsed', 'gt-description-summary');
                modal.querySelectorAll('[data-listing-toggle-for]').forEach(button => { button.hidden = false; });
                layout.moves.forEach((anchor, node) => { if (node.isConnected) anchor.after(node); });
                layout.nodes.forEach(node => { node.hidden = true; });
            }
            return;
        }
        layout = layout || buildLayout(modal, app);
        if (!layout) return;
        layout.moves.forEach((anchor, node) => {
            if (!node.isConnected) { anchor.remove(); layout.moves.delete(node); }
        });
        layout.nodes.forEach(node => { node.hidden = false; });
        modal.classList.add('gallery-tabs-profile', 'clean-blue-profile');
        const get = id => document.getElementById(id);
        const overview = layout.panels.get('overview');
        const details = layout.panels.get('details');
        const seller = layout.panels.get('seller');
        const prefix = layout.native ? 'luxury-ad' : 'marketplace-item';
        move(layout, layout.header, layout.card, layout.card.firstChild);
        move(layout, layout.scroll, layout.card, layout.header.nextSibling);
        const hero = modal.querySelector(layout.native ? '.luxury-ad-hero' : '.marketplace-item-hero');
        move(layout, hero, layout.scroll);
        move(layout, layout.body, layout.scroll);
        move(layout, layout.photoLabel, hero);
        const save = get(layout.native ? 'luxury-ad-save' : 'marketplace-item-save');
        const share = get(layout.native ? 'luxury-ad-native-share' : 'marketplace-item-share');
        for (const [node, icon, label] of [[save, icons.heart, 'Save listing'],[share, icons.share, 'Share listing']]) {
            if (!node) continue;
            node.innerHTML = node === share ? `${icon}<span>Share listing</span>` : icon;
            node.setAttribute('aria-label', node === save && node.getAttribute('aria-pressed') === 'true' ? 'Remove saved listing' : label);
            if (node === save) {
                node.classList.remove('hidden');
                if (!node.dataset.galleryTabsIconBound) {
                    node.addEventListener('click', () => queueMicrotask(() => { node.innerHTML = icons.heart; }));
                    node.dataset.galleryTabsIconBound = '1';
                }
            }
            if (node === share && !layout.native) node.dataset.marketplaceAction = 'share';
            move(layout, node, node === share ? layout.shareActions : layout.headerActions);
        }
        move(layout, get(`${prefix}-close`), layout.headerActions);
        const thumbs = get(`${prefix}-thumbs`);
        move(layout, thumbs, layout.scroll, layout.body);
        if (thumbs) thumbs.classList.add('gt-thumbnails');
        if (layout.native) {
            move(layout, get('luxury-ad-title'), layout.summary);
            move(layout, get('luxury-ad-price'), layout.summary);
            move(layout, modal.querySelector('.native-about-section'), overview, layout.readmore);
            move(layout, get('luxury-ad-tags'), overview);
            move(layout, modal.querySelector('.native-details-section'), details);
            move(layout, get('luxury-ad-contact'), seller, layout.shareActions);
            move(layout, modal.querySelector('.native-secondary-actions'), seller, layout.shareActions);
            layout.detailsHeading.textContent = get('luxury-ad-details-title')?.textContent || 'Item details';
        } else {
            const summary = modal.querySelector('.marketplace-item-header');
            move(layout, summary, layout.summary);
            move(layout, get('marketplace-item-meta'), layout.body, layout.panelHost);
            const descriptionSection = get('marketplace-item-description-section');
            if (descriptionSection) move(layout, descriptionSection, overview, layout.readmore);
            for (const id of [...(descriptionSection ? [] : ['marketplace-item-description']),'marketplace-item-status','marketplace-item-trust','marketplace-item-trust-panel','marketplace-item-tags']) {
                move(layout, get(id), overview, layout.readmore);
            }
            move(layout, layout.aboutHeading, overview, overview.firstChild);
            const descriptionToggle = modal.querySelector('[data-listing-toggle-for="marketplace-item-description"]');
            move(layout, descriptionToggle, overview, get('marketplace-item-description')?.nextSibling || layout.readmore);
            move(layout, get('marketplace-item-details'), details);
            move(layout, modal.querySelector('[data-listing-toggle-for="marketplace-item-details"]'), details);
            move(layout, get('marketplace-item-seller'), seller, layout.shareActions);
            for (const id of ['marketplace-item-secure-deal','marketplace-item-gallery']) move(layout, get(id), seller, layout.shareActions);
            move(layout, modal.querySelector('.marketplace-item-actions'), layout.card);
            const message = get('marketplace-item-offer');
            if (message?.dataset.marketAction === 'message') message.innerHTML = get('luxury-ad-message')?.innerHTML || 'Message';
            const category = modal.querySelector('.marketplace-item-header .featured-label');
            if (category && app.activeMarketplaceItem && !app.isMarketplaceItemSold(app.activeMarketplaceItem)) category.textContent = app.marketplaceCategoryLabel(app.activeMarketplaceItem.category);
            if (app.activeMarketplaceItem) {
                const item = app.activeMarketplaceItem;
                get('marketplace-item-meta').textContent = [item.city,item.country].filter(Boolean).join(', ');
                save?.setAttribute('aria-pressed', String(app.isMarketplaceSaved(item.id)));
            }
        }
        const condition = Array.from(modal.querySelectorAll(`#${prefix}-details > div`)).find(row => /^condition$/i.test(row.firstElementChild?.textContent.trim() || ''));
        condition?.lastElementChild?.classList.add('cb-condition-value');
        condition?.lastElementChild?.classList.toggle('cb-condition-neutral', !/^(good|excellent|new|like new|very good)$/i.test(condition.lastElementChild.textContent.trim()));
        layout.sellerEmpty.hidden = Array.from(seller.children).some(node => node !== layout.sellerEmpty && node !== layout.shareActions && !node.classList.contains('hidden') && !node.hidden);
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
            layout.readmore.textContent = 'Read more';
            layout.description.after(layout.readmore);
            if (scraped) {
                const heading = get(layout.native ? 'luxury-ad-about-title' : 'marketplace-item-description-title') || layout.aboutHeading;
                if (heading) heading.textContent = 'About this ad';
            }
        }
        layout.card.scrollTop = 0;
        layout.scroll.scrollTop = 0;
        layout.panels.forEach(panel => { panel.hidden = false; });
    };
})();
