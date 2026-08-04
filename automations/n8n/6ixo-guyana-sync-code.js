const config = $input.first().json;
const OWNER = config.githubOwner || 'bisco401';
const REPO = config.githubRepo || '6ixo';
const BRANCH = config.githubBranch || 'main';
const CSV_PATH = config.csvPath || 'data/scraped-listings.csv';
const TOKEN = String($env.GITHUB_TOKEN || '').trim();
const CRAWL4AI_URL = String($env.CRAWL4AI_URL || config.crawl4aiUrl || 'http://crawl4ai:11235/crawl').trim();
const SITEMAP_URL = config.sitemapUrl || 'https://carsforsale.gy/sitemap-listings.xml';
const MAX_CANDIDATES = Math.max(1, Number(config.maxCandidates || 40));
const MAX_LISTINGS = Math.max(1, Number(config.maxListings || 20));
const BATCH_SIZE = Math.max(1, Number(config.detailBatchSize || 5));
const DEFAULT_STATUS = config.defaultImportStatus || 'published';

if (!TOKEN) throw new Error('GITHUB_TOKEN is missing from the n8n environment.');

const http = async ({ url, method = 'GET', headers = {}, body, json = false }) => {
  const response = await this.helpers.httpRequest({
    url,
    method,
    headers,
    body,
    json,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 180000
  });
  const responseStatus = Number(response?.statusCode ?? response?.status);
  const status = Number.isFinite(responseStatus) && responseStatus > 0 ? responseStatus : 200;
  return { status, ok: status >= 200 && status < 300, body: response.body ?? response };
};

const ghHeaders = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28'
};
const clean = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
const decode = (value = '') => String(value || '')
  .replace(/&amp;/g, '&')
  .replace(/&quot;|&#34;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&#x2F;/g, '/');
const strip = (value = '') => clean(decode(String(value || ''))
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' '));
const absoluteUrl = (value, base = 'https://carsforsale.gy') => {
  try { return new URL(String(value || ''), base).toString(); }
  catch { return clean(value); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseSitemap = (xml = '') => {
  const rows = [];
  for (const block of String(xml || '').match(/<url>[\s\S]*?<\/url>/gi) || []) {
    const url = decode(block.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1] || '').trim();
    const id = url.match(/\/listing\/(\d+)\//)?.[1] || '';
    if (!url || !id) continue;
    const lastmod = clean(block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1] || '');
    const images = [...block.matchAll(/<image:loc>([\s\S]*?)<\/image:loc>/gi)]
      .map((match) => decode(match[1]).trim())
      .filter(Boolean);
    rows.push({ id, url, lastmod, images: [...new Set(images)].slice(0, 12) });
  }
  return rows.sort((a, b) => `${b.lastmod}-${b.id}`.localeCompare(`${a.lastmod}-${a.id}`));
};

const normalizeCrawlItems = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeCrawlItems);
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.data)) return value.data;
  if (value.body) return normalizeCrawlItems(value.body);
  return [value];
};

const crawlBatch = async (urls) => {
  const response = await http({
    url: CRAWL4AI_URL,
    method: 'POST',
    body: {
      urls,
      browser_config: {
        headless: true,
        viewport: { width: 1365, height: 1800 },
        verbose: false
      },
      crawler_config: {
        stream: false,
        cache_mode: 'bypass',
        wait_until: 'load',
        wait_for: 'css:body',
        page_timeout: 60000,
        delay_before_return_html: 0.5,
        scan_full_page: false,
        // The public seller contact is in a sticky card, so it must remain.
        remove_overlay_elements: false,
        remove_consent_popups: true
      }
    },
    json: true
  });
  if (!response.ok) throw new Error(`Crawl4AI returned HTTP ${response.status}.`);
  return normalizeCrawlItems(response.body);
};

const parseJsonLdCar = (html = '') => {
  for (const match of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decode(match[1]).trim());
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const car = values.find((value) => value && ['Car', 'Vehicle'].includes(value['@type']));
      if (car) return car;
    } catch {}
  }
  return null;
};

const detailFields = (html = '') => {
  const fields = {};
  const pattern = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    fields[strip(match[1]).toLowerCase()] = strip(match[2]);
  }
  return fields;
};

