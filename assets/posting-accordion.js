(function installPostingAccordion() {
    'use strict';

    const get = id => document.getElementById(id);
    const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const categoryNames = { jobs: 'Job details', services: 'Service details', real_estate: 'Property details', vehicles: 'Vehicle details', clothing: 'Fashion details' };
    const placementNames = { home_featured: 'Home featured banner', marketplace_featured: 'Marketplace featured banner', jobs_featured: 'Jobs featured banner', services_featured: 'Services featured banner', realestate_featured: 'Real Estate featured banner', vehicles_featured: 'Vehicles featured banner', electronics_featured: 'Electronics featured banner', today_deals_featured: "Today's Deals sponsored row" };

    class PostingChapters {
        constructor(app, { preview = false } = {}) {
            this.app = app;
            this.preview = preview;
            this.form = get('post-item-form');
            this.modal = get('post-item-modal');
            this.active = 0;
            this.completed = new Set();
            this.pendingChoice = null;
            this.selectedPlacement = '';
            this.setup();
            const renderUploads = this.app.renderMarketplaceUploads;
            if (typeof renderUploads === 'function') {
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
            this.shell = document.createElement('div');
            this.shell.className = 'posting-shell';
            this.shell.innerHTML = `<aside class="posting-chapter-rail"><div class="posting-rail-intro"><p class="posting-eyebrow">PLACE YOUR AD</p><h2>Make it<br>stand out.</h2><p>Your listing, in four chapters.</p></div><nav aria-label="Ad chapters"><ol class="posting-chapter-list"></ol></nav><div class="posting-rail-note"><span class="posting-draft-state"><i class="fas fa-cloud" aria-hidden="true"></i> Draft on this device</span><p>You can return to any chapter before publishing.</p></div></aside><div class="posting-workspace"><div class="posting-main"><div class="posting-intro"><div><p class="posting-eyebrow">NEW LISTING</p><h2>Create your listing.</h2><p>The right details help the right people find you.</p></div><span class="posting-chapter-counter">Chapter 1 of 4</span></div><div class="posting-progress" role="progressbar" aria-label="Posting progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"><span></span></div><div class="posting-sections"></div></div></div>`;
            this.main = this.shell.querySelector('.posting-main');
            const titles = ['Ad details', 'Photos & video', 'Price & location', 'Review & promote'];
            const subtitles = ['The essentials and your category-specific details', 'Photos, camera uploads, and an optional story', 'Pricing, delivery, and how buyers reach you', 'Check your ad and choose whether to feature it'];
            const railSubtitles = ['Category, copy & badges', 'Show what makes it special', 'Price, area & contact', 'Final check & visibility'];
            this.chapterButtons = titles.map((title, i) => {
                const item = document.createElement('li');
                item.innerHTML = `<button class="posting-chapter-button" type="button" aria-controls="posting-chapter-${i}" id="posting-step-toggle-${i}"><span class="posting-chapter-number" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><span class="posting-chapter-copy"><span class="posting-chapter-title">${title}</span><small>${railSubtitles[i]}</small><span class="posting-chapter-state"></span></span></button>`;
                const button = item.querySelector('button');
                button.addEventListener('click', () => this.openStep(i));
                this.shell.querySelector('.posting-chapter-list').append(item);
                return button;
            });
            this.sections = titles.map((title, i) => {
                const section = document.createElement('section');
                section.className = 'posting-section';
                section.id = `posting-chapter-${i}`;
                section.dataset.postingStep = String(i);
                section.hidden = i !== 0;
                section.setAttribute('aria-labelledby', `posting-chapter-title-${i}`);
                section.innerHTML = `<div class="posting-chapter-header"><p class="posting-eyebrow">CHAPTER ${String(i + 1).padStart(2, '0')}</p><h2 class="posting-step-title" id="posting-chapter-title-${i}" tabindex="-1">${title}</h2><p>${subtitles[i]}</p></div><div class="posting-section-body" id="posting-step-body-${i}"></div>`;
                this.shell.querySelector('.posting-sections').append(section);
                return section;
            });
            const bodies = this.sections.map(section => section.querySelector('.posting-section-body'));
            const group = id => get(id)?.closest('.input-group');
            const categoryRow = document.createElement('div');
            categoryRow.className = 'posting-category-row';
            [group('item-category'), get('item-subcategory-group')].filter(Boolean).forEach(node => categoryRow.append(node));
            bodies[0].append(categoryRow);
            if (group('item-title')) bodies[0].append(group('item-title'));
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
            promotionSettings.innerHTML = '<summary>Audience & placement <span>Optional</span></summary>';
            ['item-placement-group', 'item-promotion-targeting'].forEach(id => {
                const node = get(id);
                if (node) promotionSettings.append(node);
            });
            bodies[3].append(promotionSettings);
            const shipping = get('item-cross-border-fields');
            if (shipping) {
                const shippingSettings = document.createElement('details');
                shippingSettings.className = 'posting-extra-details';
                shippingSettings.innerHTML = '<summary>Shipping to another country <span>Optional</span></summary>';
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
            this.footer.querySelector('.posting-save').addEventListener('click', () => {
                this.app.flushPostItemDraftSave?.();
                this.showStatus('Draft text saved. Reselect photos and video after reloading.');
            });
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
            this.form.addEventListener('input', () => this.renderReview());
            this.form.addEventListener('change', event => {
                if (event.target.id === 'item-category') this.completed.clear();
                this.syncCategory();
            });
            this.form.addEventListener('reset', () => {
                this.completed.clear();
                this.closePayment();
                this.openStep(0, false);
            });
            this.payment = document.createElement('section');
            this.payment.className = 'posting-payment-screen';
            this.payment.hidden = true;
            this.payment.setAttribute('aria-label', 'Choose promotion and payment');
            this.modal.querySelector('.modal-content').append(this.payment);
            this.syncCategory();
            this.openStep(0, false);
        }

        showStatus(message) {
            const status = this.shell.querySelector('.posting-draft-state');
            status.textContent = message;
            status.setAttribute('role', 'status');
        }

        openStep(index, scroll = true) {
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
            const category = get('item-category')?.value || '';
            this.sections[0].querySelector('.posting-step-title').textContent = categoryNames[category] || 'Ad details';
            this.chapterButtons[0].querySelector('.posting-chapter-title').textContent = categoryNames[category] || 'Ad details';
            const buyerPayment = get('item-payment')?.closest('.input-group');
            if (buyerPayment) buyerPayment.hidden = category === 'jobs';
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
            this.review.innerHTML = `<div class="posting-review-heading"><div><p class="posting-eyebrow">YOUR AD</p><h4>${html(value('item-title') || 'Your listing title')}</h4><p>${html(value('item-description') || 'Your description will appear here.')}</p></div></div><div class="posting-review-rows">${rows.map(([label, content, step]) => `<div><span>${label}</span><p>${html(content)}</p><button type="button" data-review-edit="${step}" aria-label="Edit ${label.toLowerCase()}">Edit</button></div>`).join('')}</div>`;
            this.review.querySelectorAll('[data-review-edit]').forEach(button => button.addEventListener('click', () => this.openStep(Number(button.dataset.reviewEdit))));
        }

        isPromotionRequested() {
            const placement = String(get('item-placement')?.value || '');
            return Boolean(get('item-featured')?.checked || placement.endsWith('_featured') || placement === 'premium' || get('item-transit-status')?.value);
        }

        getPromotionOptions() {
            const category = get('item-category')?.value || '';
            const shortTerm = category === 'real_estate' && get('realestate-listing-type')?.value === 'for_rent_short';
            const sponsoredArrival = Boolean(get('item-transit-status')?.value);
            const crossBorder = sponsoredArrival || Boolean(get('item-destination-country')?.value.trim());
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
            const allowRegular = !get('item-transit-status')?.value;
            const commonKeys = [this.categoryPlacement, this.selectedPlacement, 'home_featured', 'marketplace_featured', 'today_deals_featured'];
            const cards = Array.from(new Set(commonKeys)).map(key => options.find(option => option.key === key)).filter(Boolean);
            const money = amount => `US$${Number(amount).toFixed(2)}`;
            this.payment.innerHTML = `<div class="posting-payment-shell"><button class="posting-payment-back" type="button"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to your ad</button><div class="posting-payment-heading"><p class="posting-eyebrow">PROMOTE YOUR AD</p><h2>Find the right spotlight.</h2><p>Choose where your ad appears. Your featured placement starts after payment.</p></div><div class="posting-payment-layout"><div><label class="posting-payment-label" for="posting-promotion-category">Promote on</label><select id="posting-promotion-category">${options.map(option => `<option value="${html(option.key)}" ${option.key === this.selectedPlacement ? 'selected' : ''}>${html(option.name)} · ${money(option.amount)} + tax</option>`).join('')}${allowRegular ? `<option value="regular" ${this.selectedPlacement === 'regular' ? 'selected' : ''}>Regular category feed · Free</option>` : ''}</select><div class="posting-plan-grid" role="group" aria-label="Promotion placement options">${cards.map(option => `<label class="posting-plan ${option.key === this.selectedPlacement ? 'is-selected' : ''}"><input type="radio" name="posting-promotion-plan" value="${html(option.key)}" ${option.key === this.selectedPlacement ? 'checked' : ''}><span><strong>${html(option.name)}</strong><small>7-day placement</small><b>${money(option.amount)} <span>+ tax</span></b></span></label>`).join('')}${allowRegular ? `<label class="posting-plan ${this.selectedPlacement === 'regular' ? 'is-selected' : ''}"><input type="radio" name="posting-promotion-plan" value="regular" ${this.selectedPlacement === 'regular' ? 'checked' : ''}><span><strong>Regular ad</strong><small>Standard category feed</small><b>Free</b></span></label>` : ''}</div><div class="posting-payment-method" ${selected ? '' : 'hidden'}><label class="posting-payment-label" for="posting-promotion-method">Preferred payment option</label><select id="posting-promotion-method">${[['credit_card','Credit card'],['debit_card','Debit card'],['apple_pay','Apple Pay'],['google_pay','Google Pay']].map(([key,label])=>`<option value="${key}" ${this.paymentMethod===key?'selected':''}>${label}</option>`).join('')}</select><p>Available cards and wallets are confirmed by Stripe on the secure payment screen.</p></div></div><aside class="posting-order"><p class="posting-eyebrow">ORDER SUMMARY</p><h3>${html(get('item-title')?.value || 'Your ad')}</h3><p class="posting-order-category">${html(get('item-category')?.selectedOptions?.[0]?.textContent || '')}</p><div><span>Placement</span><strong>${html(selected?.name || 'Regular category feed')}</strong></div><div><span>Duration</span><strong>${selected ? '7 days' : 'Standard listing'}</strong></div><div><span>Base price</span><strong>${selected ? money(selected.amount) : 'Free'}</strong></div><div><span>Tax</span><strong>${selected ? 'Calculated at checkout' : '—'}</strong></div><div class="posting-order-total"><span>Subtotal (USD)</span><strong>${selected ? money(selected.amount) : '$0.00'}</strong></div><button class="posting-checkout" type="button">${selected ? 'Continue to secure payment' : 'Publish free ad'} <i class="fas fa-arrow-right" aria-hidden="true"></i></button><p class="posting-secure-note"><i class="fas fa-lock" aria-hidden="true"></i> ${this.preview ? 'Preview only · no charge or live posting' : 'Review your full total before paying'}</p></aside></div></div>`;
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
            this.payment.querySelector('.posting-checkout').addEventListener('click', () => {
                const key = this.selectedPlacement;
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

    window.SixoPostingAccordion = {
        attach(app, options = {}) {
            if (!app || !get('post-item-form')) return null;
            if (!app.postItemAccordion) app.postItemAccordion = new PostingChapters(app, options);
            return app.postItemAccordion;
        }
    };
    window.addEventListener('sixo:app-ready', () => window.SixoPostingAccordion.attach(window.app));
    if (window.app) window.SixoPostingAccordion.attach(window.app);
})();
