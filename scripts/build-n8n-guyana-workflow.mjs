import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codePath = path.join(root, 'automations/n8n/6ixo-guyana-sync-code.js');
const outputPath = path.join(root, 'automations/n8n/6ixo-crawl4ai-guyana-listings.json');
const jsCode = fs.readFileSync(codePath, 'utf8');

const workflow = {
  name: '6ixo - Guyana Vehicle Sync (Crawl4AI)',
  nodes: [
    {
      parameters: {},
      id: 'manual-trigger',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [120, 220],
    },
    {
      parameters: {
        rule: { interval: [{ field: 'hours', hoursInterval: 6 }] },
      },
      id: 'schedule-trigger',
      name: 'Every 6 Hours',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [120, 420],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'githubOwner', name: 'githubOwner', value: 'bisco401', type: 'string' },
            { id: 'githubRepo', name: 'githubRepo', value: '6ixo', type: 'string' },
            { id: 'githubBranch', name: 'githubBranch', value: 'main', type: 'string' },
            { id: 'csvPath', name: 'csvPath', value: 'data/guyana-listings.csv', type: 'string' },
            { id: 'crawl4aiUrl', name: 'crawl4aiUrl', value: 'http://10.0.0.164:11235/crawl', type: 'string' },
            { id: 'sitemapUrl', name: 'sitemapUrl', value: 'https://carsforsale.gy/sitemap-listings.xml', type: 'string' },
            { id: 'maxCandidates', name: 'maxCandidates', value: '40', type: 'string' },
            { id: 'maxListings', name: 'maxListings', value: '20', type: 'string' },
            { id: 'detailBatchSize', name: 'detailBatchSize', value: '5', type: 'string' },
            { id: 'defaultImportStatus', name: 'defaultImportStatus', value: 'published', type: 'string' },
          ],
        },
        options: {},
      },
      id: 'set-config',
      name: 'Set Config Here',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [420, 320],
    },
    {
      parameters: { jsCode },
      id: 'sync-guyana-listings',
      name: 'Sync Guyana Listings',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [760, 320],
    },
  ],
  connections: {
    'Manual Trigger': { main: [[{ node: 'Set Config Here', type: 'main', index: 0 }]] },
    'Every 6 Hours': { main: [[{ node: 'Set Config Here', type: 'main', index: 0 }]] },
    'Set Config Here': { main: [[{ node: 'Sync Guyana Listings', type: 'main', index: 0 }]] },
  },
  pinData: {},
  settings: { executionOrder: 'v1' },
  staticData: null,
  tags: [{ name: '6ixo' }, { name: 'guyana' }, { name: 'vehicles' }],
  triggerCount: 1,
  updatedAt: new Date().toISOString(),
  versionId: '6ixo-crawl4ai-guyana-listings-v1',
};

fs.writeFileSync(outputPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(path.relative(root, outputPath));
