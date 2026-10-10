import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml as esc, writeChanged } from './lib/seo.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pages = [
  {
    slug: 'cars-for-sale', title: 'Cars for Sale Near You | New & Used Vehicles | 6ixo',
    description: 'Browse new and used cars for sale from owners and dealers. Compare prices, photos, mileage and seller locations, or list your car for free on 6ixo.',
    heading: 'New and used cars for sale.',
    intro: 'Browse cars for sale from owners and dealers, including sedans, SUVs, pickups and other vehicles. Compare price, mileage, condition and location, then contact the seller to confirm the details.',
    links: [['/listings/vehicles/', 'Browse current cars for sale'], ['/car-rentals/', 'Cars for rent'], ['/auto-parts/', 'Auto parts and accessories']]
  },
  {
    slug: 'real-estate', title: 'Apartments & Homes for Rent or Sale | 6ixo',
    description: 'Find apartments for rent, houses for rent, rooms and homes for sale. Compare property details, prices and locations, or post a property for free on 6ixo.',
    heading: 'Apartments, houses and homes for rent or sale.',
    intro: 'Find apartments for rent, houses for rent, rooms, condos, land and commercial property. Compare the location, price, space and availability, then confirm the property details with the landlord or seller.',
    links: [['/apartments-for-rent/', 'Apartments for rent'], ['/short-term-rentals/', 'Furnished short-term rentals'], ['/listings/real-estate/', 'All property listings']]
  },
  {
    slug: 'electronics', title: 'Phones, Laptops & Electronics for Sale | 6ixo',
    description: 'Find new and used phones, laptops, tablets, gaming consoles, TVs and electronics for sale. Compare prices, photos and seller locations on 6ixo.',
    heading: 'Phones, laptops and electronics for sale.',
    intro: 'Browse new and used electronics for sale, including phones, laptops, tablets, gaming consoles, TVs, audio and cameras. Compare model, condition, price and location before contacting the seller.',
    links: [['/phones-for-sale/', 'Phones for sale'], ['/listings/electronics/', 'Laptops, gaming and electronics listings'], ['/services/', 'Local tech services']]
  },
  {
    slug: 'events', title: 'Local Events, Meetups & Things to Do | 6ixo',
    description: 'Explore local events, meetups, markets, workshops, festivals and things to do near you. Browse community posts or share your event for free on 6ixo.',
    heading: 'Local events and things to do near you.',
    intro: 'Explore local events, meetups, markets, workshops, festivals, live entertainment and community gatherings. Check the location, date, organizer and entry details before making plans.',
    links: [['/#community', 'Browse community events'], ['/community/', 'Meetups and community activities'], ['/services/', 'Event services and organizers']]
  }
];

for (const page of pages) {
  const file = path.join(root, page.slug, 'index.html');
  let html = await fs.readFile(file, 'utf8');
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(page.title)}</title>`);
  for (const [attribute, name, content] of [
    ['name', 'description', page.description],
    ['property', 'og:title', page.title], ['property', 'og:description', page.description],
    ['name', 'twitter:title', page.title], ['name', 'twitter:description', page.description]
  ]) {
    const tag = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${name}["'])[^>]*>`, 'i');
    html = html.replace(tag, `<meta ${attribute}="${name}" content="${esc(content)}">`);
  }
  html = html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, `<h1>${esc(page.heading)}</h1>`);
  html = html.replace(/<p class="hero-lede">[\s\S]*?<\/p>/, `<p class="hero-lede">${esc(page.intro)}</p>`);
  html = html.replace(/\s*<!-- POPULAR SEARCHES: START -->[\s\S]*?<!-- POPULAR SEARCHES: END -->/g, '');
  const links = `\n<!-- POPULAR SEARCHES: START -->\n<section class="section" aria-labelledby="popular-searches"><h2 id="popular-searches">Browse related listings</h2><div class="related-grid">${page.links.map(([href, name]) => `<a href="${href}">${esc(name)}</a>`).join('')}</div></section>\n<!-- POPULAR SEARCHES: END -->\n`;
  html = html.replace('</main>', links + '</main>');
  html = html.replace(/(<script\b[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/g, (block, open, raw, close) => {
    const data = JSON.parse(raw);
    for (const entity of data['@graph'] || [data]) {
      if (['CollectionPage', 'WebPage'].includes(entity['@type'])) {
        entity.name = page.title.replace(/ \| 6ixo$/, '');
        entity.description = page.description;
      }
    }
    return `${open}\n${JSON.stringify(data, null, 2).replaceAll('<', '\\u003c')}\n${close}`;
  });
  await writeChanged(file, html);
}
console.log('Updated category search headings, descriptions and useful internal links.');
