/* Navigation for the homepage's three-card featured row. */
(() => {
    const row = document.getElementById('home-featured-carousel');
    if (!row) return;
    const section = row.closest('#home-featured-ads-strip');
    const nav = document.createElement('nav');
    nav.className = 'home-featured-row-nav';
    nav.setAttribute('aria-label', 'Featured listings');
    nav.hidden = true;
    const previous = document.createElement('button');
    const next = document.createElement('button');
    const count = document.createElement('span');
    previous.type = next.type = 'button';
    previous.textContent = '‹';
    next.textContent = '›';
    previous.setAttribute('aria-label', 'Previous featured listings');
    next.setAttribute('aria-label', 'Next featured listings');
    previous.setAttribute('aria-controls', row.id);
    next.setAttribute('aria-controls', row.id);
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
    nav.append(previous, count, next);
    row.after(nav);

    let frame = 0;
    function cards() {
        return [...row.querySelectorAll('.featured-ad-card')].filter(card => card.getBoundingClientRect().width > 0);
    }
    function update() {
        frame = 0;
        const items = cards();
        const overflow = row.scrollWidth - row.clientWidth;
        nav.hidden = items.length <= 3 || overflow < 2;
        previous.disabled = row.scrollLeft < 2;
        next.disabled = row.scrollLeft >= overflow - 2;
        if (!items.length) return;
        const left = row.getBoundingClientRect().left;
        let first = items.reduce((nearest, card, index) =>
            Math.abs(card.getBoundingClientRect().left - left) < Math.abs(items[nearest].getBoundingClientRect().left - left) ? index : nearest, 0);
        first = Math.min(first, Math.max(0, items.length - 3));
        const text = `${first + 1}–${Math.min(first + 3, items.length)} / ${items.length}`;
        if (count.textContent !== text) count.textContent = text;
    }
    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }
    function move(direction) {
        const items = cards();
        if (!items.length) return;
        const gap = parseFloat(getComputedStyle(row).columnGap) || 8;
        const step = 3 * (items[0].getBoundingClientRect().width + gap);
        const left = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, row.scrollLeft + direction * step));
        // The shared carousel settles on individual cards; moving immediately
        // keeps its settling handler from interrupting a three-card advance.
        row.scrollTo({ left, behavior: 'instant' });
        schedule();
    }
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    row.addEventListener('keydown', event => {
        if (event.target !== row || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        move(event.key === 'ArrowLeft' ? -1 : 1);
    }, true);
    row.addEventListener('scroll', schedule, { passive: true });
    new ResizeObserver(schedule).observe(row);
    new MutationObserver(schedule).observe(row, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'data-featured-country-hidden']
    });
    new MutationObserver(schedule).observe(section, { attributes: true, attributeFilter: ['class', 'hidden'] });
    schedule();
})();
