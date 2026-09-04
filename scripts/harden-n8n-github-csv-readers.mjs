#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  ['automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json', 'http'],
  ['automations/n8n/6ixo-crawl4ai-texas-craigslist.json', 'http'],
  ['automations/n8n/6ixo-crawl4ai-to-csv-github.json', 'http'],
  ['automations/n8n/6ixo-scrape-to-csv-github-no-code-edit.json', 'http'],
  ['automations/n8n/6ixo-scrape-to-csv-github.json', 'fetch'],
  ['automations/n8n/6ixo-scrape-to-csv-github-inline-config.json', 'fetch'],
  ['automations/n8n/6ixo-check-listing-availability.json', 'legacy-http'],
  ['automations/n8n/6ixo-backfill-jamaica-phones-crawl4ai.json', 'direct-http'],
];

const httpReader = `const getGithubCsv = async () => {
  const url = \`https://api.github.com/repos/\${OWNER}/\${REPO}/contents/\${encodeURIComponent(CSV_PATH).replace(/%2F/g, '/')}?ref=\${BRANCH}\`;
  const res = await httpRequest({ url, headers: ghHeaders, json: true });
  if (res.status === 404) return { sha: null, text: csvHeaders.join(',') + '\\n' };
  if (!res.ok) throw new Error(\`Could not read \${CSV_PATH}: \${res.status} \${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}\`);
  const metadata = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  if (!metadata?.sha) throw new Error('GitHub did not return a CSV blob SHA.');
  let encoded = String(metadata.content || '').replace(/\\n/g, '');
  if (!encoded || String(metadata.encoding || '').toLowerCase() !== 'base64') {
    const blob = await httpRequest({
      url: \`https://api.github.com/repos/\${OWNER}/\${REPO}/git/blobs/\${metadata.sha}\`,
      headers: ghHeaders,
      json: true
    });
    if (!blob.ok) throw new Error(\`Could not read \${CSV_PATH} blob: \${blob.status}.\`);
    const blobBody = typeof blob.body === 'string' ? JSON.parse(blob.body) : blob.body;
    encoded = String(blobBody?.content || '').replace(/\\n/g, '');
  }
  if (!encoded) throw new Error('GitHub returned an empty CSV blob; refusing to overwrite existing listings.');
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  if (!text.trim()) throw new Error('GitHub returned an empty CSV; refusing to overwrite existing listings.');
  return { sha: metadata.sha, text };
};`;

const fetchReader = `const getGithubCsv = async () => {
  const url = \`https://api.github.com/repos/\${OWNER}/\${REPO}/contents/\${encodeURIComponent(CSV_PATH).replace(/%2F/g, '/')}?ref=\${BRANCH}\`;
  const res = await fetch(url, { headers: ghHeaders });
  if (res.status === 404) return { sha: null, text: csvHeaders.join(',') + '\\n' };
  if (!res.ok) throw new Error(\`Could not read \${CSV_PATH}: \${res.status} \${await res.text()}\`);
  const metadata = await res.json();
  if (!metadata?.sha) throw new Error('GitHub did not return a CSV blob SHA.');
  let encoded = String(metadata.content || '').replace(/\\n/g, '');
  if (!encoded || String(metadata.encoding || '').toLowerCase() !== 'base64') {
    const blobRes = await fetch(
      \`https://api.github.com/repos/\${OWNER}/\${REPO}/git/blobs/\${metadata.sha}\`,
      { headers: ghHeaders }
    );
    if (!blobRes.ok) throw new Error(\`Could not read \${CSV_PATH} blob: \${blobRes.status} \${await blobRes.text()}\`);
    const blob = await blobRes.json();
    encoded = String(blob?.content || '').replace(/\\n/g, '');
  }
  if (!encoded) throw new Error('GitHub returned an empty CSV blob; refusing to overwrite existing listings.');
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  if (!text.trim()) throw new Error('GitHub returned an empty CSV; refusing to overwrite existing listings.');
  return { sha: metadata.sha, text };
};`;

