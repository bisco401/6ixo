(function () {
    'use strict';
    const layouts = new WeakMap();
    const icons = {
        back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
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
        layout.summary = create('div', 'gt-summary', body);
        layout.panelHost = create('div', 'gt-panels', body);
        for (const [name, label] of [['overview','Description'],['details','Item details'],['seller','Seller and contact']]) {
            const panel = create('section', 'gt-panel', layout.panelHost);
            panel.id = `${modal.id}-${name}-panel`;
            panel.setAttribute('aria-label', label);
            layout.panels.set(name, panel);
        }
        layout.descriptionHeading = create('h4', 'gt-section-title cb-description-title', layout.panels.get('overview'));
        layout.descriptionHeading.id = `${modal.id}-description-heading`;
        layout.descriptionHeading.textContent = 'Description';
        layout.panels.get('overview').setAttribute('aria-labelledby', layout.descriptionHeading.id);
        layout.descriptionCard = create('div', 'cb-description-card', layout.panels.get('overview'));
        layout.readmore = create('button', 'gt-readmore', layout.descriptionCard);
        layout.readmore.type = 'button';
        layout.readmore.innerHTML = `<span>Read full description</span>${icons.chevron}`;
        layout.readmore.addEventListener('click', () => {
            const expanded = layout.readmore.getAttribute('aria-expanded') !== 'true';
            layout.description?.classList.toggle('cb-description-collapsed', !expanded);
            layout.readmore.setAttribute('aria-expanded', String(expanded));
            layout.readmore.querySelector('span').textContent = expanded ? 'Show less' : 'Read full description';
        });
        layout.detailsHeading = create('h4', 'gt-section-title', layout.panels.get('details'));
        layout.detailsHeading.textContent = 'Item details';
        layout.detailsToggle = create('button', 'cb-details-toggle', layout.panels.get('details'));
        layout.detailsToggle.type = 'button';
        layout.detailsToggle.innerHTML = `<span></span>${icons.chevron}`;
        layout.detailsToggle.addEventListener('click', () => {
            const expanded = layout.detailsToggle.getAttribute('aria-expanded') !== 'true';
            setDetailsExpanded(layout, expanded);
        });
        layout.shareActions = create('div', 'cb-share-actions', layout.panels.get('seller'));
        layout.sellerEmpty = create('p', 'gt-seller-empty', layout.panels.get('seller'));
        layout.sellerEmpty.textContent = 'Seller details are not provided for this listing.';
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

    function setDetailsExpanded(layout, expanded) {
        layout.extraDetails.forEach(row => { row.hidden = !expanded; });
        layout.detailsToggle.setAttribute('aria-expanded', String(expanded));
        layout.detailsToggle.querySelector('span').textContent = expanded ? 'Show fewer details' : `Show all ${layout.detailRows.length} details`;
    }

    function syncGallery(layout, app) {
        if (!layout.modal.classList.contains('clean-blue-profile')) return;
        const photos = layout.native ? app.luxuryAdPhotos : app.marketplaceModalPhotos;
        const index = layout.native ? app.luxuryAdIndex : app.marketplaceModalIndex;
        const source = photos?.[index || 0] || '';
        app.setModalHeroBackdrop(layout.hero, source ? new URL(source, window.location.href).href : '');
        layout.hero.classList.toggle('cb-has-thumbnails', (photos?.length || 0) > 1);
        layout.thumbs?.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', String(i === (index || 0))));
    }

    // Keep the existing entry point used by listing open/close handlers.
    window.configureListingGalleryTabs = function (app, modal, { enabled = true } = {}) {
        if (!modal) return;
        let layout = layouts.get(modal);
        if (!enabled) {
            modal.classList.remove('gallery-tabs-profile', 'clean-blue-profile');
            if (layout) {
                layout.description?.classList.remove('gt-description-collapsed', 'gt-description-summary', 'cb-description-collapsed');
                layout.extraDetails?.forEach(row => { row.hidden = false; });
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
        const descriptionCard = layout.descriptionCard;
        const details = layout.panels.get('details');
        const seller = layout.panels.get('seller');
        const prefix = layout.native ? 'luxury-ad' : 'marketplace-item';
        move(layout, layout.header, layout.card, layout.card.firstChild);
        move(layout, layout.scroll, layout.card, layout.header.nextSibling);
        const hero = modal.querySelector(layout.native ? '.luxury-ad-hero' : '.marketplace-item-hero');
        move(layout, hero, layout.scroll);
        move(layout, layout.body, layout.scroll);
        layout.hero = hero;
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
        move(layout, thumbs, hero);
        if (thumbs) thumbs.classList.add('gt-thumbnails');
        layout.thumbs = thumbs;
        if (!layout.galleryObserver) {
            layout.galleryObserver = new MutationObserver(() => syncGallery(layout, app));
            layout.galleryObserver.observe(hero, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden'] });
        }
        syncGallery(layout, app);
        if (layout.native) {
            move(layout, get('luxury-ad-title'), layout.summary);
            move(layout, get('luxury-ad-price'), layout.summary);
            move(layout, modal.querySelector('.native-about-section'), descriptionCard, descriptionCard.firstChild);
            move(layout, get('luxury-ad-tags'), descriptionCard);
            move(layout, modal.querySelector('.native-details-section'), details, layout.detailsToggle);
            move(layout, get('luxury-ad-contact'), seller, layout.shareActions);
            move(layout, modal.querySelector('.native-secondary-actions'), seller, layout.shareActions);
            layout.detailsHeading.textContent = get('luxury-ad-details-title')?.textContent || 'Item details';
        } else {
            const summary = modal.querySelector('.marketplace-item-header');
            move(layout, summary, layout.summary);
            move(layout, get('marketplace-item-meta'), layout.body, layout.panelHost);
            const descriptionSection = get('marketplace-item-description-section');
            if (descriptionSection) move(layout, descriptionSection, descriptionCard, descriptionCard.firstChild);
            for (const id of [...(descriptionSection ? [] : ['marketplace-item-description']),'marketplace-item-status','marketplace-item-trust','marketplace-item-trust-panel','marketplace-item-tags']) {
                move(layout, get(id), descriptionCard, layout.readmore);
            }
            const descriptionToggle = modal.querySelector('[data-listing-toggle-for="marketplace-item-description"]');
            move(layout, descriptionToggle, descriptionCard, get('marketplace-item-description')?.nextSibling || layout.readmore);
            move(layout, get('marketplace-item-details'), details, layout.detailsToggle);
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
        overview.prepend(layout.descriptionHeading);
        const condition = Array.from(modal.querySelectorAll(`#${prefix}-details > div`)).find(row => /^condition$/i.test(row.firstElementChild?.textContent.trim() || ''));
        condition?.lastElementChild?.classList.add('cb-condition-value');
        condition?.lastElementChild?.classList.toggle('cb-condition-neutral', !/^(good|excellent|new|like new|very good)$/i.test(condition.lastElementChild.textContent.trim()));
        layout.detailRows = Array.from(get(`${prefix}-details`)?.children || []).filter(row => row.matches('.luxury-ad-detail, .marketplace-item-detail'));
        layout.detailRows.forEach(row => { row.hidden = false; row.classList.remove('listing-detail-hidden'); });
        layout.extraDetails = layout.detailRows.length > 6 ? layout.detailRows.slice(6) : [];
        const legacyDetailsToggle = modal.querySelector(`[data-listing-toggle-for="${prefix}-details"]`);
        if (legacyDetailsToggle) legacyDetailsToggle.hidden = true;
        layout.detailsToggle.hidden = !layout.extraDetails.length;
        layout.detailsToggle.setAttribute('aria-controls', `${prefix}-details`);
        setDetailsExpanded(layout, false);
        layout.sellerEmpty.hidden = Array.from(seller.children).some(node => node !== layout.sellerEmpty && node !== layout.shareActions && !node.classList.contains('hidden') && !node.hidden);
        layout.description = get(layout.native ? 'luxury-ad-summary' : 'marketplace-item-description');
        if (layout.description) {
            const existingToggle = modal.querySelector(`[data-listing-toggle-for="${layout.description.id}"]`);
            const item = layout.native ? app.activeLuxuryAd : app.activeMarketplaceItem;
            const original = layout.native ? app.getCardRecord?.(item?.source?.type, item?.source?.id) || (item?.resourceId && app.getMarketplaceItemById?.(item.resourceId)) || item : item;
            const fullDescription = layout.native && original === item
                ? String(item?.desc || layout.description.textContent).trim()
                : app.getMarketplaceFullDescription(original || {}, layout.description.textContent);
            layout.description.textContent = fullDescription;
            layout.description.classList.remove('gt-description-summary', 'gt-description-collapsed');
            layout.description.classList.toggle('hidden', !fullDescription);
            overview.classList.toggle('cb-empty-description', !fullDescription);
            if (existingToggle) existingToggle.hidden = true;
            const expandable = fullDescription.length > 260 || fullDescription.split('\n').length > 4;
            layout.description.classList.toggle('cb-description-collapsed', expandable);
            layout.readmore.hidden = !expandable;
            layout.readmore.setAttribute('aria-expanded', 'false');
            layout.readmore.setAttribute('aria-controls', layout.description.id);
            layout.readmore.querySelector('span').textContent = 'Read full description';
            layout.description.after(layout.readmore);
        }
        layout.card.scrollTop = 0;
        layout.scroll.scrollTop = 0;
        layout.panels.forEach(panel => { panel.hidden = false; });
    };
})();
