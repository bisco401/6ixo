import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'indexnow.config.json');

const usage = `Submit canonical 6ixo URLs to IndexNow.

Usage:
  node scripts/submit-indexnow.mjs
  node scripts/submit-indexnow.mjs --url https://6ixo.com/cars-for-sale/
  node scripts/submit-indexnow.mjs --dry-run

Options:
  --url <url>  Submit one URL instead of every URL in sitemap.xml. Repeatable.
  --dry-run    Validate and print the submission without contacting IndexNow.
  --help       Show this help.`;

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(usage);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const requestedUrls = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--dry-run') continue;
  if (argument === '--url') {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--url requires an absolute URL');
    requestedUrls.push(value);
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${argument}\n\n${usage}`);
}

const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
const originUrl = new URL(config.origin);
const origin = originUrl.origin;
if (config.origin !== origin || originUrl.pathname !== '/') {
  throw new Error('indexnow.config.json origin must contain only the canonical HTTPS origin');
}
if (originUrl.protocol !== 'https:') throw new Error('IndexNow origin must use HTTPS');
if (config.endpoint !== 'https://api.indexnow.org/indexnow') {
  throw new Error('IndexNow endpoint must be https://api.indexnow.org/indexnow');
}

const keyFile = String(config.keyFile || '');
if (path.basename(keyFile) !== keyFile || !/^[A-Za-z0-9-]{8,128}\.txt$/.test(keyFile)) {
  throw new Error('IndexNow keyFile must be a valid root-level .txt filename');
}
const key = (await fs.readFile(path.join(ROOT, keyFile), 'utf8')).trim();
if (key !== keyFile.slice(0, -4)) {
  throw new Error('The IndexNow key file name and contents must contain the same key');
}

let urls = requestedUrls;
if (!urls.length) {
  const sitemap = await fs.readFile(path.join(ROOT, 'sitemap.xml'), 'utf8');
  urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim());
}
urls = [...new Set(urls)];
if (!urls.length) throw new Error('No URLs were found to submit');

for (const url of urls) {
  const parsed = new URL(url);
  if (parsed.origin !== origin || parsed.search || parsed.hash) {
    throw new Error(`IndexNow URL must be a clean canonical URL on ${origin}: ${url}`);
  }
}

const keyLocation = `${origin}/${keyFile}`;
const payload = {
  host: originUrl.host,
  key,
  keyLocation,
  urlList: urls
};

if (dryRun) {
  console.log(`IndexNow dry run passed for ${urls.length} URL(s).`);
  console.log(`Key location: ${keyLocation}`);
  console.log(`Endpoint: ${config.endpoint}`);
  process.exit(0);
}

let keyResponse;
try {
  keyResponse = await fetch(keyLocation, {
    redirect: 'error',
    headers: {
      'cache-control': 'no-cache',
      'user-agent': '6ixo-indexnow/1.0'
    }
  });
} catch (error) {
  throw new Error(`Could not verify the deployed IndexNow key at ${keyLocation}: ${error.message}`);
}
if (!keyResponse.ok || (await keyResponse.text()).trim() !== key) {
  throw new Error(`Deploy ${keyFile} at ${keyLocation} before submitting URLs to IndexNow`);
}

const response = await fetch(config.endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': '6ixo-indexnow/1.0'
  },
  body: JSON.stringify(payload)
});

if (response.status !== 200 && response.status !== 202) {
  const responseBody = (await response.text()).trim();
  throw new Error(`IndexNow returned HTTP ${response.status}${responseBody ? `: ${responseBody}` : ''}`);
}

console.log(`IndexNow accepted ${urls.length} URL(s) with HTTP ${response.status}.`);