const legacyHttpReader = `async function getGithubCsv() {
  var url = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(CSV_PATH).split('%2F').join('/') + '?ref=' + BRANCH;
  var res = await httpRequest.call(this, { url: url, headers: ghHeaders, json: true });
  if (res.status === 404) throw new Error(CSV_PATH + ' was not found in ' + OWNER + '/' + REPO + '@' + BRANCH + '.');
  if (!res.ok) throw new Error('Could not read ' + CSV_PATH + ': ' + res.status + ' ' + (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)));
  var metadata = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  if (!metadata || !metadata.sha) throw new Error('GitHub did not return a CSV blob SHA.');
  var encoded = String(metadata.content || '').split('\\n').join('');
  if (!encoded || String(metadata.encoding || '').toLowerCase() !== 'base64') {
    var blob = await httpRequest.call(this, {
      url: 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/git/blobs/' + metadata.sha,
      headers: ghHeaders,
      json: true
    });
    if (!blob.ok) throw new Error('Could not read ' + CSV_PATH + ' blob: ' + blob.status + '.');
    var blobBody = typeof blob.body === 'string' ? JSON.parse(blob.body) : blob.body;
    encoded = String((blobBody && blobBody.content) || '').split('\\n').join('');
  }
  if (!encoded) throw new Error('GitHub returned an empty CSV blob; refusing to overwrite existing listings.');
  var text = Buffer.from(encoded, 'base64').toString('utf8');
  if (!text.trim()) throw new Error('GitHub returned an empty CSV; refusing to overwrite existing listings.');
  return { sha: metadata.sha, text: text };
}`;

const directHttpReader = `const getGithubCsv = async () => {
  const url = \`https://api.github.com/repos/\${OWNER}/\${REPO}/contents/\${encodeURIComponent(CSV_PATH).replace(/%2F/g, '/')}?ref=\${BRANCH}\`;
  const res = await this.helpers.httpRequest({
    url,
    headers: ghHeaders,
    json: true,
    resolveWithFullResponse: true,
    simple: false
  });
  const status = Number(res?.statusCode || res?.status || 200);
  if (status === 404) return { sha: null, text: csvHeaders.join(',') + '\\n' };
  if (status < 200 || status >= 300) throw new Error(\`Could not read \${CSV_PATH}: \${status}.\`);
  const metadata = res?.body ?? res;
  if (!metadata?.sha) throw new Error('GitHub did not return a CSV blob SHA.');
  let encoded = String(metadata.content || '').replace(/\\n/g, '');
  if (!encoded || String(metadata.encoding || '').toLowerCase() !== 'base64') {
    const blobRes = await this.helpers.httpRequest({
      url: \`https://api.github.com/repos/\${OWNER}/\${REPO}/git/blobs/\${metadata.sha}\`,
      headers: ghHeaders,
      json: true,
      resolveWithFullResponse: true,
      simple: false
    });
    const blobStatus = Number(blobRes?.statusCode || blobRes?.status || 200);
    if (blobStatus < 200 || blobStatus >= 300) throw new Error(\`Could not read \${CSV_PATH} blob: \${blobStatus}.\`);
    const blob = blobRes?.body ?? blobRes;
    encoded = String(blob?.content || '').replace(/\\n/g, '');
  }
  if (!encoded) throw new Error('GitHub returned an empty CSV blob; refusing to overwrite existing listings.');
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  if (!text.trim()) throw new Error('GitHub returned an empty CSV; refusing to overwrite existing listings.');
  return { sha: metadata.sha, text };
};`;

const readers = {
  http: [
    'const getGithubCsv = async () => {',
    '\nconst putGithubCsv',
    httpReader,
  ],
  fetch: [
    'const getGithubCsv = async () => {',
    '\nconst putGithubCsv',
    fetchReader,
  ],
  'legacy-http': [
    'async function getGithubCsv() {',
    '\nasync function putGithubCsv',
    legacyHttpReader,
  ],
  'direct-http': [
    'const getGithubCsv = async () => {',
    '\nconst putGithubCsv',
    directHttpReader,
  ],
};

const replaceReader = (code, style, relativePath) => {
  const [startMarker, endMarker, replacement] = readers[style];
  const start = code.indexOf(startMarker);
  const end = code.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Could not find the GitHub CSV reader in ${relativePath}.`);
  return `${code.slice(0, start)}${replacement}${code.slice(end)}`;
};

let changed = 0;
for (const [relativePath, style] of targets) {
  const filePath = path.join(root, relativePath);
  const workflow = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const codeNode = workflow.nodes.find((node) => String(node?.parameters?.jsCode || '').includes('getGithubCsv'));
  if (!codeNode) throw new Error(`No CSV-writing Code node found in ${relativePath}.`);
  const current = codeNode.parameters.jsCode;
  const next = replaceReader(current, style, relativePath);
  if (next === current) continue;
  codeNode.parameters.jsCode = next;
  fs.writeFileSync(filePath, `${JSON.stringify(workflow, null, 2)}\n`);
  changed += 1;
  process.stdout.write(`${relativePath}\n`);
}

process.stdout.write(`Hardened ${changed} n8n GitHub CSV reader(s).\n`);
