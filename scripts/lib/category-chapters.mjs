import { escapeHtml as esc } from './seo.mjs';

export const categoryRoutes = [
  ['listings', 'Current listings'], ['cars-for-sale', 'Cars for sale'], ['car-rentals', 'Car rentals'],
  ['auto-parts', 'Auto parts'], ['short-term-rentals', 'Short-term rentals'], ['real-estate', 'Real estate'],
  ['apartments-for-rent', 'Apartments for rent'], ['electronics', 'Electronics'], ['phones-for-sale', 'Phones for sale'],
  ['fashion', 'Fashion'], ['buy-and-sell', 'Buy and sell'], ['services', 'Local services'],
  ['jobs', 'Jobs'], ['community', 'Community'], ['events', 'Events'], ['rewards', 'Rewards']
];
const introductions = {
  listings: 'Browse marketplace listings with photos, prices and seller locations.',
  'cars-for-sale': 'Explore vehicles and compare price, mileage and condition.',
  'car-rentals': 'Explore rental vehicles for your next trip.',
  'auto-parts': 'Find parts and accessories for your vehicle.',
  'short-term-rentals': 'Explore furnished homes and rooms for a short stay.',
  'real-estate': 'Explore properties for rent or sale and compare your options.',
  'apartments-for-rent': 'Compare apartments and condos for rent, with prices, photos and locations.',
  electronics: 'Explore phones, computers, accessories and everyday tech.',
  'phones-for-sale': 'Compare new and used phones, prices, photos and seller locations.',
  fashion: 'Explore clothing, shoes and accessories.',
  'buy-and-sell': 'Explore everyday finds and local opportunities.',
  services: 'Explore local providers for the work you need.',
  jobs: 'Explore roles and local work opportunities.',
  community: 'Discover local connections, activities and community posts.',
  events: 'Explore local events, meetups and things to do.',
  rewards: 'Browse community reward cases and read the details carefully.'
};

const countryBlock = nav => `<!-- COUNTRY SEARCHES: START -->\n<div class="home-country-browse"><h3 id="home-country-searches">Browse by country</h3>${nav}</div>\n<!-- COUNTRY SEARCHES: END -->`;

export function homeCountryLinks(hubs) {
  return countryBlock(`<nav class="home-seo-links home-country-links" aria-label="Marketplace countries">${hubs.map(group => `<a href="${esc(group.base)}"><strong>${esc(group.country)}</strong><span>${group.items.length} listings</span></a>`).join('')}</nav>`);
}

export function homeCategoryLinks(countryMarkup = '') {
  const countryNav = countryMarkup.match(/<nav\b[^>]*class="[^"]*\bhome-country-links\b[^"]*"[^>]*>[\s\S]*?<\/nav>/)?.[0];
  return `<details class="home-seo-hub"><summary id="home-seo-hub-title">Browse categories<span class="home-seo-chevron" aria-hidden="true"></span></summary><nav class="home-seo-links" aria-label="Marketplace categories">${categoryRoutes.map(([slug, label]) => `<a href="/${slug}/"><strong>${esc(label)}</strong></a>`).join('')}</nav>${countryNav ? countryBlock(countryNav) : ''}</details>\n`;
}

// These static pages contain nested sections. Match balanced elements rather than
// stopping at the first closing tag and accidentally dropping their content.
function takeElement(source, tag, matches) {
  const openings = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  for (const opening of source.matchAll(openings)) {
    if (!matches(opening[0])) continue;
    const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    tokens.lastIndex = opening.index;
    let depth = 0;
    for (let token; (token = tokens.exec(source));) {
      depth += token[0].startsWith('</') ? -1 : 1;
      if (!depth) return { html: source.slice(opening.index, tokens.lastIndex), start: opening.index, end: tokens.lastIndex };
    }
    throw new Error(`Unclosed ${tag} in category page`);
  }
  return null;
}

