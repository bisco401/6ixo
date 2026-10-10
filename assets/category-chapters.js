(() => {
  const nav = document.querySelector('.chapter-nav');
  if (!nav) return;
  const links = [...nav.querySelectorAll('[data-chapter]')];
  const panels = [...document.querySelectorAll('[data-chapter-panel]')];
  const status = document.querySelector('.chapter-status');
  function showChapter(id, announce = false) {
    if (!panels.some(panel => panel.dataset.chapterPanel === id)) id = 'listings';
    panels.forEach(panel => { panel.hidden = panel.dataset.chapterPanel !== id; });
    links.forEach(link => {
      if (link.dataset.chapter === id) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    if (announce) status.textContent = `${links.find(link => link.dataset.chapter === id).querySelector('strong').textContent} chapter selected.`;
  }
  function fromHash() {
    const target = document.getElementById(location.hash.slice(1));
    const panel = target?.closest('[data-chapter-panel]');
    showChapter(panel?.dataset.chapterPanel || 'listings');
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(link.hash.slice(1));
    const panel = target?.closest('[data-chapter-panel]');
    if (!panel) return;
    event.preventDefault();
    if (location.hash !== link.hash) history.pushState(null, '', link.hash);
    showChapter(panel.dataset.chapterPanel, true);
    if (!nav.contains(link)) target.scrollIntoView({ block: 'start' });
  });
  window.addEventListener('popstate', fromHash);
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