const publicPhone = (html = '') => {
  const phone = String(html || '').match(/href=["']https:\/\/wa\.me\/(\d+)/i)?.[1] || '';
  return phone.startsWith('592') ? `+${phone}` : '';
};

const sourceProfile = (html = '', seller = '') => {
  for (const match of String(html || '').matchAll(/<a[^>]+href=["'](\/dealers\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!seller || strip(match[2]).toLowerCase().includes(seller.toLowerCase())) {
      return absoluteUrl(match[1]);
    }
  }
  return '';
};

const formatPrice = (value, currency) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  const prefix = currency === 'GYD' ? 'G$ ' : currency === 'USD' ? 'US$ ' : `${currency} `;
  return prefix + Math.round(amount).toLocaleString('en-US');
};

const normalizeListing = (candidate, crawlItem) => {
  if (crawlItem.success === false) return null;
  const html = crawlItem.html || crawlItem.cleaned_html || '';
  if (!html || /Just a moment|cf-mitigated|challenges\.cloudflare\.com/i.test(html)) return null;
  const car = parseJsonLdCar(html);
  if (!car) return null;
  const phone = publicPhone(html);
  if (!phone) return null;
  const images = [...new Set(candidate.images || [])].filter((url) => /^https:\/\/media\.carsforsale\.gy\/listings\//i.test(url)).slice(0, 12);
  if (!images.length) return null;

  const offers = car.offers && typeof car.offers === 'object' ? car.offers : {};
  const sellerData = offers.seller && typeof offers.seller === 'object' ? offers.seller : {};
  const seller = clean(sellerData.name) || 'Private seller';
  const fields = detailFields(html);
  const brand = car.brand && typeof car.brand === 'object' ? clean(car.brand.name) : clean(car.brand);
  const model = clean(car.model);
  const year = clean(car.vehicleModelDate || car.modelDate);
  const title = clean([year, brand, model].filter(Boolean).join(' ')) || clean(car.name);
  const location = fields.location || '';
  const parenthetical = location.match(/\(([^()]+)\)\s*$/)?.[1] || '';
  const city = location.includes('·') ? clean(location.split('·').pop()) : clean(parenthetical || location || 'Georgetown');
  const currency = clean(offers.priceCurrency).toUpperCase();
  const price = clean(offers.price);
  const sourceCondition = fields.condition || clean(car.itemCondition).split('/').pop();
  const condition = /new/i.test(sourceCondition) && !/used/i.test(sourceCondition) ? 'new' : (/used/i.test(sourceCondition) ? 'used' : '');
  const mileage = car.mileageFromOdometer && typeof car.mileageFromOdometer === 'object'
    ? clean(car.mileageFromOdometer.value)
    : (fields.mileage || '').replace(/\D/g, '');
  const engine = car.vehicleEngine && typeof car.vehicleEngine === 'object' ? car.vehicleEngine : {};
  const displacement = engine.engineDisplacement && typeof engine.engineDisplacement === 'object' ? engine.engineDisplacement : {};
  const sourceUrl = clean(offers.url) || candidate.url;
  const now = new Date().toISOString();
  const attributes = {
    parser: 'crawl4ai_carsforsale_gy',
    sourceLastModified: candidate.lastmod,
    sellerProfileUrl: sourceProfile(html, seller),
    sellerType: clean(sellerData['@type']),
    bodyType: clean(car.bodyType),
    fuelType: clean(car.fuelType),
    drivetrain: fields.drivetrain || '',
    engineCc: clean(displacement.value) || (fields.engine || '').replace(/\D/g, ''),
    sourceCondition,
    contactSource: 'public seller-enabled WhatsApp'
  };
  return {
    id: `carsforsale-gy-${candidate.id}`,
    status: DEFAULT_STATUS,
    target_surface: 'vehicles',
    app_category: 'vehicles',
    app_subcategory: 'vehicles',
    title,
    price_text: formatPrice(price, currency),
    price_value: price,
    currency,
    city,
    country: 'Guyana',
    seller,
    phone,
    description: clean(car.description),
    image_urls: images.join('|'),
    source_site: 'carsforsale.gy',
    source_url: sourceUrl,
    scraped_at: now,
    make: brand,
    model,
    trim: '',
    year,
    condition,
    transmission: clean(car.vehicleTransmission) || fields.transmission || '',
    color: clean(car.color) || fields.color || '',
    mileage_km: mileage,
    attributes: JSON.stringify(attributes),
    source_availability: 'active',
    source_availability_checked_at: now,
    source_http_status: String(crawlItem.status_code || 200),
    source_unavailable_reason: '',
    source_last_seen_at: now,
    source_resolved_url: clean(crawlItem.redirected_url) || sourceUrl
  };
};

const parseCsv = (text = '') => {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); records.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); records.push(row); }
  const headers = records.shift() || [];
  return { headers, rows: records.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i] || '']))) };
};

const csvEscape = (value = '') => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const toCsv = (headers, rows) => [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header] || '')).join(','))].join('\n') + '\n';

const REQUIRED_CSV_HEADERS = [
  'id', 'status', 'target_surface', 'app_category', 'title', 'phone',
  'image_urls', 'source_site', 'source_url', 'scraped_at'
];

const validateParsedCsv = (parsed, context, { requireRows = true } = {}) => {
  const headers = Array.isArray(parsed?.headers) ? parsed.headers.map((header) => clean(header)) : [];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  if (!headers.length) throw new Error(`${context} has no CSV header row.`);
  if (headers.some((header) => !header)) throw new Error(`${context} has an empty CSV header.`);
  if (new Set(headers).size !== headers.length) throw new Error(`${context} has duplicate CSV headers.`);
  const missingHeaders = REQUIRED_CSV_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length) throw new Error(`${context} is missing required CSV headers: ${missingHeaders.join(', ')}.`);
  if (requireRows && !rows.length) throw new Error(`${context} contains no listing rows; refusing to overwrite the repository CSV.`);

  const sourceUrls = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const sourceUrl = clean(rows[index].source_url);
    if (!sourceUrl) throw new Error(`${context} row ${index + 2} has no source_url; refusing a lossy merge.`);
    if (sourceUrls.has(sourceUrl)) throw new Error(`${context} contains duplicate source_url values: ${sourceUrl}`);
    sourceUrls.add(sourceUrl);
  }
  return { headers, rows, sourceUrls };
};

