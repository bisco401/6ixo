import fs from 'node:fs/promises';
import path from 'node:path';
import { writeChanged } from './lib/seo.mjs';
import { homeCategoryLinks } from './lib/category-chapters.mjs';
const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'index.html');
let html = await fs.readFile(file, 'utf8');
// The public home heading must describe the marketplace. Preserve the heading styles.
if (/<div class="home-hero-copy">\s*<h2>Worldwide marketplace<\/h2>/.test(html)) {
  html = html.replace(/(<div class="home-hero-copy">\s*)<h2>Worldwide marketplace<\/h2>/, '$1<h1>Worldwide marketplace</h1>');
  html = html.replace(/<h1\b([^>]*id="dating-coming-soon-title"[^>]*)>([\s\S]*?)<\/h1>/, '<h2$1>$2</h2>');
  for (const relative of ['styles.css', 'assets/dating-coming-soon.css']) {
    const cssFile = path.join(root, relative);
    try {
      const css = await fs.readFile(cssFile, 'utf8');
      await writeChanged(cssFile, css.replaceAll('.home-hero-copy h2', '.home-hero-copy :is(h1, h2)').replaceAll('.dating-coming-soon-copy h1', '.dating-coming-soon-copy :is(h1, h2)'));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  html = html.replace(/styles\.css\?v=[^'"\s]+/g, 'styles.css?v=20261008-seo-headings');
}
if (/enabled:\s*false/.test(await fs.readFile(path.join(root, 'coming-soon-config.js'), 'utf8'))) {
  html = html.replace(/(<meta\b[^>]*(?:property="og:description"|name="twitter:description")[^>]*content=")([^"]*)"/g, (_, tag, description) => tag + description.replace(/\s*Coming soon\.?/gi, '') + '"');
}
const hub = /<(section|details)\b[^>]*class="home-seo-hub"[^>]*>[\s\S]*?<\/\1>\s*/;
const countryMarkup = html.match(/<!-- COUNTRY SEARCHES: START -->[\s\S]*?<!-- COUNTRY SEARCHES: END -->/)?.[0] || '';
html = html.replace(/<!-- COUNTRY SEARCHES: START -->[\s\S]*?<!-- COUNTRY SEARCHES: END -->\s*/g, '');
if (hub.test(html)) html = html.replace(hub, homeCategoryLinks(countryMarkup));
else html = html.replace('<footer class="home-footer">', homeCategoryLinks(countryMarkup) + '<footer class="home-footer">');
if (!html.includes('/assets/seo-navigation.css')) html = html.replace('</head>', '<link rel="stylesheet" href="/assets/seo-navigation.css?v=20261010">\n</head>');
else html = html.replace(/\/assets\/seo-navigation\.css(?:\?[^"']*)?/, '/assets/seo-navigation.css?v=20261010');
// Keep country/category navigation available before location access is granted.
html = html.replace(/(assets\/location-entry\.css\?v=)[^"'\s]+/g, '$120261010-country-navigation');
// Keep the public headline, search snippet and brand data consistent on every refresh.
const title = '6ixo | Cars, Apartments, Phones & Local Events';
const description = 'Find cars for sale, apartments for rent, new and used phones, local events, jobs and services on 6ixo. Browse listings worldwide or post an ad for free.';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
html = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escape(title)}</title>`);
for (const [attribute, name, content] of [
  ['name', 'description', description],
  ['property', 'og:title', title], ['property', 'og:description', description],
  ['name', 'twitter:title', title], ['name', 'twitter:description', description]
]) {
  const tag = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${name}["'])[^>]*>`, 'i');
  html = html.replace(tag, () => `<meta ${attribute}="${name}" content="${escape(content)}">`);
}
html = html.replace(/(<div class="home-hero-copy">\s*<h1>)[\s\S]*?(<\/h1>\s*<p>)[\s\S]*?(<\/p>)/,
  (_, heading, paragraph, end) => `${heading}6ixo worldwide marketplace${paragraph}Find cars for sale, apartments for rent, phones, local events and services. Browse worldwide or post an ad for free.${end}`);

// Describe the category links that visitors can actually use, without inventing rich results.
const hubLinks = html.match(/<(?:div|nav) class="home-seo-links"[^>]*>([\s\S]*?)<\/(?:div|nav)>/)?.[1] || '';
const categories = [...hubLinks.matchAll(/<a\b[^>]*href="(\/[^"?#]+\/)"[^>]*>\s*<strong>([^<]+)<\/strong>/g)]
  .map(([, href, name], index) => ({ '@type': 'ListItem', position: index + 1, name: name.replaceAll('&amp;', '&'), url: new URL(href, 'https://6ixo.com/').href }));
html = html.replace(/(<script\b[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/g, (block, open, json, close) => {
  const data = JSON.parse(json);
  if (!Array.isArray(data['@graph'])) return block;
  let changed = false;
  for (const entity of data['@graph']) {
    if (entity['@id'] === 'https://6ixo.com/#website') {
      entity.name = '6ixo';
      entity.alternateName = ['6ixo Marketplace', '6ixo Worldwide Marketplace', '6ixo.com'];
      entity.description = description;
      changed = true;
    } else if (entity['@id'] === 'https://6ixo.com/#webpage') {
      entity.name = title;
      entity.description = description;
      changed = true;
    } else if (entity['@id'] === 'https://6ixo.com/#marketplace-categories' && categories.length) {
      entity.itemListElement = categories;
      changed = true;
    }
  }
  return changed ? `${open}\n${JSON.stringify(data, null, 2).replaceAll('<', '\\u003c')}\n    ${close}` : block;
});
await writeChanged(file, html);
console.log('Home page links to crawlable marketplace categories and current inventory.');
