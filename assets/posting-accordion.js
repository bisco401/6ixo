(function installPostingAccordion() {
    'use strict';

    const get = id => document.getElementById(id);
    const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const categoryNames = { jobs: 'Job details', services: 'Service details', real_estate: 'Property details', vehicles: 'Vehicle details', clothing: 'Fashion details' };
    const placementNames = { home_featured: 'Home featured banner', marketplace_featured: 'Marketplace featured banner', jobs_featured: 'Jobs featured banner', services_featured: 'Services featured banner', realestate_featured: 'Real Estate featured banner', vehicles_featured: 'Vehicles featured banner', electronics_featured: 'Electronics featured banner', today_deals_featured: "Today's Deals sponsored row" };
    // Inline icons keep field labels visible even when an external icon font fails.
    const fieldIconPaths = {
        category: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
        text: 'M4 5h16 M4 10h16 M4 15h10 M4 20h7',
        money: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
        globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c4 5 4 13 0 18-4-5-4-13 0-18',
        pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0 M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
        image: 'M4 3h16v18H4z M4 16l5-5 4 4 3-3 4 4 M10 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
        tag: 'M3 3h8l10 10-8 8L3 11z M8 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
        clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
        calendar: 'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2',
        building: 'M4 21V3h12v18 M16 9h4v12 M2 21h20 M8 7h4 M8 11h4 M8 15h4 M9 21v-3h2v3',
        briefcase: 'M3 7h18v14H3z M8 7V3h8v4 M3 12c6 4 12 4 18 0 M10 13h4v4h-4z',
        box: 'M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10 M8 4l9 5',
        check: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M8 12l3 3 5-6',
        phone: 'M8 3H4c-1 8 9 18 17 17v-4l-5-2-2 3c-4-2-6-4-8-8l3-2z',
        mail: 'M3 5h18v14H3z M3 5l9 7 9-7',
        link: 'M10 13l4-4 M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 9l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
        users: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3 M19 4a3 3 0 0 1 0 6 M21 14a6 6 0 0 1 2 5',
        home: 'M3 10l9-8 9 8 M5 9v12h14V9 M9 21v-7h6v7',
        ruler: 'M3 17L17 3l4 4L7 21z M13 7l2 2 M9 11l2 2 M5 15l2 2',
        gauge: 'M4 19a10 10 0 1 1 16 0 M12 13l5-5 M12 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4 M5 12h2 M12 5v2 M17 12h2',
        car: 'M5 10l2-6h10l2 6 M3 10h18v8H3z M5 18v3 M19 18v3 M6 14h2 M16 14h2',
        settings: 'M3 6h8 M15 6h6 M11 3v6 M3 12h2 M9 12h12 M5 9v6 M3 18h12 M19 18h2 M15 15v6',
        fuel: 'M4 21V3h9v18 M4 10h9 M2 21h13 M13 13h3v5a2 2 0 0 0 4 0V8l-3-3 M17 5v5h3',
        palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 2-2c0-1-2-2-2-3a2 2 0 0 1 2-2h3a3 3 0 0 0 3-3c0-5-4-8-9-8 M7 11h.01 M9 7h.01 M14 6h.01 M18 9h.01',
        star: 'M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z'
    };
    const fieldIconRules = [
        [/category|market-mode/, 'category'], [/title|headline/, 'text'],
        [/country/, 'globe'], [/city|address|postal|location|region/, 'pin'],
        [/image|photo|avatar|logo|video/, 'image'], [/phone|vehicle-contact|realestate-contact/, 'phone'],
        [/email/, 'mail'], [/link|website|instagram|url/, 'link'],
        [/price|pay|salary|fee|bid|ask|sale|budget/, 'money'],
        [/when|hours|duration|response|availability-window/, 'clock'],
        [/year|date|calendar|arrival|starts|ends|availability/, 'calendar'],
        [/badge|condition|status|verified/, 'check'], [/tag|vin|skill|brand/, 'tag'],
        [/company|employer|provider-name/, 'building'], [/make|doors|body-type/, 'car'],
        [/transmission|drivetrain/, 'settings'], [/fuel/, 'fuel'], [/color|colour/, 'palette'],
        [/job-type|experience|provider-role|employment/, 'briefcase'],
        [/audience|seller|provider|owner|seats|contact-method/, 'users'],
        [/sqft|square|size|dimensions/, 'ruler'], [/mileage/, 'gauge'],
        [/rating|review|amenities|perks/, 'star'], [/bedroom|bathroom|property|listing-type/, 'home'],
        [/model|quantity|delivery|shipping|fulfillment/, 'box']
    ];

    class PostingChapters {
        constructor(app, { preview = false, community = false } = {}) {
            this.app = app;
            this.preview = preview;
            this.community = community;
            this.idPrefix = community ? 'community-posting' : 'posting';
            this.form = get(community ? 'community-post-form' : 'post-item-form');
            this.modal = get(community ? 'community-post-modal' : 'post-item-modal');
            this.active = 0;
            this.completed = new Set();
            this.pendingChoice = null;
            this.selectedPlacement = '';
            this.setup();
            const renderUploads = this.app.renderMarketplaceUploads;
            if (!community && typeof renderUploads === 'function') {
                const controller = this;
                this.app.renderMarketplaceUploads = function (...args) {
                    const result = renderUploads.apply(this, args);
                    if (!this.marketplaceUploads?.length) controller.completed.delete(1);
                    controller.updateChapterNavigation();
                    controller.renderReview();
                    return result;
                };
            }
        }

        setup() {
            const primary = this.form.querySelector('.post-item-primary');
            if (!primary) return;
            this.form.noValidate = true;
            this.modal.classList.add('smart-posting', 'chapter-rail-posting');
            const original = Array.from(primary.children);
            const previewPanel = this.form.querySelector('.post-item-preview-panel');
            const submit = primary.querySelector('button[type="submit"]');
            this.buildChapterShell();
            const bodies = this.sections.map(section => section.querySelector('.posting-section-body'));
            const group = id => get(id)?.closest('.input-group');
            const categoryRow = document.createElement('div');
            categoryRow.className = 'posting-category-row';
            [group('item-category'), get('item-subcategory-group')].filter(Boolean).forEach(node => categoryRow.append(node));
            bodies[0].append(categoryRow);
            if (group('item-title')) bodies[0].append(group('item-title'));
            this.categorySuggestion = document.createElement('div');
            this.categorySuggestion.className = 'posting-category-suggestion';
            this.categorySuggestion.hidden = true;
            this.categorySuggestion.innerHTML = '<p role="status"></p><button type="button">Use Jobs</button>';
            bodies[0].append(this.categorySuggestion);
            this.categorySuggestion.querySelector('button').addEventListener('click', () => {
                const suggestion = this.app.getPostItemCategorySuggestion?.({ category: get('item-category')?.value, subcategory: get('item-subcategory')?.value, title: get('item-title')?.value });
                if (!suggestion) return;
                this.chooseCategory(suggestion.category);
                if (suggestion.subcategory) {
                    get('item-subcategory').value = suggestion.subcategory;
                    get('job-category').value = suggestion.subcategory;
                    get('item-subcategory').dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            const priceIds = new Set(['item-price', 'item-country', 'item-city', 'item-multi-locations', 'item-payment']);
            const reviewIds = new Set(['item-placement-group', 'item-promotion-targeting', 'item-cross-border-fields', 'item-featured-settings', 'item-auction-settings', 'item-auction-fields', 'featured-ad-fields']);
            original.forEach(node => {
                if (node === submit || bodies[0].contains(node)) return;
                if (node.classList.contains('market-upload-section') || node.contains(get('item-story-text'))) bodies[1].append(node);
                else if (reviewIds.has(node.id)) bodies[3].append(node);
                else if (Array.from(priceIds).some(id => node.contains(get(id)))) bodies[2].append(node);
                else bodies[0].append(node);
            });
            this.form.replaceChildren(this.shell);
            // Move the existing contact/delivery controls, retaining every ID and listener.
            ['item-delivery', 'item-fulfillment-meetup', 'item-shipping-fee', 'item-availability', 'item-contact-method', 'item-contact-phone', 'item-contact-email', 'item-contact-hours', 'item-link'].forEach(id => {
                const node = group(id);
                if (node && bodies[0].contains(node)) bodies[2].append(node);
            });
            this.review = document.createElement('div');
            this.review.className = 'posting-review';
            bodies[3].prepend(this.review);
            // Keep the original category-specific featured fields, including employer badges.
            const featuredDetails = document.createElement('details');
            featuredDetails.className = 'posting-featured-details';
            featuredDetails.innerHTML = '<summary>Featured card details & badges <span>Optional</span></summary>';
            ['service-featured-fields', 'jobs-featured-fields', 'featured-ad-fields'].forEach(id => {
                const node = get(id);
                if (node) featuredDetails.append(node);
            });
            bodies[3].append(featuredDetails);
            this.featuredDetails = featuredDetails;
            const promotionSettings = document.createElement('details');
            promotionSettings.className = 'posting-extra-details';
            promotionSettings.innerHTML = '<summary>Placement options <span>Optional</span></summary>';
            ['item-placement-group'].forEach(id => {
                const node = get(id);
                if (node) promotionSettings.append(node);
            });
            bodies[3].append(promotionSettings);
            const shipping = get('item-cross-border-fields');
            if (shipping) {
                const shippingSettings = document.createElement('details');
                shippingSettings.className = 'posting-extra-details';
                shippingSettings.innerHTML = '<summary>Sponsored arrival <span>Optional · $9.99 + tax</span></summary>';
                shippingSettings.append(shipping);
                bodies[3].append(shippingSettings);
            }
            if (previewPanel) {
                const previews = document.createElement('details');
                previews.className = 'posting-live-preview';
                previews.innerHTML = '<summary>See how your ad will look <span>Feed · Featured · Profile</span></summary>';
                previews.append(previewPanel);
                bodies[3].append(previews);
            }
            this.setupFooter(submit);
            this.form.addEventListener('input', () => { this.syncCategorySuggestion(); this.renderReview(); });
            this.form.addEventListener('change', event => {
                if (event.target.id === 'item-category') this.completed.clear();
                this.syncCategory();
            });
            this.form.addEventListener('reset', () => {
                this.completed.clear();
                this.closePayment();
                this.openStep(0, false);
                window.setTimeout(() => this.app.syncCrossBorderSponsoredFields(), 0);
            });
            this.payment = document.createElement('section');
            this.payment.className = 'posting-payment-screen';
            this.payment.hidden = true;
            this.payment.setAttribute('aria-label', 'Choose promotion and payment');
            this.modal.querySelector('.modal-content').append(this.payment);
            this.syncCategory();
            this.openStep(0, false);
        }

        buildChapterShell(titles, subtitles, railSubtitles) {
            titles ??= ['Ad details', 'Photos & video', 'Price & location', 'Review & promote'];
            subtitles ??= ['The essentials and your category-specific details', 'Photos, camera uploads, and an optional story', 'Pricing, delivery, and how buyers reach you', 'Check your ad and choose whether to feature it'];
            railSubtitles ??= ['Category, copy & badges', 'Show what makes it special', 'Price, area & contact', 'Final check & visibility'];
            this.shell = document.createElement('div');
            this.shell.className = 'posting-shell';
            this.shell.innerHTML = `<aside class="posting-chapter-rail"><div class="posting-rail-intro"><p class="posting-eyebrow">PLACE YOUR AD</p><h2>Make it<br>stand out.</h2><p>Your listing, in four chapters.</p></div><nav aria-label="Ad chapters"><ol class="posting-chapter-list"></ol></nav><div class="posting-rail-note"><span class="posting-draft-state"><i class="fas fa-cloud" aria-hidden="true"></i> Draft on this device</span><p>You can return to any chapter before publishing.</p></div></aside><div class="posting-workspace"><div class="posting-main"><div class="posting-intro"><div><p class="posting-eyebrow">NEW LISTING</p><h2>Create your listing.</h2><p>The right details help the right people find you.</p></div><span class="posting-chapter-counter">Chapter 1 of 4</span></div><div class="posting-progress" role="progressbar" aria-label="Posting progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"><span></span></div><div class="posting-sections"></div></div></div>`;
            this.main = this.shell.querySelector('.posting-main');
            this.chapterButtons = titles.map((title, i) => {
                const item = document.createElement('li');
                item.innerHTML = `<button class="posting-chapter-button" type="button" aria-controls="${this.idPrefix}-chapter-${i}" id="${this.idPrefix}-step-toggle-${i}"><span class="posting-chapter-number" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><span class="posting-chapter-copy"><span class="posting-chapter-title">${title}</span><small>${railSubtitles[i]}</small><span class="posting-chapter-state"></span></span></button>`;
                const button = item.querySelector('button');
                button.addEventListener('click', () => this.openStep(i));
                this.shell.querySelector('.posting-chapter-list').append(item);
                return button;
            });
            this.sections = titles.map((title, i) => {
                const section = document.createElement('section');
                section.className = 'posting-section';
                section.id = `${this.idPrefix}-chapter-${i}`;
                section.dataset.postingStep = String(i);
                section.hidden = i !== 0;
                section.setAttribute('aria-labelledby', `${this.idPrefix}-chapter-title-${i}`);
                section.innerHTML = `<div class="posting-chapter-header"><p class="posting-eyebrow">CHAPTER ${String(i + 1).padStart(2, '0')}</p><h2 class="posting-step-title" id="${this.idPrefix}-chapter-title-${i}" tabindex="-1">${title}</h2><p>${subtitles[i]}</p></div><div class="posting-section-body" id="${this.idPrefix}-step-body-${i}"></div>`;
                this.shell.querySelector('.posting-sections').append(section);
                return section;
            });
        }

        setupFooter(submit) {
            this.footer = document.createElement('div');
            this.footer.className = 'posting-footer';
            this.footer.innerHTML = '<button class="posting-save" type="button"><i class="far fa-bookmark" aria-hidden="true"></i> Save draft</button><div><button class="posting-back" type="button" hidden>Back</button></div>';
            this.next = submit || document.createElement('button');
            this.next.className = 'posting-next';
            this.next.type = 'button';
            this.footer.querySelector('div').append(this.next);
            this.shell.querySelector('.posting-workspace').append(this.footer);
            this.form.replaceChildren(this.shell);
            const buyerPaymentLabel = this.form.querySelector('label[for="item-payment"]');
            if (buyerPaymentLabel) buyerPaymentLabel.textContent = 'How buyers can pay you';
            this.setupCategoryPicker();
            this.footer.querySelector('.posting-save').addEventListener('click', () => this.saveDraft());
            this.footer.querySelector('.posting-back').addEventListener('click', () => this.openStep(Math.max(0, this.active - 1)));
            this.next.addEventListener('click', event => {
                if (this.active === 3) return;
                // Changing this button to submit must not submit the same click.
                event.preventDefault();
                if (this.validateStep(this.active)) {
                    this.completed.add(this.active);
                    this.openStep(this.active + 1);
                }
            });
            this.form.addEventListener('submit', event => {
                if (this.active === 3) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                this.next.click();
            }, true);
        }

        saveDraft() {
            this.app.flushPostItemDraftSave?.();
            this.showStatus('Draft text saved. Reselect photos and video after reloading.');
        }

        showStatus(message) {
            const status = this.shell.querySelector('.posting-draft-state');
            status.textContent = message;
            status.setAttribute('role', 'status');
        }

        setupCategoryPicker(selectId = 'item-category', prefix = 'posting') {
            this.categorySelect = get(selectId);
            if (!this.categorySelect) return;
            this.categoryPicker = document.createElement('div');
            this.categoryPicker.className = 'posting-category-picker';
            this.categoryPicker.innerHTML = `<button id="${prefix}-category-trigger" class="posting-category-trigger" type="button" aria-expanded="false" aria-controls="${prefix}-category-options" aria-labelledby="${prefix}-category-label ${prefix}-category-value"><span id="${prefix}-category-value"></span><i class="fas fa-chevron-down" aria-hidden="true"></i></button><div id="${prefix}-category-options" class="posting-category-options" role="group" aria-label="Choose main category" hidden></div>`;
            const label = this.form.querySelector(`label[for="${selectId}"]`);
            if (label) {
                label.id = `${prefix}-category-label`;
                label.htmlFor = `${prefix}-category-trigger`;
            }
            this.categorySelect.hidden = true;
            this.categorySelect.closest('.input-group')?.classList.add('posting-category-field');
            this.categorySelect.after(this.categoryPicker);
            this.categoryTrigger = this.categoryPicker.querySelector('button');
            this.categoryOptions = this.categoryPicker.querySelector('.posting-category-options');
            this.categoryTrigger.addEventListener('click', () => this.setCategoryPickerOpen(this.categoryOptions.hidden));
            this.categoryOptions.addEventListener('click', event => {
                const choice = event.target.closest('[data-posting-category]');
                if (choice) this.chooseCategory(choice.dataset.postingCategory);
            });
            this.categoryPicker.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setCategoryPickerOpen(false);
                    this.categoryTrigger.focus({ preventScroll: true });
                } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    this.setCategoryPickerOpen(true);
                    const choices = Array.from(this.categoryOptions.querySelectorAll('button'));
                    const index = choices.indexOf(document.activeElement);
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : event.key === 'ArrowDown' ? (index + 1) % choices.length : (index <= 0 ? choices.length : index) - 1;
                    choices[next]?.focus({ preventScroll: true });
                }
            });
            // No timer, hover selection, or wheel-driven category changes.
            this.modal.addEventListener('click', event => {
                if (!this.categoryPicker.contains(event.target)) this.setCategoryPickerOpen(false);
            });
            this.syncCategoryPicker();
        }

        syncCategoryPicker() {
            if (!this.categorySelect) return;
            const available = Array.from(this.categorySelect.options).filter(option => option.value && !option.disabled && !option.hidden);
            const signature = available.map(option => `${option.value}:${option.textContent}`).join('|');
            if (signature !== this.categorySignature) {
                this.categoryOptions.innerHTML = available.map(option => `<button type="button" data-posting-category="${html(option.value)}" aria-pressed="false"><span>${html(option.textContent)}</span>${option.value === 'community' ? '<small>Events, groups & local posts</small>' : ''}</button>`).join('');
                this.categorySignature = signature;
            }
            this.categoryValue = this.categorySelect.value;
            this.categoryTrigger.querySelector('span').textContent = this.categorySelect.selectedOptions[0]?.textContent || 'Select category';
            this.categoryOptions.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.postingCategory === this.categoryValue)));
            if (this.categoryValue) this.categoryTrigger.removeAttribute('aria-invalid');
        }

        setCategoryPickerOpen(open) {
            if (!this.categoryOptions) return;
            this.categoryOptions.hidden = !open;
            this.categoryTrigger.setAttribute('aria-expanded', String(open));
            if (open) {
                const anchor = this.categoryTrigger.getBoundingClientRect();
                const width = Math.min(Math.max(anchor.width, 280), window.innerWidth - 24);
                this.categoryOptions.style.width = `${width}px`;
                this.categoryOptions.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
                this.categoryOptions.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - this.categoryOptions.offsetHeight - 12))}px`;
            }
        }

        chooseCategory(value) {
            const option = Array.from(this.categorySelect.options).find(option => option.value === value && !option.disabled && !option.hidden);
            if (!option) return;
            this.setCategoryPickerOpen(false);
            if (value !== this.categorySelect.value) {
                this.categorySelect.value = value;
                this.categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
            this.syncCategoryPicker();
            if (!this.modal.classList.contains('hidden')) this.categoryTrigger.focus({ preventScroll: true });
        }

        openStep(index, scroll = true) {
            this.setCategoryPickerOpen(false);
            this.active = Math.max(0, Math.min(3, index));
            this.sections.forEach((section, i) => {
                const active = i === this.active;
                section.classList.toggle('is-open', active);
                section.classList.toggle('is-complete', this.completed.has(i));
                section.hidden = !active;
            });
            this.updateChapterNavigation();
            this.footer.querySelector('.posting-back').hidden = this.active === 0;
            this.next.type = this.active === 3 ? 'submit' : 'button';
            this.next.innerHTML = this.active === 3 ? 'Publish ad <i class="fas fa-check" aria-hidden="true"></i>' : 'Continue <i class="fas fa-arrow-right" aria-hidden="true"></i>';
            this.renderReview();
            if (scroll) {
                this.main.scrollTop = 0;
                this.sections[this.active].querySelector('.posting-step-title').focus({ preventScroll: true });
            }
        }

        updateChapterNavigation() {
            this.chapterButtons.forEach((button, i) => {
                const active = i === this.active;
                const complete = this.completed.has(i);
                button.classList.toggle('is-active', active);
                button.classList.toggle('is-complete', complete);
                if (active) button.setAttribute('aria-current', 'step');
                else button.removeAttribute('aria-current');
                button.querySelector('.posting-chapter-state').textContent = active ? 'Current chapter' : complete ? 'Complete' : '';
                button.querySelector('.posting-chapter-number').innerHTML = complete && !active ? '<i class="fas fa-check" aria-hidden="true"></i>' : String(i + 1).padStart(2, '0');
            });
            this.shell.querySelector('.posting-chapter-counter').textContent = `Chapter ${this.active + 1} of 4`;
            const progress = this.shell.querySelector('.posting-progress');
            progress.setAttribute('aria-valuenow', String(this.completed.size));
            progress.querySelector('span').style.width = `${this.completed.size * 25}%`;
        }

        fieldsForValidation(container) {
            return Array.from(container.querySelectorAll('input, select, textarea')).filter(field => field.willValidate && !field.closest('.hidden, .posting-irrelevant-field'));
        }

        revealInvalid(field) {
            const step = field.closest('[data-posting-step]');
            if (step) this.openStep(Number(step.dataset.postingStep));
            if ((field === this.categorySelect || field.id === 'item-category') && this.categoryTrigger) {
                this.categoryTrigger.setAttribute('aria-invalid', 'true');
                this.setCategoryPickerOpen(true);
                this.categoryTrigger.focus();
                this.app.showNotification?.('Choose a main category to continue.', { type: 'warn', force: true });
                return false;
            }
            for (let parent = field.parentElement; parent && parent !== this.form; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS') parent.open = true;
            }
            field.reportValidity();
            return false;
        }

        validateStep(index) {
            const invalid = this.fieldsForValidation(this.sections[index]).find(field => !field.checkValidity());
            if (invalid) return this.revealInvalid(invalid);
            return index === 1 ? this.validatePhotos() : true;
        }

        validateAll() {
            const invalid = this.fieldsForValidation(this.form).find(field => !field.checkValidity());
            return invalid ? this.revealInvalid(invalid) : this.validatePhotos();
        }

        validatePhotos() {
            if (this.app.marketplaceUploads?.length) return true;
            this.completed.delete(1);
            this.openStep(1);
            this.app.showNotification?.('Add at least one photo before publishing your ad.', { type: 'warn', force: true });
            get('market-upload-device-btn')?.focus();
            return false;
        }

        syncCategory() {
            this.syncCategoryPicker();
            this.refreshFieldIcons();
            this.syncCategorySuggestion();
            const category = get('item-category')?.value || '';
            this.sections[0].querySelector('.posting-step-title').textContent = categoryNames[category] || 'Ad details';
            this.chapterButtons[0].querySelector('.posting-chapter-title').textContent = categoryNames[category] || 'Ad details';
            const buyerPayment = get('item-payment')?.closest('.input-group');
            const buyerPaymentAllowed = this.app.getCurrentPostItemCommerceUiState?.()?.buyerPayment ?? !['real_estate', 'jobs', 'dating', 'community'].includes(category);
            if (buyerPayment) buyerPayment.hidden = !buyerPaymentAllowed;
            const pricingSubtitle = this.sections[2].querySelector('.posting-chapter-header > p:last-child');
            if (pricingSubtitle) pricingSubtitle.textContent = category === 'real_estate'
                ? 'Property price, location, viewings, and how people reach you'
                : category === 'jobs' ? 'Pay, work location, start date, and how applicants reach you'
                : category === 'services' || (category === 'vehicles' && ['repairs', 'detailing'].includes(get('item-subcategory')?.value))
                    ? 'Pricing, service area, availability, and how clients reach you'
                    : 'Pricing, delivery, and how buyers reach you';
            ['item-condition', 'item-brand', 'item-model', 'item-quantity'].forEach(id => {
                const field = get(id);
                const irrelevant = category === 'real_estate' || (category === 'vehicles' && ['item-condition', 'item-brand', 'item-model'].includes(id));
                field?.closest('.input-group')?.classList.toggle('posting-irrelevant-field', irrelevant);
            });
            this.featuredDetails.hidden = !['service-featured-fields', 'jobs-featured-fields', 'featured-ad-fields'].some(id => {
                const node = get(id);
                return node && !node.classList.contains('hidden');
            });
            this.updateChapterNavigation();
            this.renderReview();
        }

        syncCategorySuggestion() {
            if (!this.categorySuggestion) return;
            const suggestion = this.app.getPostItemCategorySuggestion?.({ category: get('item-category')?.value, subcategory: get('item-subcategory')?.value, title: get('item-title')?.value });
            const previousMessage = this.categorySuggestion.querySelector('p').textContent;
            const aiStatus = get('post-ai-status');
            if (!suggestion && previousMessage && aiStatus?.textContent === previousMessage) aiStatus.textContent = 'Uses category, location, price, and safety cues.';
            this.categorySuggestion.hidden = !suggestion;
            this.categorySuggestion.querySelector('p').textContent = suggestion?.message || '';
            this.categorySuggestion.querySelector('button').textContent = suggestion?.action || 'Use Jobs';
        }

        refreshFieldIcons() {
            this.form.querySelectorAll?.('.posting-section-body label[for]').forEach(label => {
                const control = get(label.htmlFor);
                if (!control || ['checkbox', 'radio'].includes(control.type)) return;
                if (control.tagName === 'BUTTON' && control !== this.categoryTrigger) return;
                label.classList.add('posting-field-label');
                // Retain existing category icons; native category updates can
                // replace label text, so reapply missing icons after every sync.
                if (label.querySelector('svg, i')) return;
                const hint = `${label.htmlFor} ${label.textContent}`.toLowerCase();
                const name = fieldIconRules.find(([pattern]) => pattern.test(hint))?.[1] || 'text';
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                for (const [attribute, value] of Object.entries({ class: 'posting-field-icon', width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(attribute, value);
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', fieldIconPaths[name]);
                icon.append(path);
                label.prepend(icon);
            });
        }

        renderReview() {
            if (!this.review) return;
            const value = id => String(get(id)?.value || '').trim();
            const category = value('item-category');
            const text = id => get(id)?.selectedOptions?.[0]?.textContent?.trim() || value(id);
            const badge = category === 'jobs' ? value('job-status') || value('job-featured-badge') : category === 'services' ? value('service-badge') : category === 'real_estate' ? value('realestate-badge') : '';
            let price = value('item-price') || 'Add your price';
            if (category === 'jobs' && value('item-price')) price = `${value('item-price')}${value('job-pay-max') ? `–${value('job-pay-max')}` : ''} / hour`;
            if (category === 'real_estate' && value('item-price') && value('realestate-price-term')) price += ` · ${text('realestate-price-term')}`;
            const photoCount = this.app.marketplaceUploads?.length || 0;
            const rows = [['Category', [text('item-category'), value('item-subcategory') ? text('item-subcategory') : ''].filter(Boolean).join(' › '), 0], [category === 'jobs' ? 'Pay' : 'Price', price, 2], ['Location', [value('item-city'), value('item-country')].filter(Boolean).join(', ') || 'Add your location', 2], ['Photos', `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`, 1]];
            const detailRows = category === 'jobs' ? [['Company', value('job-company')], ['Employment', text('job-type')], ['Experience', value('job-experience')]] : category === 'services' ? [['Provider', value('service-provider')], ['Duration', value('service-duration')], ['Availability', value('service-availability-window')]] : category === 'real_estate' ? [['Property', text('realestate-property-type')], ['Bedrooms', value('realestate-bedrooms')], ['Bathrooms', value('realestate-bathrooms')]] : category === 'vehicles' ? [['Vehicle', [value('vehicle-year'), value('vehicle-make'), value('vehicle-model')].filter(Boolean).join(' ')], ['Mileage', value('vehicle-mileage') ? `${value('vehicle-mileage')} km` : '']] : [['Brand', value('item-brand')], ['Model', value('item-model')], ['Condition', text('item-condition')]];
            detailRows.filter(([, content]) => content && !content.startsWith('Select ')).forEach(([label, content]) => rows.push([label, content, 0]));
            if (badge) rows.push(['Badge', badge, 0]);
            const selectedBadges = category === 'services' ? this.app.getSelectedServiceLabels?.() : this.app.getSelectedMarketplaceCategoryBadges?.();
            if (selectedBadges?.length) rows.push(['Selected badges', selectedBadges.join(' · '), 0]);
            if (this.isPromotionRequested()) {
                rows.push(['Promotion country', this.app.getPostItemPromotionTarget().country || 'Choose a country', 3]);
                if (get('item-sponsored-arrival')?.checked) rows.push(['Sponsored arrival', value('item-destination-country') || 'Add the destination country', 3]);
            }
            this.review.innerHTML = `<div class="posting-review-heading"><div><p class="posting-eyebrow">YOUR AD</p><h4>${html(value('item-title') || 'Your listing title')}</h4><p>${html(value('item-description') || 'Your description will appear here.')}</p></div></div><div class="posting-review-rows">${rows.map(([label, content, step]) => `<div><span>${label}</span><p>${html(content)}</p><button type="button" data-review-edit="${step}" aria-label="Edit ${label.toLowerCase()}">Edit</button></div>`).join('')}</div>`;
            this.review.querySelectorAll('[data-review-edit]').forEach(button => button.addEventListener('click', () => this.openStep(Number(button.dataset.reviewEdit))));
        }

        isPromotionRequested() {
            const placement = String(get('item-placement')?.value || '');
            return Boolean(get('item-featured')?.checked || placement.endsWith('_featured') || placement === 'premium' || get('item-sponsored-arrival')?.checked);
        }

        getPromotionOptions() {
            const category = get('item-category')?.value || '';
            const shortTerm = category === 'real_estate' && get('realestate-listing-type')?.value === 'for_rent_short';
            const sponsoredArrival = Boolean(get('item-sponsored-arrival')?.checked);
            const crossBorder = sponsoredArrival;
            const arrivalPlacement = sponsoredArrival ? this.app.getFeaturedPlacementForStoredListing({ category }, '') : '';
            if (arrivalPlacement) {
                // The existing publisher derives this placement for shipped items,
                // even when ordinary category promotion controls are unavailable.
                const fee = this.app.getPromotionFeeForPlacement(arrivalPlacement);
                return fee.amount > 0 ? [{ key: arrivalPlacement, name: placementNames[arrivalPlacement] || fee.label, ...fee }] : [];
            }
            return Array.from(get('item-placement')?.options || []).filter(option => {
                const key = option.value;
                // Preserve the native Fashion and sponsored-arrival placement rules.
                if (category === 'clothing' && !crossBorder && key !== 'today_deals_featured') return false;
                return key.endsWith('_featured') && !option.disabled && !option.hidden && !['community_featured', 'companionship_featured', 'dating_featured'].includes(key) && !(shortTerm && key === 'today_deals_featured');
            }).map(option => ({ key: option.value, name: placementNames[option.value] || option.textContent.split('·')[0].trim(), ...this.app.getPromotionFeeForPlacement(option.value) })).filter(option => option.amount > 0);
        }

        async prepareSubmission() {
            const category = get('item-category')?.value || '';
            // Dedicated social/profile flows retain their existing checkout.
            if (['dating', 'community', 'companionship'].includes(category)) return true;
            if (!this.isPromotionRequested()) return true;
            if (this.pendingChoice) return false;
            const options = this.getPromotionOptions();
            if (!options.length) {
                this.showStatus('Choose an available featured placement.');
                return false;
            }
            const defaults = { jobs: 'jobs_featured', services: 'services_featured', real_estate: 'realestate_featured', vehicles: 'vehicles_featured', electronics: 'electronics_featured' };
            this.categoryPlacement = defaults[category] || (category === 'clothing' ? 'today_deals_featured' : 'marketplace_featured');
            const current = get('item-placement')?.value || '';
            this.selectedPlacement = options.some(option => option.key === current) ? current : options.some(option => option.key === defaults[category]) ? defaults[category] : options[0].key;
            this.paymentMethod = this.app.defaultPromotionPaymentMethod || 'credit_card';
            const promise = new Promise(resolve => { this.pendingChoice = resolve; });
            this.form.hidden = true;
            this.payment.hidden = false;
            this.renderPayment(options);
            this.payment.querySelector('.posting-payment-back')?.focus();
            return promise;
        }

        renderPayment(options = this.getPromotionOptions()) {
            const selected = options.find(option => option.key === this.selectedPlacement);
            const allowRegular = !get('item-sponsored-arrival')?.checked;
            const audience = this.app.getPostItemPromotionTarget();
            const commonKeys = [this.categoryPlacement, this.selectedPlacement, 'home_featured', 'marketplace_featured', 'today_deals_featured'];
            const cards = Array.from(new Set(commonKeys)).map(key => options.find(option => option.key === key)).filter(Boolean);
            const money = amount => `US$${Number(amount).toFixed(2)}`;
            this.payment.innerHTML = `<div class="posting-payment-shell"><button class="posting-payment-back" type="button"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to your ad</button><div class="posting-payment-heading"><p class="posting-eyebrow">PROMOTE YOUR AD</p><h2>Find the right spotlight.</h2><p>Choose where your ad appears. Your featured placement starts after payment.</p></div><div class="posting-payment-layout"><div><label class="posting-payment-label" for="posting-promotion-category">Promote on</label><select id="posting-promotion-category">${options.map(option => `<option value="${html(option.key)}" ${option.key === this.selectedPlacement ? 'selected' : ''}>${html(option.name)} · ${money(option.amount)} + tax</option>`).join('')}${allowRegular ? `<option value="regular" ${this.selectedPlacement === 'regular' ? 'selected' : ''}>Regular category feed · Free</option>` : ''}</select><div class="posting-plan-grid" role="group" aria-label="Promotion placement options">${cards.map(option => `<label class="posting-plan ${option.key === this.selectedPlacement ? 'is-selected' : ''}"><input type="radio" name="posting-promotion-plan" value="${html(option.key)}" ${option.key === this.selectedPlacement ? 'checked' : ''}><span><strong>${html(option.name)}</strong><small>7-day placement</small><b>${money(option.amount)} <span>+ tax</span></b></span></label>`).join('')}${allowRegular ? `<label class="posting-plan ${this.selectedPlacement === 'regular' ? 'is-selected' : ''}"><input type="radio" name="posting-promotion-plan" value="regular" ${this.selectedPlacement === 'regular' ? 'checked' : ''}><span><strong>Regular ad</strong><small>Standard category feed</small><b>Free</b></span></label>` : ''}</div><div class="input-group posting-promotion-country" ${selected ? '' : 'hidden'}><label class="posting-payment-label" for="posting-promotion-country">Promote in country</label><input type="text" id="posting-promotion-country" maxlength="80" list="global-country-datalist" value="${html(audience.country)}" placeholder="Choose a country" required><p>Your ad will be promoted to buyers in this country.</p></div><div class="posting-payment-method" ${selected ? '' : 'hidden'}><label class="posting-payment-label" for="posting-promotion-method">Preferred payment option</label><select id="posting-promotion-method">${[['credit_card','Credit card'],['debit_card','Debit card'],['apple_pay','Apple Pay'],['google_pay','Google Pay']].map(([key,label])=>`<option value="${key}" ${this.paymentMethod===key?'selected':''}>${label}</option>`).join('')}</select><p>Available cards and wallets are confirmed by Stripe on the secure payment screen.</p></div></div><aside class="posting-order"><p class="posting-eyebrow">ORDER SUMMARY</p><h3>${html(get('item-title')?.value || 'Your ad')}</h3><p class="posting-order-category">${html(get('item-category')?.selectedOptions?.[0]?.textContent || '')}</p><div><span>Placement</span><strong>${html(selected?.name || 'Regular category feed')}</strong></div>${selected ? `<div><span>Promotion country</span><strong id="posting-order-country">${html(audience.country || 'Choose a country')}</strong></div>` : ''}<div><span>Duration</span><strong>${selected ? '7 days' : 'Standard listing'}</strong></div><div><span>Base price</span><strong>${selected ? money(selected.amount) : 'Free'}</strong></div><div><span>Tax</span><strong>${selected ? 'Calculated at checkout' : '—'}</strong></div><div class="posting-order-total"><span>Subtotal (USD)</span><strong>${selected ? money(selected.amount) : '$0.00'}</strong></div><button class="posting-checkout" type="button">${selected ? 'Continue to secure payment' : 'Publish free ad'} <i class="fas fa-arrow-right" aria-hidden="true"></i></button><p class="posting-secure-note"><i class="fas fa-lock" aria-hidden="true"></i> ${this.preview ? 'Preview only · no charge or live posting' : 'Review your full total before paying'}</p></aside></div></div>`;
            this.payment.querySelector('.posting-payment-back').addEventListener('click', () => this.closePayment());
            this.payment.querySelector('#posting-promotion-category').addEventListener('change', event => {
                this.selectedPlacement = event.target.value;
                this.renderPayment(options);
                this.payment.querySelector('#posting-promotion-category')?.focus();
            });
            this.payment.querySelectorAll('[name="posting-promotion-plan"]').forEach(radio => radio.addEventListener('change', () => {
                this.selectedPlacement = radio.value;
                this.renderPayment(options);
                Array.from(this.payment.querySelectorAll('[name="posting-promotion-plan"]')).find(input => input.value === this.selectedPlacement)?.focus();
            }));
            this.payment.querySelector('#posting-promotion-method').addEventListener('change', event => { this.paymentMethod = event.target.value; });
            const countryInput = this.payment.querySelector('#posting-promotion-country');
            countryInput?.addEventListener('input', () => {
                const target = get('item-target-country');
                if (target) {
                    target.value = countryInput.value.trim();
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const summary = this.payment.querySelector('#posting-order-country');
                if (summary) summary.textContent = this.app.getPostItemPromotionTarget().country || 'Choose a country';
            });
            this.payment.querySelector('.posting-checkout').addEventListener('click', () => {
                const key = this.selectedPlacement;
                if (key !== 'regular') {
                    if (!countryInput.checkValidity()) { countryInput.reportValidity(); return; }
                    const target = get('item-target-country');
                    if (target) {
                        target.value = countryInput.value.trim();
                        target.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                // Snapshot the native controls for the existing publishing and Stripe flow.
                const featured = get('item-featured');
                const placement = get('item-placement');
                if (featured) featured.checked = key !== 'regular';
                if (placement) placement.value = key === 'regular' ? this.app.getBasePlacementForFeaturedPlacement(placement.value, get('item-category')?.value) : key;
                this.app.defaultPromotionPaymentMethod = this.paymentMethod;
                this.app.updatePostItemCategoryFields(get('item-category')?.value || '');
                const resolve = this.pendingChoice;
                this.pendingChoice = null;
                this.form.hidden = false;
                this.payment.hidden = true;
                resolve?.(true);
            });
            this.payment.scrollTop = 0;
        }

        closePayment() {
            const resolve = this.pendingChoice;
            this.pendingChoice = null;
            if (this.form) this.form.hidden = false;
            if (this.payment) this.payment.hidden = true;
            resolve?.(false);
        }

        open() {
            this.closePayment();
            this.completed.clear();
            this.syncCategory();
            this.openStep(0, false);
        }
    }

    class CommunityPostingChapters extends PostingChapters {
        constructor(app, options = {}) {
            super(app, { ...options, community: true });
            this.draftKey = this.preview ? 'sixo_community_preview_draft' : 'sixo_community_post_draft_v1';
            this.draftFields = ['community-post-category', 'community-post-title-input', 'community-post-summary', 'community-post-tags', 'community-post-image', 'community-post-when', 'community-post-price', 'community-post-city', 'community-post-country'];
        }

        setup() {
            if (!get('community-post-category')?.closest) return;
            const submit = this.form.querySelector('button[type="submit"]');
            const previews = this.form.querySelector('.community-composer-preview-section');
            this.form.noValidate = true;
            this.form.classList.add('post-item-form');
            this.modal.classList.add('smart-posting', 'chapter-rail-posting');
            this.buildChapterShell(
                ['Community details', 'Photo', 'Price & location', 'Review & publish'],
                ['Choose your Community category and tell people what is happening', 'Add an optional image for your Community post', 'Add timing, a price or note, and where it is happening', 'Check your details before publishing to Community'],
                ['Category, copy & tags', 'Show what is happening', 'Timing, price & area', 'Final check & visibility']
            );
            const bodies = this.sections.map(section => section.querySelector('.posting-section-body'));
            const move = (id, step) => {
                const field = get(id)?.closest('.auth-field');
                if (field) { field.classList.add('input-group'); bodies[step].append(field); }
            };
            const categoryRow = document.createElement('div');
            categoryRow.className = 'posting-category-row';
            const mainGroup = document.createElement('div');
            mainGroup.className = 'input-group';
            mainGroup.innerHTML = '<label for="community-post-main-category">Main category</label><select id="community-post-main-category" required></select>';
            const main = mainGroup.querySelector('select');
            Array.from(get('item-category')?.options || []).filter(option => option.value && !option.disabled && !option.hidden).forEach(option => {
                const copy = option.cloneNode(true);
                copy.selected = copy.defaultSelected = option.value === 'community';
                main.append(copy);
            });
            main.value = 'community';
            const subcategory = get('community-post-category').closest('.auth-field');
            subcategory.classList.add('input-group');
            categoryRow.append(mainGroup, subcategory);
            bodies[0].append(categoryRow);
            ['community-post-title-input', 'community-post-summary', 'community-post-tags'].forEach(id => move(id, 0));
            move('community-post-image', 1);
            const photoNote = document.createElement('p');
            photoNote.className = 'form-helper';
            photoNote.textContent = 'Use an image URL for your Community post. You can also publish without a photo.';
            bodies[1].append(photoNote);
            ['community-post-when', 'community-post-price', 'community-post-city', 'community-post-country'].forEach(id => move(id, 2));
            this.review = document.createElement('div');
            this.review.className = 'posting-review';
            bodies[3].append(this.review);
            if (previews) {
                const details = document.createElement('details');
                details.className = 'posting-live-preview';
                details.innerHTML = '<summary>See how your ad will look <span>Feed · Profile</span></summary>';
                previews.querySelector('.community-composer-section-head')?.remove();
                details.append(previews);
                bodies[3].append(details);
            }
            const content = this.modal.querySelector('.modal-content');
            const oldBody = this.form.parentElement;
            content.append(this.form);
            oldBody.remove();
            this.setupFooter(submit);
            const close = get('community-post-close');
            const header = this.modal.querySelector('.chat-header');
            header.classList.add('has-mac-controls');
            header.innerHTML = '<div class="mac-window-controls" aria-label="Community post window controls"></div><div class="posting-community-heading"><i class="fas fa-plus" aria-hidden="true"></i><h4 id="community-post-title">Place your ad</h4></div>';
            close.className = 'mac-dot mac-red';
            close.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';
            header.querySelector('.mac-window-controls').append(close);
            this.form.addEventListener('submit', event => {
                if (this.active === 3 && !this.validateAll()) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
            }, true);
            const changed = event => {
                const step = event.target.closest('[data-posting-step]');
                if (step) this.completed.delete(Number(step.dataset.postingStep));
                this.saveDraft(false);
                this.updateChapterNavigation();
                this.renderReview();
            };
            this.form.addEventListener('input', changed);
            this.form.addEventListener('change', changed);
            this.form.addEventListener('reset', () => {
                this.completed.clear();
                this.openStep(0, false);
            });
            this.openStep(0, false);
        }

        setupCategoryPicker() {
            super.setupCategoryPicker('community-post-main-category', 'community-posting');
            this.categorySelect.addEventListener('change', event => {
                const category = event.target.value;
                if (category === 'community') return;
                event.stopPropagation();
                this.app.closeCommunityPostModal();
                this.app.openSharedPostForm({ category, source: 'global_header' });
            });
        }

        validatePhotos() { return true; }

        syncCategory() {
            this.syncCategoryPicker();
            this.refreshFieldIcons();
            this.updateChapterNavigation();
            this.renderReview();
        }

        renderReview() {
            if (!this.review) return;
            const value = id => get(id)?.value.trim() || '';
            const category = get('community-post-category')?.selectedOptions?.[0]?.textContent || 'Choose a Community category';
            const rows = [
                ['Category', `Community › ${category}`, 0],
                ['Photo', value('community-post-image') || 'No photo added', 1],
                ['When', value('community-post-when') || 'Not specified', 2],
                ['Price', value('community-post-price') || 'Not specified', 2],
                ['Location', [value('community-post-city'), value('community-post-country')].filter(Boolean).join(', ') || 'Add your location', 2],
                ['Tags', value('community-post-tags') || 'No tags added', 0]
            ];
            this.review.innerHTML = `<div class="posting-review-heading"><div><p class="posting-eyebrow">YOUR AD</p><h4>${html(value('community-post-title-input') || 'Your Community post title')}</h4><p>${html(value('community-post-summary') || 'Your summary will appear here.')}</p></div></div><div class="posting-review-rows">${rows.map(([label, content, step]) => `<div><span>${label}</span><p>${html(content)}</p><button type="button" data-review-edit="${step}" aria-label="Edit ${label.toLowerCase()}">Edit</button></div>`).join('')}</div>`;
            this.review.querySelectorAll('[data-review-edit]').forEach(button => button.addEventListener('click', () => this.openStep(Number(button.dataset.reviewEdit))));
        }

        saveDraft(announce = true) {
            const values = Object.fromEntries(this.draftFields.map(id => [id, get(id)?.value || '']));
            try {
                window.localStorage.setItem(this.draftKey, JSON.stringify(values));
                if (announce) this.showStatus('Community draft saved on this device.');
                return true;
            } catch {
                if (announce) this.app.showNotification?.('Your draft could not be saved on this device.', { type: 'warn', force: true });
                return false;
            }
        }

        restoreDraft() {
            try {
                const values = JSON.parse(window.localStorage.getItem(this.draftKey) || '{}');
                this.draftFields.forEach(id => {
                    const field = get(id);
                    if (field && typeof values[id] === 'string') field.value = values[id];
                });
            } catch {}
        }

        clearDraft() {
            try { window.localStorage.removeItem(this.draftKey); } catch {}
        }

        open() {
            this.restoreDraft();
            super.open();
        }
    }

    window.SixoPostingAccordion = {
        attach(app, options = {}) {
            if (!app || !get('post-item-form')) return null;
            if (!app.postItemAccordion) app.postItemAccordion = new PostingChapters(app, options);
            return app.postItemAccordion;
        },
        attachCommunity(app, options = {}) {
            if (!app || typeof get('community-post-form')?.querySelector !== 'function') return null;
            if (!app.communityPostAccordion) app.communityPostAccordion = new CommunityPostingChapters(app, { preview: Boolean(app.postItemAccordion?.preview), ...options });
            return app.communityPostAccordion;
        }
    };
    window.addEventListener('sixo:app-ready', () => window.SixoPostingAccordion.attach(window.app));
    if (window.app) window.SixoPostingAccordion.attach(window.app);
})();
