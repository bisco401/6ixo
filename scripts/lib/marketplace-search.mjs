import { clean, slugify } from './seo.mjs';

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
      && /\b(?:phones?|smartphones?|iphone|galaxy|redmi|pixel|oneplus|tecno|infinix|realme|oppo|vivo|nokia|huawei|honor)\b/i.test(listing.title)
      && !/\b(?:repair(?:s|ing)?|unlocking|replacement|screens?|screensaver|chargers?|charging|power bank|cases?|covers?|holders?|stands?|mounts?|tripods?|gimbals?|protectors?|cables?|battery|batteries|earbuds?|buds|headphones?|adapters?|tablets?|tab|ipad|watches|watch|airpods?|accessories|accessory|parts|wanted)\b/i.test(listing.title),
    intro: 'Compare phone listings, including iPhones, Android smartphones and other mobile phones. Review the model, storage, condition and seller location, then confirm network compatibility and availability.',
    guideTitle: 'What to check when buying a phone',
    guide: [
      ['Model, storage and condition', 'Confirm the exact model, storage, battery condition, screen condition and any repair history. Ask which accessories are included.'],
      ['Network and account locks', 'Check that the phone works with your carrier and that the seller can remove activation or account locks before completing the sale.'],
      ['Test the phone before paying', 'Test calls, charging, cameras, speakers, buttons and connectivity. Compare the full price and agree on pickup or delivery with the seller.']
    ],
    related: [['/electronics/', 'Laptops, gaming and electronics'], ['/listings/electronics/', 'All electronics listings'], ['/buy-and-sell/', 'Buy and sell locally']],
    postRoute: '/?open=post-ad#electronics', postLabel: 'Sell a phone'
  }
];

export function searchGroups(listings) {
  const groups = [];
  for (const topic of searchTopics) {
    const items = listings.filter(topic.matches);
    const base = `/${topic.slug}/`;
    const root = { ...topic, base, items, heading: topic.name, place: '', links: [] };
    groups.push(root);
    const countries = [...new Set(items.map(l => clean(l.country)).filter(Boolean))].sort();
    for (const country of countries) {
      const countryItems = items.filter(l => clean(l.country) === country);
      // Location pages contain a useful selection of actual ads, not empty city templates.
      if (countryItems.length < 3) continue;
      const countryBase = `${base}${slugify(country)}/`;
      const countryGroup = { ...topic, base: countryBase, items: countryItems, heading: `${topic.name} in ${country}`, place: country, links: [[base, 'All countries']] };
      root.links.push([countryBase, `${country} (${countryItems.length})`]);
      groups.push(countryGroup);
      const cities = [...new Set(countryItems.map(l => clean(l.city)).filter(city => /^[\p{L}][\p{L}\s'-]{1,29}$/u.test(city)))].sort();
      for (const city of cities) {
        const cityItems = countryItems.filter(l => clean(l.city) === city);
        if (cityItems.length < 5) continue;
        const cityBase = `${countryBase}${slugify(city)}/`;
        countryGroup.links.push([cityBase, `${city} (${cityItems.length})`]);
        groups.push({ ...topic, base: cityBase, items: cityItems, heading: `${topic.name} in ${city}, ${country}`, place: `${city}, ${country}`, links: [[base, 'All countries'], [countryBase, country]] });
      }
    }
  }
  return groups;
}
