// Shared by the browser, repair tool and generated n8n workflows. No DOM/URL globals required.
function createListingIntegrity() {
  const VERSION = '2026-10-07.1';
  const decode = (value = '') => String(value || '').replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&').replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const key = (value = '') => decode(value).trim().replace(/^https?:\/\/(?:www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const path = (value = '') => key(value).replace(/^[^/]+(?=\/)/, '');
  const attrs = (value) => { try { return typeof value === 'object' ? (value || {}) : JSON.parse(value || '{}'); } catch { return {}; } };
  const identityText = (value = '') => decode(value).replace(/\s+/g, ' ').trim().toLowerCase();
  const imageKey = (value = '') => key(value).replace(/_(?:50x50c|300x300|600x450|1200x900)(?=\.)/i, '');
  const sourceUrl = (row = {}) => {
    let url = String(row.source_url || row.sourceUrl || row.url || '').trim();
    if (url.startsWith('/')) {
      if (/jacars/i.test(row.source_site || row.sourceSite || '')) url = `https://www.jacars.net${url}`;
      else if (/oxglow/i.test(row.source_site || row.sourceSite || '')) url = `https://oxglow.com.gh${url}`;
    }
    return url;
  };
  // Only explicit contact fields count; descriptions may contain prices or IDs.
  // Capture the preceding digits instead of lookbehind so Safari 16.1 can parse the app.
  const phone = (...values) => [...new Set(values.flatMap(value => String(value || '')
    .replace(/(\d{7})\s+(?=\+?\d{7})/g, '$1|').split(/\s*(?:[|;,/\n]|\bor\b)\s*/i))
    .map(value => value.trim())
    .filter(value => {
      if (!/^\+?[\d\s().-]+$/.test(value)) return false;
      const digits = value.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 && !/^(\d)\1+$/.test(digits)
        && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value);
    }))].join(' | ');
  const isUsableImage = (value = '') => {
    const v = String(value || '').trim();
    return Boolean(v) && !/(?:\{\{|no[_-]?image|ad[_-]?placeholder|placeholder\.(?:svg|png|jpe?g|webp)|photoapparat|\/static\/images\/yoti\/|map\d*\.craigslist\.org)/i.test(v);
  };
  const publicationIssue = (row = {}) => {
    if (!phone(row.phone, row.phone_numbers, row.contactPhone, row.contact?.phone, row.realestate?.contactPhone, row.vehicle?.contactPhone, row.service?.phone)) return 'no_phone';
    const url = sourceUrl(row);
    // Reviewed against the user's screenshot: the rental's only photo is a dog.
    // Keep it out until the listing has been reviewed and this exclusion is cleared.
    if (key(url) === 'kijiji.ca/v-short-term-rental/city-of-toronto/room-for-rent/1741762769') return 'reviewed_image_mismatch';
    const a = attrs(row.attributes);
    if (identityText(row.title) === "men's leather jacket for sale" && String(row.image_urls || row.image_url || '').includes('fe86dfb2-511c-4ea9-848b-8671346f71fa')) return 'reviewed_image_mismatch';
    const proof = a.listingIdentity;
    if (proof) {
      if (key(proof.sourceUrl) !== key(url) || identityText(proof.title) !== identityText(row.title)) return 'source_identity_mismatch';
      const images = String(row.image_urls || row.image_url || '').split('|').filter(isUsableImage);
      if (images.some(value => !(proof.images || []).some(own => imageKey(own) === imageKey(value)))) return 'foreign_gallery';
      const digits = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      if (proof.phones?.length && phone(row.phone, row.phone_numbers).split(' | ').some(value => !proof.phones.some(own => digits(own) === digits(value)))) return 'foreign_contact';
      if (proof.sellerId && a.sellerId && String(proof.sellerId) !== String(a.sellerId)) return 'foreign_seller';
      if (proof.city && row.city && identityText(proof.city).replace(/^city of /, '') !== identityText(row.city).replace(/^city of /, '')) return 'foreign_location';
    } else if (a.sourceIdentityRequired || a.parser === 'kijiji_crawl4ai_sync' || (/kijiji\.ca\//.test(url) && Boolean(row.scraped_at || row.posted_at))) return 'source_identity_unverified';
    if (a.imageSourceUrl && key(a.imageSourceUrl) !== key(url)) return 'foreign_gallery';
    const images = String(row.image_urls || row.image_files || row.image_url || '').split('|').filter(isUsableImage);
    if (!images.length) return 'no_source_photo';
    return '';
  };
  const route = (category, subcategory = 'other', reason = 'source_category') => ({ target_surface: category === 'vehicles' ? 'vehicles' : 'marketplace', app_category: category, app_subcategory: subcategory, reason });
  const titleRoute = (value = '') => {
    const t = decode(value).toLowerCase();
    // Intent in the title outranks a provider's broad product category.
    // Buying physical goods is a buying service, not financial/legal advice.
    if (/\b(?:cash (?:for|4) (?:gold|silver|platinum|diamonds?|jewell?ery)|(?:gold|silver|platinum|gift cards?).{0,50}buyers?)\b/.test(t)) return route('services', 'other', 'title_intent');
    if (/\bbuy.{0,25}sell crypto\b/.test(t)) return route('services', 'financial', 'title_intent');
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
    const reviewed = a.categoryReview;
    if (reviewed && key(reviewed.sourceUrl) === key(url) && reviewed.title === title && reviewed.category && reviewed.subcategory) return route(reviewed.category, reviewed.subcategory, 'reviewed_listing');
    // User-reviewed monthly apartment rental; the provider's short-term bucket is incorrect.
    if (/^kijiji\.ca\/v-[^/]+\/[^/]+\/[^/]+\/1743443846$/.test(key(url))) return route('real_estate', 'for_rent_long', 'reviewed_listing');
    // Reviewed from the listing photos: this specific bundle contains body-care
    // products, although the seller filed it under bags and wallets. Never
    // classify an entire brand this way: Victoria's Secret also sells clothing.
    if (key(url) === 'kijiji.ca/v-women-bags-wallets/hamilton/10-labour-day-victoria-secret-bundle-for-10-cash-only-take/1743020393'
        && title.trim().toLowerCase() === '$10 labour day victoria secret bundle for $10 - cash only take!') return route('other', 'beauty_personal_care', 'reviewed_listing');
    // Concrete product/service intent outranks broad provider buckets. Keep these
    // title-only so a car mentioning its stereo or a house mentioning appliances stays put.
    const t0 = title.toLowerCase();
    const declared = String(row.app_category || row.appCategory || '').toLowerCase();
    if (declared === 'vehicles' && ['auto_parts', 'tires_rims'].includes(row.app_subcategory) && /\b(?:rims?|tires?|tyres?)\b/.test(t0)
        && !/\b(?:parts|shine|cover|caps?|spacer|sticker|strips?|changer|balancer|fender|lathe|straightener|repair|tools)\b/.test(t0)) return route('vehicles', 'tires_rims', 'product_type');
    if (/\b(?:mortgages?|bookkeeping|tax preparation|legal services|court documents)\b/.test(t0) && !/\b(?:house|condo|apartment|property) for sale\b/.test(t0)) return route('services', 'financial', 'title_intent');
    if (/\b(?:buying|we buy)\s+(?:all\s+)?(?:iphones?|phones?|macbooks?|ps[45])\b/.test(t0)) return route('services', 'other', 'title_intent');
    if (/\b(?:we (?:buy|pay cash for).{0,45}(?:cars?|vehicles)|scrap your car|sell your.{0,30}(?:honda|car).{0,20}cash)\b/.test(t0)) return route('services', 'other', 'title_intent');
    if (/\b(?:automotive.{0,50}repair|mobile window tinting|car key (?:&|and) fob)\b/.test(t0)) return route('vehicles', 'repairs', 'title_intent');
    if (/\b(?:hospital equipment.{0,40}(?:repair|installation)|biomedical engineering|furnace.{0,20}(?:repair|install)|plumb(?:ing|er)|renovations?|handy\s?man|demolition services)\b/.test(t0)) return route('services', 'skilled_trades', 'title_intent');
    if (/\b(?:mold removal|pest control|exhauster services|gutter cleaning|pool closings?|garage door.{0,25}(?:repair|services?)|appliance installation)\b/.test(t0)) return route('services', 'home_services', 'title_intent');
    if (/\b(?:tent rental|wedding.{0,35}(?:decor|drapes)|(?:reception|baby shower|engagement) decor)\b/.test(t0)) return route('services', 'events_services', 'title_intent');
    if (/\b(?:interiors? designer)\b/.test(t0)) return route('services', 'skilled_trades', 'title_intent');
    if (/\bempty truck going\b/.test(t0)) return route('services', 'travel', 'title_intent');
    if (/\b(?:streaming service|iptv servers|firestick and android box service|(?:mobile|cellphone) plan|android box device installation)\b/.test(t0)) return route('services', 'other', 'title_intent');
    if (/\b(?:commercial.{0,35}(?:spiral mixer|meat grinder)|french fry cutter|vending machine|wood molder|molder.{0,30}wood|car hoist|forklift parts)\b/.test(t0)) return route('other', 'tools_equipment', 'product_type');
    if (/\b(?:hospital bed|blood pressure monitor|nexus walker|vape juice)\b/.test(t0)) return route('other', 'miscellaneous', 'product_type');
    if (/\b(?:toyota.{0,40}hood|front bumper for caterpillar|car (?:subwoofer|cassette adaptor))\b/.test(t0)) return route('vehicles', 'auto_parts', 'product_type');
    if (/\b(?:job wanted|seeking (?:a )?job)\b/.test(t0)) return route('jobs', 'other', 'title_intent');
    if (/\b(?:cash for (?:phones?|iphones?)|buying all macbooks?|sell your phone|we pay (?:cash|more).{0,30}(?:iphone|samsung))\b/.test(t0)) return route('services', 'other', 'title_intent');
    if (/\b(?:scrap(?: & old)? cars?|junk cars?)\b/.test(t0) && /\b(?:we buy|we pay|towing|get|cash|removal)\b/.test(t0)) return route('services', 'other', 'title_intent');
    if (/\b(?:laptop|loptop|computer|iphone|phone|screen)\b.{0,45}\brepairs?\b|\bit (?:support|services)\b/.test(t0)) return route('services', 'other', 'title_intent');
    if (/\b(?:cleaning services?|furnace install|fridge waterline connection|gutter services|plumbing|pool closings|tree felling|tree removal)\b|\bmoving delivery furniture pick up\b/.test(t0)) return route('services', 'home_services', 'title_intent');
    if (/\b(?:electrical services|construction services|engine mechanic|backhoe.{0,35}services)\b/.test(t0)) return route('services', 'skilled_trades', 'title_intent');
    if (/\b(?:video editing|photography.{0,20}(?:services|serives)|real estate photography)\b/.test(t0)) return route('services', 'events_services', 'title_intent');
    if (/\b(?:private.{0,30}transport(?:ation)?|pick up drop off transport|personal driver)\b/.test(t0)) return route('services', 'travel', 'title_intent');
    if (/\b(?:car radio (?:unlocking|reprogramming|programming)|radio reprogramming|dpf def egr delete tuning)\b/.test(t0)) return route('vehicles', 'repairs', 'title_intent');
    if (/\b(?:car wash gun|car multimedia player|car emergency starter|jump starter|motor vehicle inverter|car backup camera|bluetooth cassette car player|dodge ram oem radio|daf parts)\b/.test(t0)) return route('vehicles', 'auto_parts', 'product_type');
    if (/\b(?:heat press|vinyl cutter|creasing perforating machine|badge maker|boring woodworking|hammer.{0,25}crusher|block machine|block making machine|gate operators|gate openers|small man lift)\b/.test(t0) && !/\b(?:photo frame|travel mug)\b/.test(t0)) return route('other', 'tools_equipment', 'product_type');
    if (declared !== 'real_estate' && /^(?:\d+\s*(?:ft|foot)\s*)?containers?$/i.test(title.trim())) return route('other', 'tools_equipment', 'product_type');
    if (/\b(?:bed sheets|wall (?:clock|decor|art)|ceramic (?:hamburger|pineapple)|salt.{0,12}pepper|mosquito.{0,30}curtains|dresser and drawer|desk table lamps)\b/.test(t0) || /^chairs$/i.test(title.trim())) return route('other', 'furniture_home_decor', 'product_type');
    if (/\b(?:air fryer|frying pan|empanada\/patty maker|rice cooker|fufu pounding|sandwich maker|chest freezer|refrigerator|tower fan|handheld fan|reverse osmosis|ro water purifier)\b/.test(t0) && !/\b(?:house|apartment|repair|install)\b/.test(t0)) return route('other', 'appliances', 'product_type');
    if (/\b(?:exercise equipment)\b/.test(t0)) return route('other', 'sports_outdoors', 'product_type');
    if (/\b(?:electric massager|electric hairdresser|nail dryer|pepper spray|hair clipper)\b/.test(t0)) return route('other', 'beauty_personal_care', 'product_type');
    if (/\b(?:nursing scrubs)\b/.test(t0)) return route('clothing', 'other', 'product_type');
    if (/\b(?:baby boy clothes|kids crocs)\b/.test(t0)) return route('clothing', 'kids', 'product_type');
    if (/\b(?:elitebook|probook|victus|pavillon|pavilion|dell latitude|acer aspire|hp envy|hp loptop|gaming monitor|usb adapter|sd memory card)\b/.test(t0)) return route('electronics', 'computers_tablets', 'product_type');
    if (/\b(?:tripod for phone|desktop tripod)\b/.test(t0)) return route('electronics', 'cameras_photography', 'product_type');
    if (/\b(?:fitbit|fitness tracker)\b/.test(t0)) return route('electronics', 'other', 'product_type');
    if (/\b(?:roku|t-con board|home cinema)\b/.test(t0)) return route('electronics', 'tv_video_home_theatre', 'product_type');
    if (/\b(?:driving lessons|training workshop|photography.{0,20}class|fx classes)\b/.test(t0)) return route('community', 'classes_lessons', 'title_intent');
    if (/\b(?:animal cage trap|goldendoodle)\b/.test(t0)) return route('other', 'pet_supplies', 'product_type');
    if (/\b(?:e-?bike conversion|electric bike)\b/.test(t0)) return route('other', 'sports_outdoors', 'product_type');
    if (declared === 'real_estate') {
      if (/\bshort[ -]term stay\b/.test(t0)) return route('real_estate', 'for_rent_short', 'title_intent');
      if (/\bfor rent\b/.test(t0) && !/\bfor sale\b/.test(t0) && row.app_subcategory !== 'for_rent_short') return route('real_estate', 'for_rent_long', 'title_intent');
      if (/\bfor sale\b/.test(t0) && !/\bfor rent\b/.test(t0)) return route('real_estate', 'for_sale', 'title_intent');
    }
    const intent = titleRoute(title);
    if (intent) return intent;
    const slug = url.match(/kijiji\.ca\/v-([^/]+)/i)?.[1] || '';
    const provider = String(a.sourceCategory || a.sourceName || row.source_category || row.source_site || '').toLowerCase();
    const sourceSubcategory = String(a.sourceSubcategory || '').toLowerCase();
    const category = String(row.app_category || row.appCategory || '').toLowerCase();
    // An explicit product type can correct a broad shopping/fashion bucket.
    // Ignore descriptions, where contact and cross-selling text is common.
    const productBucket = /^(?:clothing-.+|women-bags-wallets|jewelry-watch|health-special-needs|buy-sell-other)$/.test(slug)
      || /clothes|clothing|footwear|fashion|health.beauty|beauty.personal.care/.test(provider)
      || (!slug && ['clothing', 'other', 'buy_sell'].includes(category));
    if (productBucket) {
      if (/\b(?:perfumes?|colognes?|fragrances?|eau de (?:parfum|toilette)|body (?:mists?|sprays?|lotions?|butter|wash|care)|skin[ -]?care|cosmetics?|lipsticks?|lip gloss|mascara|shampoos?)\b/i.test(title)
          && !/\b(?:empty|vintage|antique)\b.{0,30}\b(?:bottles?|boxes?)\b/i.test(title)) return route('other', 'beauty_personal_care', 'product_type');
      if (/\b(?:smart\s*(?:glasses|watches?|watch)|fitness tracker)\b/i.test(title)) return route('electronics', 'other', 'product_type');
    }
    // Broad marketplace buckets need a concrete product signal, not a brand or
    // a description mentioning unrelated stock. Specific source categories win.
    if (slug === 'buy-sell-other' || (!slug && ['other', 'buy_sell', 'clothing'].includes(category))) {
      if (/\b(?:shoes?|sneakers?|footwear|sandals?|loafers?|stilettos?|ankle boots|rain boots|adidas samba|jordan [1-9]\d?)\b/i.test(title)
          && !/\b(?:brake|rack|cabinet|storage|repair)\b/i.test(title)) return route('clothing', 'shoes', 'product_type');
      if (/\b(?:bra|bras|shirts?|t-shirts?|hoodies?|dresses|jeans|pants|leggings|pajamas)\b/i.test(title)) return route('clothing', category === 'clothing' ? (row.app_subcategory || row.appSubcategory || 'other') : 'other', 'product_type');
      if (/\b(?:bumper|tail lamp|tail light|brake rotor|engine coolant)\b/i.test(title)) return route('vehicles', 'auto_parts', 'product_type');
      if (/\b(?:commercial.{0,50}(?:heat lamp|fryer|dough mixer|sink|stovetop|blender|slicer)|forklift|hoist.{0,30}lift|food marinator)\b/i.test(title)) return route('other', 'tools_equipment', 'product_type');
      if (/\b(?:phone gimbal|dji osmo)\b/i.test(title)) return route('electronics', 'cameras_photography', 'product_type');
    }
    if (/\b(?:piano|hot tub|junk) removal\b/i.test(title)) return route('services', 'home_services', 'title_intent');
    if (/\b(?:joy-con.{0,25}(?:fix|repair)|ps vita.{0,25}repair)\b/i.test(title)) return route('services', 'other', 'title_intent');
    if (/^cell-phone/.test(slug) && /\b(?:turn your.{0,20}phone into cash|sell your.{0,20}phone)\b/i.test(title)) return route('services', 'other', 'title_intent');
    if (/^(?:sport-bikes|sport-touring|motorcycles)$/.test(slug) && /\b(?:tail bag|saddlebags?|motorcycle parts)\b/i.test(title)) return route('vehicles', 'auto_parts', 'product_type');
    const rules = [
      [/^financial-legal$/, 'services', 'financial'],
      [/^excavation-demolition-waterproof$/, 'services', 'skilled_trades'],
      [/^(?:classic-cars|heavy-trucks)$/, 'vehicles', 'vehicles'],
      [/^(?:other-heavy-equipment|heavy-equipment-parts-accessories|tool-other)$/, 'other', 'tools_equipment'],
      [/^(?:computer-components|networking|monitors)$/, 'electronics', 'computers_tablets'],
      [/^(?:guitar|piano-keyboard|drums-percussion)$/, 'other', 'hobbies_collectibles'],
      [/^(?:horses-ponies|other-pets)$/, 'other', 'pet_supplies'],
      [/^baby-toy$/, 'other', 'baby_kids'],
      [/^(?:storage-organization|kitchen-dining|home-outdoor-other)$/, 'other', 'furniture_home_decor'],
      [/^plumbing-sink-toilet-shower$/, 'other', 'tools_equipment'],
      [/^(?:(?:mens?|womens?|kids?|children|boys|girls)-shoes|shoes|footwear)$/, 'clothing', 'shoes'],
      [/^(?:mens?|womens?)-(?:bags|wallets|accessories)$/, 'clothing', 'accessories'],
      [/^(?:sport-bikes|sport-touring|street-cruisers-choppers|dirt-bikes-motocross|scooters-pocket-bikes|snowmobiles|personal-watercraft)$/, 'vehicles', 'vehicles'],
      [/^(?:processor-blender-juicer|microwave|coffee-maker-espresso-machine|toaster-toaster-oven|iron-garment-steamer)$/, 'other', 'appliances'],
      [/^(?:nintendo-switch|nintendo-ds|nintendo-wii|sony-psp|sony-playstation-[1-5]|xbox-one|xbox-360|xbox-series-x-s)$/, 'electronics', 'gaming_consoles'],
      [/^(?:textbooks|fiction|children-young-adult|comics-graphic-novels)$/, 'other', 'hobbies_collectibles'],
      [/^(?:other-furniture|bookcase-shelves|coffee-table-ottoman|tv-table-entertainment-unit|chair-recliner|dresser-wardrobe)$/, 'other', 'furniture_home_decor'],
      [/^renovation-flooring-wall$/, 'other', 'tools_equipment'],
      [/^health-special-needs$/, 'other', 'beauty_personal_care'],
      [/^hot-tub-pool$/, 'other', 'sports_outdoors'],

      [/^(?:women-tops-outerwear|women-dresses-skirts|women-pants-shorts)$/, 'clothing', 'women'],
      [/^clothing-kid-youth$/, 'clothing', 'kids'],
      [/^(?:cats-kittens|dogs-puppies|fish|birds|pet-accessories|equestrian-livestock-accessories)$/, 'other', 'pet_supplies'],
      [/^(?:tutor-language-lessons)$/, 'community', 'classes_lessons'],
      [/^(?:drywall-stucco-removal|plumber|electrician)$/, 'services', 'skilled_trades'],
      [/^photography-video$/, 'services', 'events_services'],
      [/^(?:baby-lot|baby-feeding-high-chair)$/, 'other', 'baby_kids'],
      [/^(?:vacuum)$/, 'other', 'appliances'],
      [/^(?:home-phone-answering-machine)$/, 'electronics', 'phones_accessories'],
      [/^printers-scanners-fax$/, 'electronics', 'computers_tablets'],
      [/^performance-dj-equipment$/, 'electronics', 'audio_headphones'],
      [/^(?:tennis-and-racket)$/, 'other', 'sports_outdoors'],
      [/^(?:patio-garden-furniture|indoor-lighting-fan|indoor-decor-accent|hutch-display-cabinet|window-treatment)$/, 'other', 'furniture_home_decor'],
      [/^(?:industrial-kitchen-supplies|renovation-window-door-trim|renovation-other|outdoor-lighting)$/, 'other', 'tools_equipment'],
      [/^engines-and-engine-parts$/, 'vehicles', 'auto_parts'],
      [/^non-fiction$/, 'other', 'hobbies_collectibles'],

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
      [/^(?:health-beauty|beauty-personal-care)$/, 'other', 'beauty_personal_care'],
      [/^(?:art-collectibles|hobbies-craft|cd-dvd-blu-ray|musical-instrument)$/, 'other', 'hobbies_collectibles'],
      [/^(?:golf|fixie-single-speed|exercise-equipment|sporting-goods|bikes)$/, 'other', 'sports_outdoors'],
    ];
    for (const [pattern, category, subcategory] of rules) if (slug && pattern.test(slug)) return route(category, subcategory);
    // Explicit source taxonomies precede description keywords (e.g. car ads mentioning speakers).
    if (/baby-and-kids/.test(provider)) return route(/clothing|shoes/.test(sourceSubcategory) ? 'clothing' : 'other', /clothing|shoes/.test(sourceSubcategory) ? 'kids' : 'baby_kids');
    if (/books-music-and-hobbies/.test(provider)) return route('other', 'hobbies_collectibles');
    if (/business-and-industrial/.test(provider)) return route('other', 'tools_equipment');
    if (/education-and-training/.test(provider)) return route('community', 'classes_lessons');
    if (/home-furniture-and-appliances/.test(provider)) return route('other', /appliance/.test(sourceSubcategory) ? 'appliances' : 'furniture_home_decor');
    if (/pets-and-animals/.test(provider)) return route('other', 'pet_supplies');
    if (/travel-and-tourism/.test(provider)) return route('services', 'travel');
    if (/tires and rims|tires.rims/.test(provider)) return route('vehicles', 'tires_rims');
    if (/auto.parts|car parts|car accessories|spares|luggage racks/.test(provider)) {
      if (/\b(?:rims|tyres|tires)\b/i.test(title) && !/\b(?:shine|inflator|repair|cover)\b/i.test(title)) return route('vehicles', 'tires_rims');
      return route('vehicles', 'auto_parts');
    }
    if (/car rentals/.test(provider)) return route('vehicles', 'rentals');
    if (/auto services|auto repair/.test(provider)) return route('vehicles', 'repairs');
    if (/^(?:vehicles|cars|cars for sale)$|jacars (?:cars|vehicles)$|oxglow cars|carsforsale/.test(provider)) return route('vehicles', 'vehicles');
    if (/^(?:health-and-beauty|beauty-personal-care)$/.test(provider) && !/services|salon|spa/.test(sourceSubcategory)) return route('other', 'beauty_personal_care');
    if (provider === 'fashion') {
      if (/kids|baby/.test(sourceSubcategory)) return route('clothing', 'kids');
      if (/shoes|footwear/.test(sourceSubcategory)) return route('clothing', 'shoes');
      if (/watches|jewelry|accessories|bags/.test(sourceSubcategory)) return route('clothing', 'accessories');
      if (/women/.test(sourceSubcategory)) return route('clothing', 'women');
      if (/men/.test(sourceSubcategory)) return route('clothing', 'men');
    }
    if (/clothes|clothing|footwear/.test(provider)) return route('clothing', /\b(?:shoe|shoes|sneaker|sneakers|boots)\b/i.test(title) ? 'shoes' : /\b(?:shirt|pants|dress|jacket|apparel)\b/i.test(title) ? 'other' : 'accessories');
    if (/health beauty/.test(provider)) return route('other', 'beauty_personal_care');
    if (/home garden/.test(provider)) return route('other', 'furniture_home_decor');
    if (/hobbies sports/.test(provider)) return route('other', 'sports_outdoors');
    if (/kids stuff/.test(provider)) return route('other', 'baby_kids');
    if (/animals pets/.test(provider)) return route('other', 'pet_supplies');
    if (/jacars tools|other business/.test(provider)) return route('other', 'tools_equipment');
    const t = title.toLowerCase();
    const sub = String(row.app_subcategory || row.appSubcategory || 'other').toLowerCase();
    // Refine broad electronics buckets using the item title, never contact/delivery boilerplate.
    if (/electronics|mobile phones|computers|audio visual/.test(provider) || category === 'electronics' || /^(?:buy-sell-other|general-electronics)$/.test(slug)) {
      if (/\b(?:washing\s*machine|washers?|dryers?|fridge|refrigerator|(?:deep|chest) freezer|stove|dishwasher|cooktop|blender|toaster|food processor|meat slicer|induction cooker|coffee machine)\b/.test(t)) return route('other', 'appliances', 'title');
      if (/\b(?:laptop|loptop|macbook|computer|ipad|tablet|pc|vga|desktop|motherboard|(?:lenovo (?:ideapad|thinkvision|tm80qb|loq|legion|v14))|dell (?:xps|ac\/dc)|hp (?:840|elite dragonfly)|surface|wireless keyboard|(?:arc )?mouse|usb.{0,15}hub|type-c.{0,15}hub|type-c.{0,15}\d in \d hub|memory (?:expansion )?card)\b/.test(t)) return route('electronics', 'computers_tablets', 'title');
      if (/\b(?:projector|tv|tvs|t v|television|blu\s?ray|dvd players?|android tv box)\b/.test(t)) return route('electronics', 'tv_video_home_theatre', 'title');
      if (/\b(?:headphones?|earbuds?|buds|speakers?|microphones?|jbl|airpods|headset|sound\s?bar|stereo|am\/fm radio|av receiver|surround (?:sound|system)|home (?:theat(?:er|re)|cinema)|hafler.{0,15}amp|podcast equipment)\b/.test(t)) return route('electronics', 'audio_headphones', 'title');
      if (/\b(?:play\s?station|xbox|nintendo|ps[345]|gaming console|meta quest|logitech g29)\b/.test(t)) return route('electronics', 'gaming_consoles', 'title');
      if (/\b(?:camera|camcorder|lens|canon (?:sl1|eos|r50)|studio lighting)\b/.test(t)) return route('electronics', 'cameras_photography', 'title');
      if (/\b(?:iphone|smartphone|cell\s?phone|phones?|galaxy|redmi|pixel|nokia|oukitel|tecno|red magic|mifi)\b/.test(t)) return route('electronics', 'phones_accessories', 'title');
      if (/\b(?:guitar|piano|drum|collectible)\b/.test(t)) return route('other', 'hobbies_collectibles', 'title');
    }
    if (slug === 'general-electronics') return route('electronics', 'other');
    if (slug && !category) return route('other', 'miscellaneous');
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
  const applyRepair = (row = {}, repair) => {
    if (!repair || (repair.sourceUrl && key(repair.sourceUrl) !== key(sourceUrl(row)))) return { ...row };
    const title = String(row.title || '').trim().toLowerCase();
    if (![repair.title, repair.replacementTitle].filter(Boolean).some(t => String(t).trim().toLowerCase() === title)) return { ...row };
    const result = { ...row };
    if (repair.listingIdentity) {
      const proof = repair.listingIdentity;
      const current = attrs(row.attributes).listingIdentity;
      if (!current || !current.checkedAt || current.checkedAt <= proof.checkedAt) {
        result.attributes = JSON.stringify({ ...attrs(row.attributes), listingIdentity: proof });
        if (repair.sourceFields) for (const [field, value] of Object.entries(repair.sourceFields)) { if (field in row) result[field] = value; }
        if (repair.replacementCity) result.city = repair.replacementCity;
        if (repair.replacementPhone) {
          if ('phone' in row) result.phone = repair.replacementPhone;
          if ('phone_numbers' in row) result.phone_numbers = repair.replacementPhone;
        }
      }
    }
    let a = { ...attrs(result.attributes || row.attributes) };
    if (repair.replacementTitle) result.title = repair.replacementTitle;
    if (repair.category && repair.subcategory) {
      Object.assign(result, route(repair.category, repair.subcategory, 'reviewed_listing'));
      a.categoryReview = { sourceUrl: sourceUrl(row), title: result.title, category: repair.category, subcategory: repair.subcategory, checkedAt: repair.checkedAt };
    }
    if (repair.holdReason) {
      result.status = 'rejected';
      result.sync_visibility = repair.holdReason;
      result.sync_visibility_reason = repair.reviewNote || repair.holdReason;
    }
    if (Array.isArray(repair.images) && repair.images.length && (!a.imageVerifiedAt || a.imageVerifiedAt < repair.checkedAt)) {
      result.image_urls = repair.images.filter(isUsableImage).join('|');
      result.image_files = '';
      if ('image_url' in row) result.image_url = result.image_urls.split('|')[0] || '';
      a = { ...a, imageVerifiedAt: repair.checkedAt, imageSourceUrl: sourceUrl(row), imageIntegrityVersion: VERSION };
    }
    if (Array.isArray(repair.excludedImages)) {
      const excluded = new Set(repair.excludedImages.map(normalizeImage));
      for (const field of ['image_urls', 'image_files', 'image_url']) {
        if (result[field]) result[field] = String(result[field]).split('|').filter(value => !excluded.has(normalizeImage(value))).join('|');
      }
    }
    result.attributes = JSON.stringify(a);
    return result;
  };
  const normalizeImage = (value = '', url = '') => {
    let v = decode(value).trim();
    if (!isUsableImage(v) || /(?:\/logo|\/avatar|\/icon)/i.test(v)) return '';
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
        primary = Object.values(state).find(v => v && ['StandardListing', 'AutosListing', 'RealEstateListing'].includes(v.__typename) && String(v.id) === expectedId && (!v.url || v.url.match(/\/(\d+)(?:[?#]|$)/)?.[1] === expectedId));
        if (primary) {
          // IDs alone are insufficient: a stale or fabricated slug may resolve to
          // another seller's ad with the same numeric ID. Verify the whole identity.
          if ((primary.url && key(primary.url) !== key(url)) || (row.title && identityText(primary.title) !== identityText(row.title))) return { images: [], title: primary.title || '', sourceUrl: primary.url || '', matched: false, identityIssue: 'source_identity_mismatch', method: 'listing_identity' };
          const images = [...new Set(imageValues(primary.imageUrls).map(v => normalizeImage(v, url)).filter(Boolean))].slice(0, 12);
          const contacts = phone(primary.posterInfo?.phoneNumber);
          const copy = String(`${primary.title || ''}\n${primary.description || ''}`);
          const publicPhones = [...copy.matchAll(/(?:^|[^\d])((?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})(?!\d)/g)].filter(m => /[\s().-]/.test(m[1]) || /\b(?:call|text|phone|contact|whatsapp|tel)\b/i.test(copy.slice(Math.max(0, m.index - 45), m.index + m[0].length + 25))).map(m => m[1]);
          return { images, title: primary.title || '', sourceUrl: primary.url || url, city: primary.location?.name || '', sourceDescription: primary.description || '', price: primary.price || {}, locationAddress: primary.location?.address || '', sellerId: String(primary.posterInfo?.posterId || ''), phones: phone(contacts, ...publicPhones).split(' | ').filter(Boolean), availability: String(primary.status || 'active').toLowerCase(), matched: images.length > 0, method: 'listing_identity' };
        }
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
    if (primary) return { images: [...new Set(imageValues(primary.image).map(v => normalizeImage(v, url)).filter(Boolean))].slice(0,12), title: row.title || primary.name || '', sourceTitle: primary.name || '', sourceUrl: url, matched: true, method: 'primary_structured_data' };
    // Craigslist's gallery is a dedicated data object, never map/nearby ad images.
    if (/craigslist\.org/.test(url) && (sameUrl(canonical) || entities.some(e => e?.['@type'] === 'BreadcrumbList' && (e.itemListElement || []).some(i => sameUrl(i.item))))) {
      const gallery = String(html).match(/(?:var\s+)?imgList\s*=\s*(\[[\s\S]*?\]);/)?.[1];
      try { const images = JSON.parse(gallery || '[]').map(i => normalizeImage(i.url,url)).filter(v => /^https?:\/\/images\.craigslist\.org\//.test(v)); if(images.length) return {images,matched:true,method:'source_gallery'}; } catch {}
    }
    return {images:[], matched:false, method:'unverified'};
  };
  const verifyRecord = (row = {}, html = '', checkedAt = new Date().toISOString()) => {
    const result = extract(html, row);
    if (!result.matched || !result.images.length || !result.title) return { row: { ...row }, result };
    const proof = { version: VERSION, sourceUrl: sourceUrl(row), title: result.title, images: result.images, phones: result.phones || [], sellerId: result.sellerId || '', city: result.city || '', checkedAt };
    const verified = { ...row, city: result.city || row.city, image_urls: result.images.join('|'), image_files: '', attributes: JSON.stringify({ ...attrs(row.attributes), listingIdentity: proof, imageIntegrityVersion: VERSION, imageVerifiedAt: checkedAt, imageSourceUrl: sourceUrl(row) }) };
    if (/kijiji\.ca\//.test(sourceUrl(row)) && result.price) {
      const price = result.price;
      const amount = Number(price.amount) / 100;
      const priceText = price.type === 'GIVE_AWAY' ? 'Free' : price.type === 'PLEASE_CONTACT' ? 'Contact for price' : Number.isFinite(amount) ? `CA$ ${amount.toFixed(2)}` : '';
      if (priceText) {
        if ('price_text' in row) verified.price_text = priceText;
        if ('price' in row) verified.price = priceText;
        if ('price_value' in row) verified.price_value = price.type === 'FIXED' || price.type === 'NEGOTIABLE' ? String(amount) : '';
      }
      if (result.sourceDescription) verified.description = result.sourceDescription.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim();
    }
    if (result.phones?.length) {
      if ('phone' in row) verified.phone = result.phones.join(' | ');
      if ('phone_numbers' in row) verified.phone_numbers = result.phones.join(' | ');
    }
    if (result.sellerId) verified.attributes = JSON.stringify({ ...attrs(verified.attributes), sellerId: result.sellerId });
    if ('image_url' in row) verified.image_url = result.images[0];
    const issue = publicationIssue(verified);
    return { row: verified, result: { ...result, identityIssue: issue } };
  };
  const matchCrawlResult = (items, url) => items.find(item => key(item?.url || '') === key(url)) || null;
  return { VERSION, key, identityText, imageKey, sourceUrl, phone, publicationIssue, classify, applyRepair, isUsableImage, normalizeImage, extract, verifyRecord, matchCrawlResult };
}
module.exports = createListingIntegrity();
