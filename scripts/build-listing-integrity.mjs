import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/lib/listing-integrity.cjs'), 'utf8').replace(/module\.exports = createListingIntegrity\(\);\s*$/, 'const ListingIntegrity = createListingIntegrity();');
const embedded = `// BEGIN GENERATED LISTING INTEGRITY\n${source.trim()}\n// END GENERATED LISTING INTEGRITY\n`;
const embed = code => code.includes('// BEGIN GENERATED LISTING INTEGRITY') ? code.replace(/\/\/ BEGIN GENERATED LISTING INTEGRITY[\s\S]*?\/\/ END GENERATED LISTING INTEGRITY\n/, embedded) : `${embedded}\n${code}`;
const appPath = path.join(root, 'app.js');
fs.writeFileSync(appPath, embed(fs.readFileSync(appPath, 'utf8')));
for (const file of ['6ixo-kijiji-hamilton-sync-to-csv.json', '6ixo-crawl4ai-kijiji-listings.json']) {
  const filename = path.join(root, 'automations/n8n', file);
  const workflow = JSON.parse(fs.readFileSync(filename, 'utf8'));
  for (const node of workflow.nodes || []) {
    if (typeof node.parameters?.jsCode === 'string') node.parameters.jsCode = embed(node.parameters.jsCode);
  }
  fs.writeFileSync(filename, `${JSON.stringify(workflow, null, 2)}\n`);
}
const upgradePath = path.join(root, 'automations/n8n/6ixo-upgrade-listing-images-code.js');
if (fs.existsSync(upgradePath)) fs.writeFileSync(upgradePath, embed(fs.readFileSync(upgradePath, 'utf8')));
console.log('Updated shared listing integrity code in browser and scraper workflows.');
