import { clean, slugify } from './seo.mjs';

const vehicleType = listing => {
  let attributes;
  try { attributes = (typeof listing.attributes === 'string' ? JSON.parse(listing.attributes || '{}') : listing.attributes) || {}; } catch { attributes = {}; }
  const details = [listing.details, attributes.details, attributes.sourceSpecifications].flatMap(values => Array.isArray(values) ? values : []);
  return clean(listing.body_type || listing.bodyType || details.find(d => /^(?:body type|vehicle type)$/i.test(clean(d?.label)))?.value);
};

// Use the published category and the item itself, not mentions in a description.
// A phone accessory or an apartment offered for sale must not become a rental/device ad.
export const searchTopics = [
  {
    slug: 'apartments-for-rent', name: 'Apartments for rent',
    matches: listing => listing.categoryKey === 'real-estate'
      && ['for_rent_long', 'for_rent'].includes(listing.app_subcategory)
      && /\b(?:apartments?|condos?|condominiums?|flats?)\b/i.test(listing.title)
      && !/\b(?:roommates?|room for rent|private room|shared room|office|commercial|warehouse|land|plots?)\b/i.test(listing.title),
    intro: 'Compare apartments, condos and flats by location, rent and the details supplied by each landlord. Review bedrooms, utilities, move-in dates and lease terms before arranging a viewing.',
    guideTitle: 'Compare an apartment before you rent',
    guide: [
      ['Monthly rent and total costs', 'Ask which utilities are included, whether a deposit is required, and what parking or other recurring charges apply.'],
      ['Space and move-in details', 'Confirm bedrooms, bathrooms, furnishing, laundry, parking, pet rules, lease length and the available move-in date.'],
      ['Viewing and landlord details', 'Confirm the address and the landlord or representative, view the apartment, and review the written lease before paying.']
    ],
    related: [['/real-estate/', 'Homes, rooms and real estate'], ['/short-term-rentals/', 'Furnished short-term rentals'], ['/services/', 'Moving and home services']],
    postRoute: '/?open=post-ad#realestate', postLabel: 'List an apartment'
  },
  {
    slug: 'phones-for-sale', name: 'Phones for sale',
    matches: listing => listing.categoryKey === 'electronics'
      && (/\b(?:phones?|smartphones?|iphone|galaxy|redmi|pixel|oneplus|tecno|infinix|realme|oppo|vivo|nokia|huawei|honor|poco|cubot|oukitel|techview|itel|motorola|blackberry|red ?magic)\b/i.test(listing.title)
        || (listing.app_subcategory === 'phones_accessories' && /\bsamsung\b/i.test(listing.title)))
      && !/\b(?:repair(?:s|ing)?|unlocking|replacement|screens?|screensaver|chargers?|charging|power ?banks?|cases?|covers?|holders?|stands?|mounts?|tripods?|gimbals?|protectors?|cables?|battery|batteries|earbuds?|buds|headphones?|adapters?|tablets?|tab|pad|ipad|watches|watch|airpods?|accessories|accessory|parts|wanted)\b/i.test(listing.title),
    intro: 'Compare phone listings, including iPhones, Android smartphones and other mobile phones. Review the model, storage, condition and seller location, then confirm network compatibility and availability.',
    guideTitle: 'What to check when buying a phone',
    guide: [
      ['Model, storage and condition', 'Confirm the exact model, storage, battery condition, screen condition and any repair history. Ask which accessories are included.'],
      ['Network and account locks', 'Check that the phone works with your carrier and that the seller can remove activation or account locks before completing the sale.'],
      ['Test the phone before paying', 'Test calls, charging, cameras, speakers, buttons and connectivity. Compare the full price and agree on pickup or delivery with the seller.']
    ],
    related: [['/electronics/', 'Laptops, gaming and electronics'], ['/listings/electronics/', 'All electronics listings'], ['/buy-and-sell/', 'Buy and sell locally']],
    postRoute: '/?open=post-ad#electronics', postLabel: 'Sell a phone'
  },
  {
    slug: 'cars-for-sale', name: 'Cars for sale', existingRoot: true, countryOnly: true,
    matches: listing => listing.categoryKey === 'vehicles'
      && !/\b(?:motorcycles?|motorbikes?|motor bike|bikes?|bicycles?|tricycles?|scooters?|mopeds?|atvs?|utvs?|boats?|yachts?|jet skis?|trailers?|caravans?|motorhomes?|rvs?|snowmobiles?|golf carts?)\b/i.test(`${listing.title} ${vehicleType(listing)}`),
    intro: 'Compare cars, SUVs, pickups and vans by asking price, seller location, mileage and condition. Review the listing details and contact the seller to arrange a viewing.',
    guideTitle: 'Compare a car before you buy',
    guide: [
      ['Price and running costs', 'Compare the asking price, mileage, service information and any repairs mentioned by the seller. Ask what is included in the price.'],
      ['Condition and history', 'Ask for vehicle identifiers and maintenance records, and arrange a viewing, road test and independent inspection.'],
      ['Seller and availability', 'Confirm that the vehicle is still available, where you can view it and who owns it before agreeing to a purchase.']
    ],
    related: [['/cars-for-sale/', 'All cars for sale'], ['/auto-parts/', 'Auto parts and accessories'], ['/car-rentals/', 'Cars for rent']],
    postRoute: '/?open=post-ad#vehicles', postLabel: 'Sell a car'
  },
  {
    slug: 'events', name: 'Local events', existingRoot: true, countryOnly: true,
    matches: listing => listing.categoryKey === 'community'
      && /^(?:events?|meetups?|festivals?|concerts?|community_events)$/.test(listing.app_subcategory || ''),
    intro: 'Browse published local events and meetups. Confirm the date, venue, organizer and entry details before making plans.',
    guideTitle: 'Plan your visit',
    guide: [
      ['Date and time', 'Check the start time and whether the organizer has announced any changes.'],
      ['Venue and access', 'Confirm the location, transport options and accessibility information with the organizer.'],
      ['Entry details', 'Ask whether registration is required and confirm any entry cost before attending.']
    ],
    related: [['/events/', 'All local events'], ['/community/', 'Community activities'], ['/services/', 'Local services']],
    postRoute: '/?open=post-ad#community', postLabel: 'Share an event'
  }
];

