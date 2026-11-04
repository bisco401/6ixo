/* Navigation belongs to the listing row, independently of each photo gallery. */
(() => {
    'use strict';

    const rowIds = ['home-recommended-row', 'home-recent-row', 'marketplace-trending', 'marketplace-recommended', 'marketplace-recent'];

    for (const id of rowIds) {
        const row = document.getElementById(id);
        const section = row?.closest('.marketplace-section');
        const header = section?.querySelector('.marketplace-section-header');
        if (!row || !header || row.dataset.feedBrowsing === '1') continue;
        row.dataset.feedBrowsing = '1';
        section.classList.add('feed-browsing-section');
        const name = header.querySelector('h3')?.textContent.trim() || 'Listings';

        const arrows = document.createElement('div');
        arrows.className = 'feed-browsing-arrows';
        const makeArrow = (direction, label, icon) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'feed-browsing-arrow';
            button.setAttribute('aria-label', `${label}: ${name}`);
            button.setAttribute('aria-controls', id);
            button.innerHTML = `<i class="fas fa-chevron-${icon}" aria-hidden="true"></i>`;
            button.disabled = true;
            button.addEventListener('click', () => move(direction));
            arrows.append(button);
            return button;
        };
        const previous = makeArrow(-1, 'Previous listings', 'left');
        const next = makeArrow(1, 'Next listings', 'right');
        header.append(arrows);

        const footer = document.createElement('div');
        footer.className = 'feed-browsing-footer';
        const meta = document.createElement('div');
        meta.className = 'feed-browsing-meta';
        const label = document.createElement('label');
        label.htmlFor = `${id}-scroll`;
        label.textContent = 'Browse listings';
        const counter = document.createElement('output');
        counter.setAttribute('for', label.htmlFor);
        counter.textContent = '0 listings';
        meta.append(label, counter);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = label.htmlFor;
        slider.className = 'feed-browsing-scroll';
        slider.min = '0';
        slider.max = '1000';
        slider.step = '1';
        slider.value = '0';
        slider.disabled = true;
        slider.setAttribute('aria-label', `Scroll through ${name.toLowerCase()}`);
        slider.setAttribute('aria-controls', id);
        footer.append(meta, slider);
        row.after(footer);

        let cards = [];
        let frame = 0;
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); });
        };
        const resize = new ResizeObserver(schedule);
        resize.observe(row);
        resize.observe(slider);

        function refreshCards() {
            cards.forEach(card => resize.unobserve(card));
            cards = Array.from(row.children).filter(card => card.matches('.marketplace-item'));
            cards.forEach(card => {
                resize.observe(card);
                const info = card.querySelector('.item-info');
                if (!info || info.querySelector('.feed-preview-location')) return;
                const location = [card.dataset.listingCity, card.dataset.listingCountry].filter(Boolean).join(', ')
                    || card.querySelector('.marketplace-seller-row .item-location')?.textContent.trim()
                    || '';
                if (location) {
                    const text = document.createElement('div');
                    text.className = 'feed-preview-location';
                    text.textContent = location;
                    info.append(text);
                }
            });
            schedule();
        }

        function update() {
            if (!row.clientWidth) return; // ResizeObserver refreshes when a hidden screen opens.
            const visibleCards = cards.filter(card => card.getClientRects().length && !card.hidden);
            const max = Math.max(0, row.scrollWidth - row.clientWidth);
            const left = Math.min(max, Math.max(0, row.scrollLeft));
            previous.disabled = !visibleCards.length || left <= 1;
            next.disabled = !visibleCards.length || left >= max - 1;
            slider.disabled = max <= 1 || !visibleCards.length;
            slider.value = String(max ? Math.round(left / max * 1000) : 0);
            slider.style.setProperty('--feed-scroll-thumb', `${Math.min(slider.clientWidth, Math.max(32, slider.clientWidth * row.clientWidth / Math.max(1, row.scrollWidth)))}px`);
            const bounds = row.getBoundingClientRect();
            // Count mostly visible cards; a sliver of the next card is a browsing cue.
            const shown = visibleCards.map((card, index) => ({ box: card.getBoundingClientRect(), index: index + 1 }))
                .filter(({ box }) => Math.min(box.right, bounds.right) - Math.max(box.left, bounds.left) >= Math.min(box.width, bounds.width) / 2);
            const text = shown.length
                ? `${shown[0].index}–${shown[shown.length - 1].index} of ${visibleCards.length}`
                : `${visibleCards.length} listings`;
            counter.textContent = text;
            slider.setAttribute('aria-valuetext', `${text} listings`);
        }

        function move(direction) {
            const first = cards.find(card => card.getClientRects().length && !card.hidden);
            if (!first) return;
            const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
            const stride = first.getBoundingClientRect().width + gap;
            const distance = Math.max(1, Math.floor(row.clientWidth / stride)) * stride;
            row.scrollBy({ left: direction * distance, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }

        slider.addEventListener('input', () => {
            row.classList.add('feed-browsing-scrubbing');
            row.scrollTo({ left: Number(slider.value) / 1000 * Math.max(0, row.scrollWidth - row.clientWidth), behavior: 'instant' });
            update();
        });
        const finishScrubbing = () => { row.classList.remove('feed-browsing-scrubbing'); schedule(); };
        slider.addEventListener('change', finishScrubbing);
        slider.addEventListener('blur', finishScrubbing);
        row.addEventListener('scroll', schedule, { passive: true });
        // The app replaces cards after filtering, saving, or opening another category.
        new MutationObserver(refreshCards).observe(row, { childList: true });
        refreshCards();
    }
})();