const hasClass = (opening, name) => (opening.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).includes(name);
const removeElement = (source, element) => source.slice(0, element.start) + source.slice(element.end);

export function categoryChapters(html, slug, label) {
  const main = html.match(/(<main\b[^>]*>)([\s\S]*?)(<\/main>)/i);
  if (!main) throw new Error(`Missing main in ${slug}`);
  let content = main[2].replace(/<!-- CATEGORY CHAPTERS: START -->([\s\S]*?)<!-- CATEGORY CHAPTERS: END -->/g, (_, wrapped) => {
    return ['LISTINGS', 'GUIDE', 'SAFETY'].map(name => {
      const match = wrapped.match(new RegExp(`<!-- CHAPTER ${name}: START -->([\\s\\S]*?)<!-- CHAPTER ${name}: END -->`));
      if (!match) throw new Error(`Missing ${name} chapter in ${slug}`);
      return match[1];
    }).join('\n');
  });
  content = content.replace(/<!-- CHAPTER EMPTY STATE: START -->[\s\S]*?<!-- CHAPTER EMPTY STATE: END -->/g, '');
  content = content.replace(/<!-- CHAPTER INVENTORY HEADING --><h2>Current listings<\/h2>/g, '');
  content = content.replace(/<!-- CHAPTER FILTERS: START -->\s*<details[^>]*>\s*<summary[^>]*>[\s\S]*?<\/summary>([\s\S]*?)<\/details>\s*<!-- CHAPTER FILTERS: END -->/g, '$1');

  const hero = takeElement(content, 'section', opening => hasClass(opening, 'hero') || hasClass(opening, 'listing-index-hero'));
  if (!hero) throw new Error(`Missing category heading in ${slug}`);
  content = removeElement(content, hero);
  let header = hero.html;
  const highlight = takeElement(header, 'aside', () => true);
  if (highlight) header = removeElement(header, highlight);
  const browseHref = header.match(/\bdata-marketplace-href="([^"]+)"/)?.[1] || header.match(/<a\b[^>]*href="([^"]+)"/)?.[1] || '/listings/';
  header = header.replace(/^<section\b[^>]*>/, opening => opening.replace(/\s+data-marketplace-href="[^"]*"/, '').replace(/>$/, ` data-marketplace-href="${esc(browseHref.replaceAll('&amp;', '&'))}">`));
  header = header.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/, `<h1>${esc(label)}</h1>`);
  const actions = takeElement(header, 'div', opening => hasClass(opening, 'hero-actions'));
  if (actions) header = removeElement(header, actions);
  const introduction = header.match(/<p\b[^>]*class="hero-lede"[^>]*>[\s\S]*?<\/p>/)?.[0] || header.match(/<\/h1>\s*(<p\b[^>]*>[\s\S]*?<\/p>)/)?.[1];
  let context = '';
  if (introduction && introductions[slug]) {
    const short = `<p class="hero-lede">${esc(introductions[slug])}</p>`;
    if (introduction !== short && !content.includes(introduction)) context = `<section class="section"><h2>About ${esc(label.toLowerCase())}</h2>${introduction}</section>`;
    header = header.replace(introduction, short);
  }

  let inventory = '';
  content = content.replace(/<!-- CURRENT INVENTORY: START -->[\s\S]*?<!-- CURRENT INVENTORY: END -->/g, block => { inventory += block; return ''; });
  const currentListings = takeElement(content, 'section', opening => /\bid="current-listings"/.test(opening));
  if (currentListings) {
    inventory += '<!-- CHAPTER INVENTORY HEADING --><h2>Current listings</h2>' + currentListings.html;
    content = removeElement(content, currentListings);
  }

  const filters = [], pagination = [];
  for (let nav; (nav = takeElement(content, 'nav', opening => hasClass(opening, 'listing-filters') || hasClass(opening, 'listing-pagination')));) {
    (hasClass(nav.html.match(/^<nav\b[^>]*>/)[0], 'listing-pagination') ? pagination : filters).push(nav.html);
    content = removeElement(content, nav);
  }
  let count = '';
  content = content.replace(/<p>\s*(?:Showing [\s\S]*?|No matching listings are published[\s\S]*?)<\/p>/, paragraph => { count = paragraph; return ''; });
  const safetySection = takeElement(content, 'section', opening => hasClass(opening, 'safety'));
  const safety = safetySection?.html || '<section class="section safety"><h2>Check before you commit</h2><p>Confirm availability, condition, identity and the complete price with the seller or organiser before making a payment.</p><p><a href="/safety/">Read the 6ixo safety guide</a></p></section>';
  if (safetySection) content = removeElement(content, safetySection);
  const guide = (highlight?.html || '') + context + (actions?.html || '') + content.trim() || '<section class="section"><h2>Compare your options</h2><p>Compare photos, prices and locations. Read the full description and ask the seller about condition, availability and what is included.</p><p><a href="/listing-rules/">Read the marketplace listing rules</a></p></section>';
  if (!inventory) {
    inventory = `<!-- CHAPTER EMPTY STATE: START --><div class="chapter-empty"><h2>Browse ${esc(label.toLowerCase())}</h2><p>Open the marketplace to view current posts and availability.</p><a class="button" href="${esc(browseHref.replaceAll('&amp;', '&'))}">Open marketplace</a></div><!-- CHAPTER EMPTY STATE: END -->`;
  }
  const filterHtml = filters.length ? `<!-- CHAPTER FILTERS: START --><details class="chapter-filters"><summary>Browse by category or location</summary>${filters.join('\n')}</details><!-- CHAPTER FILTERS: END -->` : '';
  const firstLabel = slug === 'rewards' ? 'Cases' : 'Listings';
  const chapters = [['listings', firstLabel, filterHtml + count + inventory + pagination.join('\n')], ['guide', 'Guide', guide], ['safety', 'Safety', safety]];
  const layout = `\n<!-- CATEGORY CHAPTERS: START -->\n<div class="category-chapters"><nav class="chapter-nav" aria-label="Category chapters"><span class="chapter-nav-label">Chapters</span><div class="chapter-track">${chapters.map(([id, name], index) => `<a id="chapter-link-${id}" href="#category-${id}" data-chapter="${id}"><span aria-hidden="true">0${index + 1}</span><strong>${name}</strong></a>`).join('')}</div></nav><div class="chapter-content">${chapters.map(([id, , body]) => `<section id="category-${id}" class="chapter-panel" data-chapter-panel="${id}" aria-labelledby="chapter-link-${id}"><!-- CHAPTER ${id.toUpperCase()}: START -->${body}<!-- CHAPTER ${id.toUpperCase()}: END --></section>`).join('\n')}</div></div><p class="chapter-status" role="status"></p>\n<!-- CATEGORY CHAPTERS: END -->\n`;
  html = html.replace(main[0], main[1] + '\n' + header.trim() + layout + main[3]);
  html = html.replace(/<body\b([^>]*)>/i, (tag, attributes) => {
    if (/\bclass="/.test(attributes)) return tag.includes('category-chapters-page') ? tag : tag.replace(/class="/, 'class="category-chapters-page ');
    return `<body${attributes} class="category-chapters-page">`;
  });
  html = html.replace(/\s*<link\b[^>]*href="\/assets\/category-chapters\.css[^>]*>/g, '');
  html = html.replace(/\s*<script\b[^>]*src="\/assets\/category-chapters\.js[^>]*><\/script>/g, '');
  return html.replace(/\s*<\/head>/, '\n<link rel="stylesheet" href="/assets/category-chapters.css?v=20261010"><script defer src="/assets/category-chapters.js?v=20261010"></script>\n</head>').replace(/[ \t]+$/gm, '');
}
