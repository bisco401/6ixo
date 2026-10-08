import fs from 'node:fs/promises';
import path from 'node:path';
import { writeChanged } from './lib/seo.mjs';
const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'index.html');
let html = await fs.readFile(file, 'utf8');
const generatedHub = !html.includes('home-seo-hub') || html.includes('Browse listings, compare photos and prices, and explore local opportunities by category or country.');
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
if (!html.includes('home-seo-hub')) {
  const links = [
    ['listings', 'Current listings'], ['cars-for-sale', 'Cars for sale'], ['car-rentals', 'Car rentals'], ['auto-parts', 'Auto parts'],
    ['short-term-rentals', 'Short-term rentals'], ['real-estate', 'Real estate'], ['electronics', 'Electronics'], ['fashion', 'Fashion'],
    ['buy-and-sell', 'Buy and sell'], ['services', 'Local services'], ['jobs', 'Jobs'], ['community', 'Community'], ['events', 'Events'], ['rewards', 'Rewards']
  ];
  const section = `<section class="home-seo-hub" aria-labelledby="home-seo-hub-title"><h2 id="home-seo-hub-title">Explore the 6ixo marketplace</h2><p>Browse listings, compare photos and prices, and explore local opportunities by category or country.</p><nav class="home-seo-links" aria-label="Marketplace categories">${links.map(([slug, name]) => `<a href="/${slug}/"><strong>${name}</strong></a>`).join('')}</nav></section>\n`;
  html = html.replace('<footer class="home-footer">', section + '<footer class="home-footer">');
} else if (!/class="home-seo-links"[\s\S]*?href="\/listings\/"/.test(html)) {
  html = html.replace('<div class="home-seo-links">', '<div class="home-seo-links"><a href="/listings/"><strong>Current listings</strong><span>Photos, prices and locations</span></a>');
}
if (generatedHub && !html.includes('/assets/seo-navigation.css')) html = html.replace('</head>', '<link rel="stylesheet" href="/assets/seo-navigation.css?v=20261008">\n</head>');
if (!generatedHub) html = html.replace(/<link rel="stylesheet" href="\/assets\/seo-navigation\.css[^>]*>\s*/g, '');
await writeChanged(file, html);
console.log('Home page links to crawlable marketplace categories and current inventory.');
