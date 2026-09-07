// Shared by the browser, repair tool and generated n8n workflows. No DOM/URL globals required.
function createListingIntegrity() {
  const VERSION = '2026-09-06.1';
  const decode = (value = '') => String(value || '').replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&').replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const key = (value = '') => decode(value).trim().replace(/^https?:\/\/(?:www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const path = (value = '') => key(value).replace(/^[^/]+(?=\/)/, '');
  const attrs = (value) => { try { return typeof value === 'object' ? (value || {}) : JSON.parse(value || '{}'); } catch { return {}; } };
  const sourceUrl = (row = {}) => {
    let url = String(row.source_url || row.sourceUrl || row.url || '').trim();
    if (url.startsWith('/')) {
      if (/jacars/i.test(row.source_site || row.sourceSite || '')) url = `https://www.jacars.net${url}`;
      else if (/oxglow/i.test(row.source_site || row.sourceSite || '')) url = `https://oxglow.com.gh${url}`;
    }
    return url;
  };
  const route = (category, subcategory = 'other', reason = 'source_category') => ({ target_surface: category === 'vehicles' ? 'vehicles' : 'marketplace', app_category: category, app_subcategory: subcategory, reason });
  const titleRoute = (value = '') => {
    const t = decode(value).toLowerCase();
    // Intent in the title outranks a provider's broad product category.
    if (/\b(cash for (?:gold|silver)|(?:gold|silver|platinum|gift card).{0,50}buyers?|buy.{0,25}sell crypto)\b/.test(t)) return route('services', 'financial', 'title_intent');
    if (/\b(scrap (?:cars?|metal) (?:removal|pick.?up)|cash.{0,15}(?:scrap cars?|for cars)|cash 4 cars)\b/.test(t)) return route('services', 'other', 'title_intent');
    if (/\b(?:hiring|help wanted|job vacancy|now recruiting)\b/.test(t)) return route('jobs', 'other', 'title_intent');
    if (/\b(?:motorcycle|car|auto|vehicle).{0,25}(?:detailing|car wash)\b/.test(t)) return route('vehicles', 'detailing', 'title_intent');
    if (/\b(?:hair|makeup|henna|massage).{0,40}(?:available|service)|\b(?:hair makeup|hair salon)\b/.test(t)) return route('services', 'health_beauty', 'title_intent');
    if (/\b(?:repair|installation|installing|wall mount).{0,30}(?:service|installation)|\b(?:roof repair|appliance service|tv installation|garage door service)\b/.test(t)) return route('services', 'home_services', 'title_intent');
    return null;
  };
  const classify = (row = {}) => {
    const a = attrs(row.attributes);
    const url = sourceUrl(row);
    const title = String(row.title || '');
    const intent = titleRoute(title);
    if (intent) return intent;
    const slug = url.match(/kijiji\.ca\/v-([^/]+)/i)?.[1] || '';
    const rules = [
      [/^(?:cars-trucks|motorcycles|atv|boats|rv-motorhome|travel-trailer-camper)$/, 'vehicles', 'vehicles'],
      [/^tires-rims$/, 'vehicles', 'tires_rims'],
      [/^(?:auto-body-parts|other-auto-parts-and-accessories|auto-parts-tires|engine-engine-parts|transmission-drivetrain)$/, 'vehicles', 'auto_parts'],
      [/^clothing-men$/, 'clothing', 'men'], [/^clothing-women$/, 'clothing', 'women'],
      [/^(?:clothing-kids|baby-clothes)$/, 'clothing', 'kids'], [/^(?:jewelry-watch|women-bags-wallets|clothing-other)$/, 'clothing', 'accessories'],
      [/^(?:cell-phone|cell-phone-accessories)$/, 'electronics', 'phones_accessories'],
      [/^(?:laptops|desktop-computers|ipads-tablets|computer-accessories)$/, 'electronics', 'computers_tablets'],
      [/^(?:speakers-headsets-mics|stereo-systems-home-theatre|headphones)$/, 'electronics', 'audio_headphones'],
      [/^(?:tvs|tv-video)$/, 'electronics', 'tv_video_home_theatre'],
      [/^(?:camera-camcorder-lens|cameras-camcorders)$/, 'electronics', 'cameras_photography'],
      [/^(?:video-games-consoles|video-games-consoles-other)/, 'electronics', 'gaming_consoles'],
      [/^(?:short-term-rental)$/, 'real_estate', 'for_rent_short'],
      [/^(?:house-for-sale|condo-for-sale|land-for-sale|commercial-office-space-for-sale)$/, 'real_estate', 'for_sale'],
      [/^(?:apartments-condos|room-rental-roommate|commercial-office-space|house-rental)$/, 'real_estate', 'for_rent_long'],
      [/jobs$/, 'jobs', 'other'],
      [/^pet-services$/, 'services', 'pet_services'], [/^massage$/, 'services', 'health_beauty'],
      [/^(?:renovation-contracting-handyman|heating-cooling-air)$/, 'services', 'skilled_trades'],
      [/^(?:cleaners-cleaning-service|appliance-repair-installation|roofing-service-roofer|lawn-tree-eavestrough|moving-storage)$/, 'services', 'home_services'],
      [/service/, 'services', 'other'],
      [/^classes-lessons$/, 'community', 'classes_lessons'], [/^rideshare-carpool$/, 'community', 'rideshare'],
      [/^(?:friendship-networking|community-other)$/, 'community', 'other'],
      [/^(?:washer-dryer|stove-oven-range|refrigerator-fridge|dishwasher|other-home-appliance|heater-humidifier-dehumidifier)$/, 'other', 'appliances'],
      [/^(?:bed-mattress|couch-futon|buy-sell-desks|rug-carpet-runner|dining-table-set|home-indoor)$/, 'other', 'furniture_home_decor'],
      [/^(?:heavy-equipment-machinery|power-tool|hand-tool|industrial-shelving-racking|other-business-industrial|storage-containers|garage-door-and-opener|snowblower|lawnmower-leaf-blower)$/, 'other', 'tools_equipment'],
      [/^toys-games$/, 'other', 'baby_kids'],
      [/^(?:art-collectibles|hobbies-craft|cd-dvd-blu-ray|musical-instrument)$/, 'other', 'hobbies_collectibles'],
      [/^(?:golf|fixie-single-speed|exercise-equipment|sporting-goods|bikes)$/, 'other', 'sports_outdoors'],
    ];
    for (const [pattern, category, subcategory] of rules) if (slug && pattern.test(slug)) return route(category, subcategory);
    const provider = String(a.sourceCategory || a.sourceName || row.source_category || row.source_site || '').toLowerCase();
    // Explicit source taxonomies precede description keywords (e.g. car ads mentioning speakers).
    const sourceSubcategory = String(a.sourceSubcategory || '').toLowerCase();
    if (/baby-and-kids/.test(provider)) return route(/clothing|shoes/.test(sourceSubcategory) ? 'clothing' : 'other', /clothing|shoes/.test(sourceSubcategory) ? 'kids' : 'baby_kids');
    if (/books-music-and-hobbies/.test(provider)) return route('other', 'hobbies_collectibles');
    if (/business-and-industrial/.test(provider)) return route('other', 'tools_equipment');
    if (/education-and-training/.test(provider)) return route('community', 'classes_lessons');
    if (/home-furniture-and-appliances/.test(provider)) return route('other', /appliance/.test(sourceSubcategory) ? 'appliances' : 'furniture_home_decor');
    if (/pets-and-animals/.test(provider)) return route('other', 'pet_supplies');
    if (/travel-and-tourism/.test(provider)) return route('services', 'travel');
    if (/tires and rims|tires.rims/.test(provider)) return route('vehicles', 'tires_rims');
    if (/auto.parts|car parts|car accessories|spares|luggage racks/.test(provider)) return route('vehicles', 'auto_parts');
    if (/car rentals/.test(provider)) return route('vehicles', 'rentals');
    if (/auto services|auto repair/.test(provider)) return route('vehicles', 'repairs');
    if (/^(?:vehicles|cars|cars for sale)$|jacars (?:cars|vehicles)$|oxglow cars|carsforsale/.test(provider)) return route('vehicles', 'vehicles');
    if (/clothes|clothing|footwear/.test(provider)) return route('clothing', /\b(?:shoe|shoes|sneaker|sneakers|boots)\b/i.test(title) ? 'shoes' : /\b(?:shirt|pants|dress|jacket|apparel)\b/i.test(title) ? 'other' : 'accessories');
    if (/home garden/.test(provider)) return route('other', 'furniture_home_decor');
    if (/hobbies sports/.test(provider)) return route('other', 'sports_outdoors');
    if (/kids stuff/.test(provider)) return route('other', 'baby_kids');
    if (/animals pets/.test(provider)) return route('other', 'pet_supplies');
    if (/jacars tools|other business/.test(provider)) return route('other', 'tools_equipment');
    const t = title.toLowerCase();
    const category = String(row.app_category || row.appCategory || '').toLowerCase();
    const sub = String(row.app_subcategory || row.appSubcategory || 'other').toLowerCase();
    // Refine broad electronics buckets using the item title, never contact/delivery boilerplate.
    if (/electronics|mobile phones|computers|audio visual/.test(provider) || category === 'electronics' || slug === 'buy-sell-other') {
      if (/\b(?:washing machine|washers?|dryers?|fridge|refrigerator|stove|dishwasher|cooktop|blender|toaster|food processor|meat slicer|induction cooker|coffee machine)\b/.test(t)) return route('other', 'appliances', 'title');
      if (/\b(?:laptop|macbook|computer|ipad|tablet|pc|vga)\b/.test(t)) return route('electronics', 'computers_tablets', 'title');
      if (/\b(?:iphone|smartphone|cell phone|galaxy|redmi|pixel)\b/.test(t)) return route('electronics', 'phones_accessories', 'title');
      if (/\b(?:headphones?|earbuds?|buds|speakers?|microphones?|jbl|airpods)\b/.test(t)) return route('electronics', 'audio_headphones', 'title');
      if (/\b(?:tv|television|projector)\b/.test(t)) return route('electronics', 'tv_video_home_theatre', 'title');
      if (/\b(?:playstation|xbox|nintendo|ps[345]|gaming console)\b/.test(t)) return route('electronics', 'gaming_consoles', 'title');
      if (/\b(?:camera|camcorder|lens)\b/.test(t)) return route('electronics', 'cameras_photography', 'title');
      if (/\b(?:guitar|piano|drum|collectible)\b/.test(t)) return route('other', 'hobbies_collectibles', 'title');
    }
    if (slug) return route('other', 'miscellaneous');
    if (category === 'home' || category === 'buy_sell') {
      const subMap = { furniture: 'furniture_home_decor', home_garden: 'furniture_home_decor', hobbies_sports: 'sports_outdoors', business: 'tools_equipment', other: 'miscellaneous' };
      return route('other', subMap[sub] || 'miscellaneous', 'category_alias');
    }
    if (category === 'vehicles') return route(category, sub === 'cars' ? 'vehicles' : sub, 'existing_category');
    if (category === 'real_estate') return route(category, /^(?:for_rent|real_estate|commercial)$/.test(sub) ? (/for sale|selling|land|homes/i.test(title) ? 'for_sale' : 'for_rent_long') : sub, 'existing_category');
    if (category === 'electronics') return route(category, sub === 'tv_audio' ? 'tv_video_home_theatre' : sub === 'electronics' ? 'other' : sub, 'existing_category');
    if (['services','jobs','community'].includes(category)) return route(category, sub === category ? 'other' : sub, 'existing_category');
    return route(category || 'other', category ? sub : 'miscellaneous', 'existing_category');
  };
  const normalizeImage = (value = '', url = '') => {
    let v = decode(value).trim();
    if (!v || /(?:no[_-]?image|placeholder|photoapparat|map\d*\.craigslist\.org|\/logo|\/avatar|\/icon)/i.test(v)) return '';
    v = v.replace(/^(?:\.\.\/)+/, '/').replace(/^\.\//, '/');
    if (v.startsWith('//')) v = `https:${v}`;
    if (v.startsWith('/')) v = `${String(url).match(/^https?:\/\/[^/]+/i)?.[0] || ''}${v}`;
    if (!/^https?:\/\//i.test(v)) return '';
    if (/^https?:\/\/media\.kijiji\.ca\//i.test(v)) {
      const [base, query = ''] = v.split('?');
      v = `${base}?${[...query.split('&').filter(p => p && !/^rule=/i.test(p)), 'rule=kijijica-1600-webp'].join('&')}`;
    }
    return v;
  };
  const imageValues = (value) => {
    if (Array.isArray(value)) return value.flatMap(imageValues);
    if (value && typeof value === 'object') return imageValues(value.contentUrl || value.src || value.url || value.image);
    return value ? [String(value)] : [];
  };
  const scripts = (html = '') => [...String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].flatMap(m => {
    if (!/application\/(?:ld\+json|json)|__NEXT_DATA__/i.test(m[1])) return [];
    try { return [{ attributes: m[1], data: JSON.parse(m[2]) }]; }
    catch { try { return [{ attributes: m[1], data: JSON.parse(decode(m[2])) }]; } catch { return []; } }
  });
  const extract = (html = '', row = {}) => {
    const url = sourceUrl(row);
    const blocks = scripts(html);
    if (/sebu\.co\.ke\//.test(url)) {
      const match = String(html).match(/const\s+ad\s*=\s*JSON\.parse\('((?:\\.|[^'])*)'\)/);
      if (match) {
        try {
          const text = match[1].replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|[\\'"nrtbfv])/gi, (_, c) => c[0] === 'u' || c[0] === 'x' ? String.fromCharCode(parseInt(c.slice(1),16)) : ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'}[c] || c));
          const ad = JSON.parse(text);
          if (String(row.id || '').replace(/^sebu-/, '') === String(ad.id)) {
            const images = (ad.images || []).slice().sort((a,b) => Number(a.sort || 999)-Number(b.sort || 999)).map(i => normalizeImage(i.url,url)).filter(Boolean);
            return {images:[...new Set(images)].slice(0,12),title:ad.title || '',matched:true,method:'listing_id'};
          }
        } catch {}
      }
    }
    const expectedId = url.match(/kijiji\.ca\/v-[^?#]+\/(\d+)/i)?.[1];
    let primary = null;
    if (expectedId) {
      for (const block of blocks) {
        const state = block.data?.props?.pageProps?.__APOLLO_STATE__ || block.data?.props?.pageProps?.apolloState || {};
        primary = Object.values(state).find(v => v && v.__typename === 'StandardListing' && String(v.id) === expectedId && (!v.url || v.url.match(/\/(\d+)(?:[?#]|$)/)?.[1] === expectedId));
        if (primary) return { images: [...new Set(imageValues(primary.imageUrls).map(v => normalizeImage(v, url)).filter(Boolean))].slice(0, 12), title: primary.title || '', availability: String(primary.status || 'active').toLowerCase(), matched: true, method: 'listing_id' };
      }
    }
    // Only primary structured entities; ItemLists, related products and organizations are excluded.
    const entities = blocks.flatMap(b => Array.isArray(b.data) ? b.data : Array.isArray(b.data?.['@graph']) ? b.data['@graph'] : [b.data]);
    const canonicalTag = [...String(html).matchAll(/<link\b[^>]*>/gi)].find(m => /rel=["']canonical["']/i.test(m[0]))?.[0] || '';
    const canonical = canonicalTag.match(/href=["']([^"']+)/i)?.[1] || '';
    const sameUrl = (v) => key(v) === key(url) || (String(v).startsWith('/') && path(url) === key(v));
    // Oxglow's JSON-LD sometimes contains unescaped newlines. Its own gallery is explicit.
    if (/oxglow\.com\.gh/.test(url) && sameUrl(canonical)) {
      const images = [...String(html).matchAll(/\boriginal\s*:\s*["']([^"']+)["']/gi)].map(m => normalizeImage(m[1],url)).filter(v => /\/uploads\/original\//.test(v));
      if (images.length) return { images:[...new Set(images)].slice(0,12), matched:true, method:'source_gallery' };
    }

    primary = entities.find(e => {
      if (!e || !imageValues(e.image).length || ![].concat(e['@type'] || []).some(t => /^(?:Product|Car|Vehicle|RealEstateListing|Apartment|House|SingleFamilyResidence)$/.test(t))) return false;
      const identities = [e.url, e['@id'], ...[].concat(e.offers || []).map(o => o?.url)].filter(Boolean);
      if (identities.length) return identities.some(sameUrl);
      return sameUrl(canonical) && String(e.name || '').trim().toLowerCase() === String(row.title || '').trim().toLowerCase();
    });
    if (primary) return { images: [...new Set(imageValues(primary.image).map(v => normalizeImage(v, url)).filter(Boolean))].slice(0,12), title: primary.name || '', matched: true, method: 'primary_structured_data' };
    // Craigslist's gallery is a dedicated data object, never map/nearby ad images.
    if (/craigslist\.org/.test(url) && (sameUrl(canonical) || entities.some(e => e?.['@type'] === 'BreadcrumbList' && (e.itemListElement || []).some(i => sameUrl(i.item))))) {
      const gallery = String(html).match(/(?:var\s+)?imgList\s*=\s*(\[[\s\S]*?\]);/)?.[1];
      try { const images = JSON.parse(gallery || '[]').map(i => normalizeImage(i.url,url)).filter(v => /^https?:\/\/images\.craigslist\.org\//.test(v)); if(images.length) return {images,matched:true,method:'source_gallery'}; } catch {}
    }
    return {images:[], matched:false, method:'unverified'};
  };
  const matchCrawlResult = (items, url) => items.find(item => key(item?.url || '') === key(url)) || null;
  return { VERSION, key, sourceUrl, classify, normalizeImage, extract, matchCrawlResult };
}
module.exports = createListingIntegrity();
