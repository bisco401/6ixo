(function () {
    'use strict';
    const layouts = new WeakMap();
    const nativeImageGuards = new WeakSet();
    const icons = {
        back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14"/></svg>',
        heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
        share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
    };
    const configurations = {
        'vehicle-modal': {
            open: 'openVehicleModal', close: 'closeVehicleModal', state: 'activeVehicleListing',
            card: '.vehicle-modal', body: '.vehicle-modal-body', hero: '.vehicle-modal-media', photo: '#vehicle-modal-image',
            summary: '.vehicle-modal-head', title: '#vehicle-modal-title', price: '#vehicle-modal-price',
            legacyDescription: '#vehicle-modal-desc', description: '#vehicle-modal-desc-preview',
            details: ['#vehicle-modal-specs'], rows: '.vehicle-spec-row', detailsLabel: 'Vehicle details',
            obsolete: ['.vehicle-modal-details-section'],
            thumbs: '#vehicle-media-thumbs', prev: '#vehicle-media-prev', next: '#vehicle-media-next', counter: '#vehicle-media-counter',
            actions: '.vehicle-modal-actions', message: '#vehicle-modal-message', call: '#vehicle-modal-call', save: '#vehicle-modal-fav', share: '#vehicle-modal-share'
        },
        'realestate-modal': {
            open: 'openRealestateModal', close: 'closeRealestateModal', state: 'activeRealestateListing',
            card: '.realestate-modal', body: '.realestate-modal-body', hero: '.realestate-modal-media', photo: '#realestate-modal-image',
            summary: '.realestate-modal-head', title: '#realestate-modal-title', price: '#realestate-modal-price',
            legacyDescription: '#realestate-modal-description', description: '#realestate-modal-desc',
            details: ['#realestate-modal-details'], rows: '.realestate-modal-detail', detailsLabel: 'Property details',
            obsolete: ['.realestate-key-information'],
            thumbs: '#realestate-media-thumbs', prev: '#realestate-media-prev', next: '#realestate-media-next', counter: '#realestate-media-counter',
            actions: '.realestate-modal-actions', message: '#realestate-modal-viewing', call: '#realestate-modal-call', share: '#realestate-modal-share'
        },
        'service-modal': {
            open: 'openServiceModal', close: 'closeServiceModal', state: 'activeServiceProfile',
            card: '.service-profile-modal', body: '.service-modal-body', hero: '.service-modal-media', photo: '#service-modal-image',
            summary: '.service-modal-head', title: '#service-modal-title', price: '#service-modal-fee',
            legacyDescription: '#service-modal-desc', description: '#service-modal-desc',
            details: ['#service-modal-highlights-wrap', '#service-modal-availability-wrap'], rows: '#service-modal-highlights > li, #service-modal-availability > span', detailsLabel: 'Service details',
            thumbs: '#service-modal-thumbs', prev: '#service-media-prev', next: '#service-media-next', counter: '#service-media-counter',
            actions: '.service-modal-actions', message: '#service-modal-message', call: '#service-modal-call', share: '#service-modal-share',
            provider: '.service-modal-provider', tags: '#service-modal-tags'
        },
        'profile-modal': {
            open: 'openProfileModal', close: 'closeProfileModal', state: 'activeProfile', personal: true,
            card: '.profile-modal-content', body: '.profile-modal-body', hero: '.profile-modal-media', photo: '#profile-modal-photo',
            summary: '.profile-modal-header', title: '#profile-modal-name',
            legacyDescription: '#profile-modal-bio', description: '#profile-modal-bio',
            details: ['#profile-modal-lifestyle'], rows: '.lifestyle-item', detailsLabel: 'Profile details',
            obsolete: ['#profile-modal-lifestyle-wrap'],
            thumbs: '#profile-modal-gallery', prev: '#profile-photo-prev', next: '#profile-photo-next', counter: '#profile-photo-counter',
            actions: '.profile-modal-actions', message: '#profile-modal-message', call: '#profile-modal-call', save: '#profile-modal-like', share: '#profile-modal-share'
        },
        'demo-profile-modal': {
            open: 'openDemoProfileObject', close: 'closeDemoProfile', state: 'activeDemoProfile', personal: true,
            card: '.modal-content', photo: '#demo-profile-photo', summary: '.demo-profile-summary', title: '#demo-profile-name',
            legacyDescription: '#demo-profile-bio', description: '#demo-profile-bio',
            details: ['#demo-profile-lifestyle'], rows: '.lifestyle-item', detailsLabel: 'Profile details',
            obsolete: ['.demo-profile-header', '.demo-profile-extra > div:has(#demo-profile-lifestyle)'],
            extras: ['.demo-profile-extra'], thumbs: '#demo-profile-gallery-strip',
            actions: '.demo-profile-actions', message: '#demo-profile-message-btn', call: '#demo-profile-call', share: '#demo-profile-share-btn'
        },
        'seller-profile-modal': {
            open: 'openSellerProfileModal', close: 'closeSellerProfileModal', state: 'activeSellerProfile', personal: true,
            card: '.seller-profile-modal', body: '.seller-profile-scroll', hero: '#seller-profile-luxury-hero', photo: '#seller-profile-luxury-image',
            summary: '.seller-profile-identity', title: '#seller-profile-name',
            legacyDescription: '#seller-profile-bio', description: '#seller-profile-bio',
            details: ['.seller-profile-stats'], rows: '.seller-profile-stat', detailsLabel: 'Seller details',
            obsolete: ['.seller-profile-header'],
            thumbs: '#seller-profile-luxury-thumbs', prev: '#seller-profile-luxury-prev', next: '#seller-profile-luxury-next', counter: '#seller-profile-luxury-counter',
            actions: '.seller-profile-actions', message: '#seller-profile-message', call: '#seller-profile-call', share: '#seller-profile-share'
        }
    };

    function create(tag, className, parent) {
        const node = document.createElement(tag);
        node.className = className;
        parent.appendChild(node);
        return node;
    }

    function placeHeaderShare(modal, app) {
        const header = modal.querySelector('.cb-profile-header, .gt-header');
        const actions = header?.querySelector('.cb-profile-header-actions, .gt-header-actions');
        const selector = configurations[modal.id]?.share || (modal.id === 'luxury-ad-modal' ? '#luxury-ad-native-share' : '#marketplace-item-share');
        const share = modal.querySelector(selector);
        if (!actions || !share) return;
        const personal = configurations[modal.id]?.personal || (modal.id === 'luxury-ad-modal' && app.activeLuxuryAd?.sourceType === 'companionship');
        const label = personal ? 'Share profile' : 'Share listing';
        share.type = 'button';
        share.classList.add('cb-profile-share');
        share.classList.remove('hidden');
        share.innerHTML = icons.share;
        share.setAttribute('aria-label', label);
        share.setAttribute('title', label);
        if (modal.id === 'marketplace-item-modal') share.dataset.marketplaceAction = 'share';
        // Move the original button so its existing share handler stays attached.
        actions.insertBefore(share, actions.querySelector('.profile-card-close'));
        const count = Array.from(actions.querySelectorAll('button')).filter(button => getComputedStyle(button).display !== 'none').length;
        header.style.setProperty('--cb-header-actions', `${Math.max(88, count * 44)}px`);
    }

    function galleryState(layout, app) {
        return app.getSitewideListingImageContext(layout.photo) || { sources: [], index: 0 };
    }

    function syncGallery(layout, app) {
        const state = galleryState(layout, app);
        const sources = state.sources || [];
        const multiple = sources.length > 1;
        layout.hero.classList.toggle('cb-has-thumbnails', multiple);
        layout.hero.hidden = !sources.length;
        const current = sources[state.index || 0];
        const source = typeof current === 'string' ? current : current?.src || current?.url || '';
        app.setModalHeroBackdrop(layout.hero, source && current?.type !== 'video' ? new URL(source, window.location.href).href : '');
        layout.thumbs?.querySelectorAll('button').forEach((button, index) => button.setAttribute('aria-pressed', String(index === (state.index || 0))));
        if (layout.generatedNav) {
            layout.prev.hidden = layout.next.hidden = !multiple;
            layout.counter.hidden = !multiple;
            layout.counter.textContent = `${(state.index || 0) + 1} / ${sources.length}`;
        }
    }

    function build(modal, config, app) {
        const card = modal.querySelector(config.card);
        if (!card) return null;
        const get = selector => selector ? modal.querySelector(selector) : null;
        const summary = get(config.summary);
        const legacyDescription = get(config.legacyDescription);
        const originalDescription = get(config.description);
        const obsolete = (config.obsolete || []).map(get).filter(Boolean);
        const actions = get(config.actions);
        const body = get(config.body) || create('div', 'cb-profile-body', card);
        const photo = get(config.photo);
        const hero = get(config.hero) || create('div', 'cb-profile-hero', card);
        if (!config.hero && photo) hero.appendChild(photo);
        const layout = { modal, config, card, body, hero, photo, originalDescription, rows: [], groups: [] };
        card.classList.add('cb-profile-frame');
        body.classList.add('cb-profile-body');
        hero.classList.add('cb-profile-hero');
        photo?.classList.add('cb-profile-photo');
        get(config.title)?.classList.add('cb-profile-title');
        get(config.price)?.classList.add('cb-profile-price');
        obsolete.forEach(node => node.classList.add('cb-obsolete-section'));
        legacyDescription?.classList.add('cb-legacy-description');
        // Vehicle profiles use the shared description instead of the old preview.
        if (modal.id === 'vehicle-modal') legacyDescription?.remove();

        const header = create('header', 'cb-profile-header', card);
        const back = create('button', 'cb-profile-back', header);
        back.type = 'button';
        back.innerHTML = icons.back;
        back.setAttribute('aria-label', 'Back');
        app.bindProfileCloseButton(back, options => app[config.close](options), modal.id);
        const brand = create('div', 'cb-profile-brand', header);
        brand.innerHTML = '6ixo<span>.</span>';
        const headerActions = create('div', 'cb-profile-header-actions', header);
        const close = modal.querySelector('.profile-card-close');
        if (config.save) {
            layout.save = get(config.save);
            if (layout.save) {
                layout.save.classList.add('cb-profile-save');
                headerActions.appendChild(layout.save);
                layout.save.addEventListener('click', () => queueMicrotask(() => refreshSave(layout)));
                layout.saveObserver = new MutationObserver(() => {
                    if (layout.save.textContent.trim()) refreshSave(layout);
                });
                layout.saveObserver.observe(layout.save, { childList: true, subtree: true, characterData: true });
            }
        }
        if (close) headerActions.appendChild(close);
        const scroll = create('div', 'cb-profile-scroll', card);
        scroll.append(hero, body);
        card.prepend(header);
        layout.scroll = scroll;

        const intro = create('div', 'cb-profile-intro', body);
        if (summary) intro.appendChild(summary);
        body.prepend(intro);
        const overview = create('section', 'cb-profile-description-section', body);
        const descriptionHeading = create('h4', 'cb-profile-section-title', overview);
        descriptionHeading.id = modal.id + '-shared-description-heading';
        descriptionHeading.textContent = 'Description';
        overview.setAttribute('aria-labelledby', descriptionHeading.id);
        const descriptionCard = create('div', 'cb-profile-description-card', overview);
        // Move the original text into the shared card so existing update hooks
        // keep working without leaving a second description below the details.
        if (originalDescription?.tagName === 'P') {
            layout.description = originalDescription;
            layout.description.className = 'cb-profile-description';
            descriptionCard.appendChild(layout.description);
            if (legacyDescription !== layout.description) legacyDescription?.remove();
        } else {
            layout.description = create('p', 'cb-profile-description', descriptionCard);
            layout.description.id = modal.id + '-shared-description';
        }
        layout.readmore = create('button', 'cb-profile-readmore', descriptionCard);
        layout.readmore.type = 'button';
        layout.readmore.setAttribute('aria-controls', layout.description.id);
        layout.readmore.addEventListener('click', () => setDescriptionExpanded(layout, layout.readmore.getAttribute('aria-expanded') !== 'true'));
        intro.after(overview);
        layout.overview = overview;

        const details = create('section', 'cb-profile-details-section', body);
        const detailsHeading = create('h4', 'cb-profile-section-title', details);
        detailsHeading.textContent = config.detailsLabel;
        const detailContent = create('div', 'cb-profile-detail-content', details);
        for (const selector of config.details) {
            const node = get(selector);
            if (node) detailContent.appendChild(node);
        }
        const detailsToggle = create('button', 'cb-profile-details-toggle', details);
        detailsToggle.type = 'button';
        detailContent.id = modal.id + '-shared-details';
        detailsToggle.setAttribute('aria-controls', detailContent.id);
        detailsToggle.addEventListener('click', () => setDetailsExpanded(layout, detailsToggle.getAttribute('aria-expanded') !== 'true'));
        overview.after(details);
        Object.assign(layout, { details, detailContent, detailsToggle });
        for (const selector of config.extras || []) {
            const node = get(selector);
            if (node) body.appendChild(node);
        }
        if (config.provider) {
            const node = get(config.provider);
            if (node) { node.classList.add('cb-profile-provider'); body.appendChild(node); }
        }
        if (config.tags) {
            const node = get(config.tags);
            if (node) intro.appendChild(node);
        }

        const footer = create('div', 'cb-profile-contact-bar', card);
        const message = get(config.message);
        const call = get(config.call);
        if (message) { message.classList.add('cb-profile-message'); footer.appendChild(message); }
        if (call) { call.classList.add('cb-profile-call'); footer.appendChild(call); }
        if (actions) {
            actions.classList.add('cb-profile-secondary-actions');
            body.appendChild(actions);
        }
        layout.message = message;
        layout.footer = footer;
        layout.thumbs = get(config.thumbs);
        if (layout.thumbs) { layout.thumbs.classList.add('cb-profile-thumbnails'); hero.appendChild(layout.thumbs); }
        layout.prev = get(config.prev);
        layout.next = get(config.next);
        layout.counter = get(config.counter);
        if (!layout.prev && photo) {
            layout.generatedNav = true;
            for (const [name, direction] of [['prev', -1], ['next', 1]]) {
                const button = create('button', 'cb-profile-nav cb-profile-' + name, hero);
                button.type = 'button';
                button.innerHTML = icons.chevron;
                button.setAttribute('aria-label', direction < 0 ? 'Previous photo' : 'Next photo');
                button.addEventListener('click', event => { event.stopPropagation(); app.stepStandaloneSwipeableImage(photo, direction); syncGallery(layout, app); });
                layout[name] = button;
            }
            layout.counter = create('div', 'cb-profile-counter', hero);
        }
        layout.prev?.classList.add('cb-profile-nav', 'cb-profile-prev');
        layout.next?.classList.add('cb-profile-nav', 'cb-profile-next');
        layout.counter?.classList.add('cb-profile-counter');
        const observer = new MutationObserver(() => syncGallery(layout, app));
        if (photo) observer.observe(photo, { attributes: true, attributeFilter: ['src'] });
        if (layout.thumbs) observer.observe(layout.thumbs, { childList: true });
        layout.galleryObserver = observer;
        layouts.set(modal, layout);
        return layout;
    }

    function refreshSave(layout) {
        const save = layout.save;
        if (!save) return;
        const text = save.textContent.trim();
        const active = text
            ? /saved|liked|unlike/i.test(text) || save.classList.contains('saved') || save.classList.contains('liked')
            : save.getAttribute('aria-pressed') === 'true' || save.classList.contains('saved') || save.classList.contains('liked');
        save.innerHTML = icons.heart;
        save.setAttribute('aria-label', layout.config.personal ? (active ? 'Unlike profile' : 'Like profile') : (active ? 'Remove saved listing' : 'Save listing'));
        save.setAttribute('aria-pressed', String(active));
    }

    function setDescriptionExpanded(layout, expanded) {
        layout.description.classList.toggle('cb-profile-description-collapsed', !expanded);
        layout.readmore.setAttribute('aria-expanded', String(expanded));
        layout.readmore.innerHTML = `<span>${expanded ? 'Show less' : 'Read full description'}</span>${icons.chevron}`;
    }

    function setDetailsExpanded(layout, expanded) {
        layout.rows.forEach((row, index) => { row.hidden = !expanded && index >= 6; });
        layout.groups.forEach(group => {
            const rows = Array.from(group.querySelectorAll(layout.config.rows));
            group.hidden = rows.length > 0 && rows.every(row => row.hidden);
        });
        layout.detailsToggle.setAttribute('aria-expanded', String(expanded));
        layout.detailsToggle.innerHTML = `<span>${expanded ? 'Show fewer details' : `Show all ${layout.rows.length} details`}</span>${icons.chevron}`;
    }

    function applyUi(app, modal, config) {
        if (!modal || modal.classList.contains('hidden')) return;
        const layout = layouts.get(modal) || build(modal, config, app);
        if (!layout) return;
        modal.classList.add('clean-blue-profile', 'cb-shared-profile');
        const record = app[config.state] || {};
        if (modal.id === 'vehicle-modal') {
            const location = [record.city, record.country].filter(Boolean).join(', ');
            const subtitle = modal.querySelector('#vehicle-modal-sub');
            if (subtitle?.classList.contains('hidden') && location) {
                subtitle.textContent = location;
                subtitle.classList.remove('hidden');
            }
        }
        if (modal.id === 'seller-profile-modal' && !(app.sellerProfileLuxuryGallery?.images?.length)) {
            const images = Array.from(new Set([record.heroImage, ...(record.galleryImages || []), ...(record.listings || []).flatMap(item => [item.thumb, item.image, ...(item.images || [])])].filter(Boolean)));
            if (images.length) {
                app.sellerProfileLuxuryGallery = { images, index: 0, label: record.name || 'Seller' };
                layout.hero.classList.remove('hidden');
                app.setSellerProfileLuxuryGalleryIndex(0);
            }
        }
        const originalText = layout.originalDescription?.textContent || '';
        const text = String(config.personal ? record.bio || record.description || originalText : app.getMarketplaceFullDescription(record, record.desc || originalText)).trim();
        layout.description.innerHTML = app.renderTextWithPhoneLinks(text);
        layout.description.classList.toggle('hidden', !text);
        layout.description.removeAttribute('data-expandable-listing-text');
        layout.description.removeAttribute('data-expanded');
        app.bindPhoneLinkGuards(layout.description);
        layout.overview.hidden = !text;
        const expandable = text.length > 260 || text.split('\n').length > 4;
        layout.readmore.hidden = !expandable;
        setDescriptionExpanded(layout, !expandable);
        layout.rows = Array.from(layout.detailContent.querySelectorAll(config.rows)).filter(row => !row.classList.contains('hidden'));
        layout.groups = Array.from(layout.detailContent.querySelectorAll('.vehicle-modal-group, .service-modal-section'));
        layout.rows.forEach(row => { row.classList.add('cb-profile-detail-row'); row.classList.remove('listing-detail-hidden'); });
        layout.details.hidden = !layout.rows.length;
        layout.detailsToggle.hidden = layout.rows.length <= 6;
        setDetailsExpanded(layout, false);
        modal.querySelectorAll('[data-listing-toggle-for]').forEach(button => { button.hidden = true; });
        if (layout.message && /message|chat/i.test(layout.message.textContent)) layout.message.innerHTML = '<i class="fas fa-comment" aria-hidden="true"></i> Message';
        refreshSave(layout);
        syncGallery(layout, app);
        placeHeaderShare(modal, app);
        layout.scroll.scrollTop = 0;
    }

    function applyExisting(app, modal) {
        if (!modal || modal.classList.contains('hidden')) return;
        if (modal.id === 'luxury-ad-modal' && app.activeLuxuryAd?.sourceType === 'companionship') {
            modal.classList.add('native-sponsored-profile');
            app.syncNativeSponsoredProfile();
            modal.querySelector('#luxury-ad-image')?.style.removeProperty('display');
            const category = modal.querySelector('#luxury-ad-category');
            if (category) category.textContent = app.activeLuxuryAd.category || app.activeLuxuryAd.categoryLabel || 'Profile';
        }
        if (!modal.classList.contains('clean-blue-profile')) window.configureListingGalleryTabs?.(app, modal);
        if (modal.id === 'luxury-ad-modal' && app.activeLuxuryAd?.sourceType === 'companionship') {
            const legacyImage = modal.querySelector('#luxury-ad-image');
            if (legacyImage && !nativeImageGuards.has(legacyImage)) {
                const hideDuplicate = () => {
                    if (modal.classList.contains('clean-blue-profile') && app.activeLuxuryAd?.sourceType === 'companionship' && getComputedStyle(legacyImage).display !== 'none') {
                        legacyImage.style.setProperty('display', 'none', 'important');
                    }
                };
                new MutationObserver(hideDuplicate).observe(legacyImage, { attributes: true, attributeFilter: ['style'] });
                nativeImageGuards.add(legacyImage);
                hideDuplicate();
            }
            const heading = modal.querySelector('.gt-panel[id$="-details-panel"] > .gt-section-title');
            if (heading) heading.textContent = 'Profile details';
            const perks = modal.querySelector('#luxury-ad-perks.is-compatibility');
            const seller = modal.querySelector('.gt-panel[id$="-seller-panel"]');
            if (perks && seller) seller.prepend(perks);
        }
        placeHeaderShare(modal, app);
    }

    function install() {
        const app = window.app;
        if (!app) { window.setTimeout(install, 100); return; }
        if (app.allProfileCardsUiInstalled) return;
        app.allProfileCardsUiInstalled = true;
        const configureGallery = window.configureListingGalleryTabs;
        if (typeof configureGallery === 'function') {
            window.configureListingGalleryTabs = function (...args) {
                const result = configureGallery.apply(this, args);
                if (args[1]?.classList.contains('clean-blue-profile')) placeHeaderShare(args[1], args[0]);
                return result;
            };
        }
        const entries = Object.entries(configurations).map(([id, config]) => ({ id, method: config.open, apply: modal => applyUi(app, modal, config) }));
        entries.push(...[['luxury-ad-modal', 'openLuxuryAdModal'], ['marketplace-item-modal', 'openMarketplaceItemModal']].map(([id, method]) => ({ id, method, apply: modal => applyExisting(app, modal) })));
        for (const entry of entries) {
            const original = app[entry.method];
            if (typeof original !== 'function') continue;
            app[entry.method] = function (...args) {
                const modal = document.getElementById(entry.id);
                const layout = layouts.get(modal);
                layout?.rows.forEach(row => { row.hidden = false; });
                layout?.groups.forEach(group => { group.hidden = false; });
                const result = original.apply(this, args);
                entry.apply(modal);
                return result;
            };
            entry.apply(document.getElementById(entry.id));
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
})();
