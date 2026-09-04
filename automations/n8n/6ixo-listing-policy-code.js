const config = $input.first().json;
const OWNER = clean(config.githubOwner || 'bisco401');
const REPO = clean(config.githubRepo || '6ixo');
const BRANCH = clean(config.githubBranch || 'main');
const CSV_PATH = clean(config.csvPath || 'data/scraped-listings.csv');
const TOKEN = clean(config.githubToken || '');

if (!TOKEN || TOKEN === 'PASTE_GITHUB_TOKEN_HERE') {
  throw new Error('Set GITHUB_TOKEN in n8n with GitHub repository contents permission.');
}

const policyOptions = {
  maxImages: config.maxImages || 4,
  maxListingsPerCountry: config.maxListingsPerCountry || 50,
  deleteAfterMisses: config.deleteAfterMisses || 1,
  allowedCategories: config.allowedCategoriesJson || DEFAULT_ALLOWED_CATEGORIES,
  countries: config.countriesJson || [],
};

const githubHeaders = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
};

const http = async ({ url, method = 'GET', body }) => {
  const response = await this.helpers.httpRequest({
    url,
    method,
    headers: githubHeaders,
    body,
    json: Boolean(body),
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 120000,
  });
  const status = Number(response?.statusCode ?? response?.status ?? 200);
  return { status, ok: status >= 200 && status < 300, body: response?.body ?? response };
};

const contentUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CSV_PATH.split('/').map(encodeURIComponent).join('/')}`;

const readRemoteCsv = async () => {
  const response = await http({ url: `${contentUrl}?ref=${encodeURIComponent(BRANCH)}` });
  if (!response.ok) throw new Error(`GitHub CSV read failed with HTTP ${response.status}.`);
  const metadata = response.body || {};
  if (!clean(metadata.sha)) throw new Error('GitHub did not return a CSV blob SHA.');
  let text = '';
  if (metadata.content && metadata.encoding === 'base64') {
    text = Buffer.from(String(metadata.content).replace(/\n/g, ''), 'base64').toString('utf8');
  }
  if (!text && metadata.download_url) {
    const raw = await http({ url: metadata.download_url });
    if (!raw.ok) throw new Error(`GitHub raw CSV read failed with HTTP ${raw.status}.`);
    text = typeof raw.body === 'string' ? raw.body : String(raw.body || '');
  }
  return { sha: metadata.sha, text };
};

const applyRemotePolicy = async () => {
  const remote = await readRemoteCsv();
  const parsed = parseCsv(remote.text);
  if (!parsed.headers.length) throw new Error('The remote listings CSV has no header row.');
  const required = ['id', 'status', 'country', 'app_category', 'image_urls', 'source_url', 'scraped_at'];
  const missing = required.filter((header) => !parsed.headers.includes(header));
  if (missing.length) throw new Error(`The listings CSV is missing required columns: ${missing.join(', ')}.`);

  const sourceUrls = new Set();
  for (const row of parsed.rows) {
    const sourceUrl = clean(row.source_url);
    if (!sourceUrl) throw new Error(`Listing ${clean(row.id) || '(unknown id)'} has no source_url.`);
    if (sourceUrls.has(sourceUrl)) throw new Error(`Duplicate source_url found: ${sourceUrl}`);
    sourceUrls.add(sourceUrl);
  }

  const result = applyListingPolicy(parsed.rows, policyOptions);
  const csv = toCsv(parsed.headers, result.rows);
  if (csv === remote.text.replace(/^\uFEFF/, '')) {
    return { ...result, changed: false, commitUrl: '' };
  }

  const save = await http({
    url: contentUrl,
    method: 'PUT',
    body: {
      message: 'Enforce listing freshness, image, and country limits',
      branch: BRANCH,
      sha: remote.sha,
      content: Buffer.from(csv, 'utf8').toString('base64'),
    },
  });
  return { ...result, changed: true, save };
};

let outcome = await applyRemotePolicy();
if (outcome.save?.status === 409) outcome = await applyRemotePolicy();
if (outcome.save && !outcome.save.ok) {
  throw new Error(`GitHub CSV update failed with HTTP ${outcome.save.status}.`);
}

return [{
  json: {
    status: outcome.changed ? 'updated' : 'no_change',
    csvPath: CSV_PATH,
    limits: {
      maxImages: positiveInteger(policyOptions.maxImages, 4, 4),
      maxListingsPerCountry: positiveInteger(policyOptions.maxListingsPerCountry, 50, 50),
      deleteAfterMisses: positiveInteger(policyOptions.deleteAfterMisses, 1, 20),
    },
    ...outcome.stats,
    deletedListingIds: outcome.deletedRows.map((row) => row.id).filter(Boolean),
    commitUrl: outcome.save?.body?.commit?.html_url || '',
  },
}];
