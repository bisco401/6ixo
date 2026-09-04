'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDirectory = path.join(root, 'automations', 'n8n');
const workflowFiles = fs.readdirSync(workflowDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort();

let checked = 0;
for (const name of workflowFiles) {
  const workflow = JSON.parse(fs.readFileSync(path.join(workflowDirectory, name), 'utf8'));
  for (const node of workflow.nodes || []) {
    const code = String(node?.parameters?.jsCode || '');
    const writesCsv = /method:\s*['"]PUT['"]/.test(code)
      && /(?:putGithubCsv|saveRemoteCsv|putRemoteCsv)/.test(code)
      && /scraped-listings\.csv|CSV_PATH|csvPath/.test(code);
    if (!writesCsv) continue;
    checked += 1;
    assert.match(
      code,
      /(?:\/git\/blobs\/|download_url|raw\.githubusercontent\.com)/,
      `${name} must fall back to a blob/raw download when GitHub omits inline content for files over 1 MB.`,
    );
    assert.match(
      code,
      /empty CSV/i,
      `${name} must refuse to overwrite the listing database after an empty GitHub response.`,
    );
  }
}

assert.ok(checked >= 10, `Expected to audit at least 10 CSV-writing workflow nodes, found ${checked}.`);
console.log(`n8n CSV reader safety tests passed (${checked} writers checked)`);