export function searchGroups(listings) {
  const groups = [];
  for (const topic of searchTopics) {
    const items = listings.filter(topic.matches);
    const base = `/${topic.slug}/`;
    const root = { ...topic, base, items, heading: topic.name, place: '', links: [] };
    if (!topic.existingRoot) groups.push(root);
    const countries = [...new Set(items.map(l => clean(l.country)).filter(Boolean))].sort();
    for (const country of countries) {
      const countryItems = items.filter(l => clean(l.country) === country);
      // Location pages contain a useful selection of actual ads, not empty city templates.
      if (!countryItems.length) continue;
      const countryBase = `${base}${slugify(country)}/`;
      const countryGroup = { ...topic, base: countryBase, items: countryItems, heading: `${topic.name} in ${country}`, place: country, country, focused: true, intro: `${topic.name} in ${country}. ${topic.intro}`, links: [[base, 'All countries'], [`/listings/country/${slugify(country)}/`, `All listings in ${country}`]], breadcrumbs: [[topic.name, base], [country, countryBase]] };
      root.links.push([countryBase, `${country} (${countryItems.length})`]);
      groups.push(countryGroup);
      if (topic.countryOnly) continue;
      const cities = [...new Set(countryItems.map(l => clean(l.city)).filter(city => /^[\p{L}][\p{L}\s'-]{1,29}$/u.test(city)))].sort();
      for (const city of cities) {
        const cityItems = countryItems.filter(l => clean(l.city) === city);
        if (cityItems.length < 5) continue;
        const cityBase = `${countryBase}${slugify(city)}/`;
        countryGroup.links.push([cityBase, `${city} (${cityItems.length})`]);
        groups.push({ ...topic, base: cityBase, items: cityItems, heading: `${topic.name} in ${city}, ${country}`, place: `${city}, ${country}`, country, focused: true, intro: `${topic.name} in ${city}, ${country}. ${topic.intro}`, links: [[base, 'All countries'], [countryBase, country]], breadcrumbs: [[topic.name, base], [country, countryBase], [city, cityBase]] });
      }
    }
  }
  return groups;
}

const sentenceList = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function countryGroups(listings, categories, topics = searchGroups(listings)) {
  const groups = [];
  const countries = [...new Set(listings.map(l => clean(l.country)).filter(Boolean))].sort();
  for (const country of countries) {
    const base = `/listings/country/${slugify(country)}/`;
    const items = listings.filter(l => clean(l.country) === country);
    const localTopics = topics.filter(g => g.place === country);
    const links = localTopics.map(g => [g.base, `${g.name} (${g.items.length})`]);
    const phrases = localTopics.map(g => g.name.toLowerCase());
    const localCategories = categories.map(g => ({ ...g, items: g.items.filter(l => clean(l.country) === country) })).filter(g => g.items.length);
    for (const category of localCategories) {
      // The specific car page is the country's vehicle landing page when cars exist.
      // Keep one URL for that selection rather than duplicate it under /listings/.
      if (category.key === 'vehicles' && localTopics.some(g => g.slug === 'cars-for-sale')) continue;
      const categoryBase = `${base}${category.key}/`;
      const name = category.key === 'vehicles' ? 'Vehicles for sale' : category.key === 'buy-and-sell' ? 'Other items for sale' : category.name;
      links.push([categoryBase, `${name} (${category.items.length})`]);
      phrases.push(name.toLowerCase());
      groups.push({ name, base: categoryBase, items: category.items, heading: `${name} in ${country}`, place: country, country, categoryKey: category.key, focused: true,
        intro: `Browse ${name.toLowerCase()} listings in ${country}. Compare the published prices, photos, locations and listing details, then contact the seller to confirm availability.`,
        links: [[base, `All listings in ${country}`], [category.base, `${name} worldwide`], ...localTopics.filter(g => g.slug !== 'cars-for-sale').map(g => [g.base, g.name])],
        breadcrumbs: [[country, base], [name, categoryBase]] });
    }
    const featured = sentenceList([...new Set(phrases)].slice(0, 5));
    groups.push({ name: `Marketplace in ${country}`, title: `${country} Marketplace: Buy and Sell`, base, items, heading: `Buy and sell in ${country}`, place: country, country, countryHub: true, focused: true,
      intro: `Find ${featured} in ${country}. Browse ${items.length} published ads with prices, photos and seller locations. Choose a category to compare matching listings.`,
      description: `Browse ${items.length} ads in ${country}: ${featured}. Compare prices, photos and locations on 6ixo.`,
      links: [['/listings/', 'All countries'], ...links], breadcrumbs: [[country, base]], postRoute: '/?open=post-ad', postLabel: 'Post an ad' });
  }
  return groups;
}