const getRemoteCsv = async () => {
  const metadataUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CSV_PATH}?ref=${encodeURIComponent(BRANCH)}`;
  const metadata = await http({ url: metadataUrl, headers: ghHeaders, json: true });
  if (!metadata.ok) throw new Error(`GitHub CSV metadata GET failed with HTTP ${metadata.status}.`);
  const data = metadata.body || {};
  if (!clean(data.sha)) throw new Error('GitHub CSV metadata did not include a blob SHA.');
  let text = '';
  if (data.content && data.encoding === 'base64') text = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
  if (!text) {
    const rawUrl = data.download_url || `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${CSV_PATH}`;
    const raw = await http({ url: rawUrl, headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/csv' }, json: false });
    if (!raw.ok) throw new Error(`GitHub raw CSV GET failed with HTTP ${raw.status}.`);
    text = typeof raw.body === 'string' ? raw.body : String(raw.body || '');
  }
  return { sha: data.sha, text };
};

const putRemoteCsv = async (text, sha) => {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CSV_PATH}`;
  return http({
    url,
    method: 'PUT',
    headers: ghHeaders,
    body: {
      message: 'Import recent Guyana vehicle listings',
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: BRANCH,
      sha
    },
    json: true
  });
};

const sitemapResponse = await http({ url: SITEMAP_URL, headers: { accept: 'application/xml,text/xml' }, json: false });
if (!sitemapResponse.ok) throw new Error(`Guyana sitemap returned HTTP ${sitemapResponse.status}.`);
const candidates = parseSitemap(sitemapResponse.body).slice(0, MAX_CANDIDATES);
if (!candidates.length) throw new Error('No public Guyana listing URLs were found in the sitemap.');
const candidateByUrl = new Map(candidates.map((item) => [item.url.replace(/\/$/, ''), item]));
const normalized = [];
for (let start = 0; start < candidates.length && normalized.length < MAX_LISTINGS; start += BATCH_SIZE) {
  const batch = candidates.slice(start, start + BATCH_SIZE);
  for (const item of await crawlBatch(batch.map((candidate) => candidate.url))) {
    const key = clean(item.url || item.redirected_url).replace(/\/$/, '');
    const candidate = candidateByUrl.get(key);
    if (!candidate) continue;
    const row = normalizeListing(candidate, item);
    if (row) normalized.push(row);
  }
  if (normalized.length < MAX_LISTINGS) await sleep(1000);
}
const selected = normalized
  .sort((a, b) => JSON.parse(b.attributes).sourceLastModified.localeCompare(JSON.parse(a.attributes).sourceLastModified))
  .slice(0, MAX_LISTINGS);
if (!selected.length) throw new Error('No Guyana listings had a public +592 WhatsApp number and an image gallery.');

const mergeRows = async () => {
  const remote = await getRemoteCsv();
  const parsed = parseCsv(remote.text);
  const existing = validateParsedCsv(parsed, 'Remote GitHub CSV');
  const headers = [...existing.headers];
  for (const row of selected) for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  const byUrl = new Map(existing.rows.map((row) => [clean(row.source_url), row]));
  for (const row of selected) byUrl.set(clean(row.source_url), { ...(byUrl.get(clean(row.source_url)) || {}), ...row });
  const mergedRows = [...byUrl.values()];
  const csv = toCsv(headers, mergedRows);
  const reparsed = validateParsedCsv(parseCsv(csv), 'Generated merged CSV');
  if (reparsed.rows.length < existing.rows.length) {
    throw new Error(`Generated merged CSV lost rows (${existing.rows.length} -> ${reparsed.rows.length}); update cancelled.`);
  }
  for (const sourceUrl of existing.sourceUrls) {
    if (!reparsed.sourceUrls.has(sourceUrl)) throw new Error(`Generated merged CSV lost ${sourceUrl}; update cancelled.`);
  }
  return { remote, csv };
};

let merged = await mergeRows();
let saved = await putRemoteCsv(merged.csv, merged.remote.sha);
if (saved.status === 409) {
  await sleep(1200);
  merged = await mergeRows();
  saved = await putRemoteCsv(merged.csv, merged.remote.sha);
}
if (!saved.ok) throw new Error(`GitHub CSV update failed with HTTP ${saved.status}.`);

return [{
  json: {
    source: 'carsforsale.gy',
    status: 'success',
    candidatesChecked: candidates.length,
    publishedListings: selected.length,
    localPhoneOnly: true,
    commitUrl: saved.body?.commit?.html_url || ''
  }
}];
