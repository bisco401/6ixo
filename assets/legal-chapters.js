(() => {
    'use strict';
    const sections = Array.from(document.querySelectorAll('.legal-section[id]'));
    const contents = document.querySelector('.legal-toc');
    const panel = document.querySelector('.legal-toc-panel');
    if (!sections.length || !contents || !panel) return;
    const links = Array.from(contents.querySelectorAll('a[href^="#"]'));
    const menu = document.querySelector('.legal-menu');
    const status = panel.querySelector('.legal-toc-status');
    const mobile = window.matchMedia('(max-width: 850px)');
    let activeId = '';
    let frame = 0;
    let navigationTarget = null;
    function setActive(section) {
        if (!section || section.id === activeId) return;
        activeId = section.id;
        sections.forEach(item => item.classList.toggle('is-active', item === section));
        links.forEach(link => {
            const active = link.getAttribute('href') === '#' + section.id;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        });
        if (status) status.textContent = section.dataset.chapter + ' / ' + String(sections.length).padStart(2, '0');
    }
    function updatePosition() {
        frame = 0;
        if (navigationTarget) {
            const distance = Math.abs(window.scrollY - navigationTarget.position);
            if (distance <= 4) navigationTarget.settled = true;
            if (navigationTarget.settled && distance > 4) navigationTarget = null;
            else { setActive(navigationTarget.section); return; }
        }
        const threshold = mobile.matches ? 115 : 90;
        let current = sections[0];
        for (const section of sections) {
            if (section.getBoundingClientRect().top <= threshold) current = section;
            else break;
        }
        if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 12) current = sections[sections.length - 1];
        setActive(current);
    }
    function requestPosition() { if (!frame) frame = window.requestAnimationFrame(updatePosition); }
    function navigateTo(section) {
        if (!section) return;
        const margin = parseFloat(window.getComputedStyle(section).scrollMarginTop) || 0;
        const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const position = Math.max(0, Math.min(maximum, window.scrollY + section.getBoundingClientRect().top - margin));
        navigationTarget = { section, position, settled: false };
        setActive(section);
    }
    function resumeReading() { navigationTarget = null; requestPosition(); }
    function applyViewport() { panel.open = !mobile.matches; requestPosition(); }
    function closeMenu(restoreFocus) {
        if (!menu || !menu.open) return;
        menu.open = false;
        if (restoreFocus) menu.querySelector('summary').focus();
    }
    contents.addEventListener('click', event => {
        const link = event.target.closest('a[href^="#"]');
        if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const section = sections.find(item => '#' + item.id === link.getAttribute('href'));
        if (!section) return;
        navigateTo(section);
        if (mobile.matches) {
            panel.open = false;
            window.requestAnimationFrame(() => {
                section.setAttribute('tabindex', '-1');
                section.focus({ preventScroll: true });
            });
        }
    });
    panel.addEventListener('toggle', () => {
        if (!mobile.matches && !panel.open) panel.open = true;
        if (panel.open) closeMenu(false);
    });
    if (menu) menu.addEventListener('toggle', () => { if (menu.open && mobile.matches) panel.open = false; });
    document.addEventListener('click', event => {
        const marker = event.target.closest('.legal-chapter-marker');
        if (marker && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) navigateTo(marker.closest('.legal-section'));
        if (menu && !menu.contains(event.target)) closeMenu(false);
        if (mobile.matches && panel.open && !panel.contains(event.target)) panel.open = false;
    });
    document.addEventListener('keydown', event => {
        if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(event.key)) resumeReading();
        if (event.key !== 'Escape') return;
        if (menu && menu.open) closeMenu(true);
        else if (mobile.matches && panel.open) { panel.open = false; panel.querySelector('summary').focus(); }
    });
    window.addEventListener('scroll', requestPosition, { passive: true });
    window.addEventListener('resize', requestPosition, { passive: true });
    window.addEventListener('wheel', resumeReading, { passive: true });
    window.addEventListener('touchmove', resumeReading, { passive: true });
    window.addEventListener('hashchange', () => {
        navigateTo(sections.find(section => '#' + section.id === window.location.hash));
        requestPosition();
    });
    window.addEventListener('load', requestPosition, { once: true });
    if (mobile.addEventListener) mobile.addEventListener('change', applyViewport);
    else mobile.addListener(applyViewport);
    applyViewport();
    document.documentElement.classList.add('legal-enhanced');
    const initial = sections.find(section => '#' + section.id === window.location.hash);
    if (initial) navigateTo(initial);
    else setActive(sections[0]);
})();
