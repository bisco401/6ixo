import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corePath = path.join(root, 'scripts/listing-sync-policy.cjs');
const workflowCodePath = path.join(root, 'automations/n8n/6ixo-listing-policy-code.js');
const outputPath = path.join(root, 'automations/n8n/6ixo-enforce-listing-policy.json');
const jsCode = `${fs.readFileSync(corePath, 'utf8')}\n\n${fs.readFileSync(workflowCodePath, 'utf8')}`;

const assignment = (id, name, value) => ({ id, name, value, type: 'string' });

const workflow = {
  name: '6ixo - Enforce Multicountry Listing Policy',
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
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } },
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
            assignment('githubToken', 'githubToken', "={{ $env.GITHUB_TOKEN || 'PASTE_GITHUB_TOKEN_HERE' }}"),
            assignment('githubOwner', 'githubOwner', "={{ $env.GITHUB_OWNER || 'bisco401' }}"),
            assignment('githubRepo', 'githubRepo', "={{ $env.GITHUB_REPO || '6ixo' }}"),
            assignment('githubBranch', 'githubBranch', "={{ $env.GITHUB_BRANCH || 'main' }}"),
            assignment('csvPath', 'csvPath', "={{ $env.SIXO_CSV_PATH || 'data/scraped-listings.csv' }}"),
            assignment('maxImages', 'maxImages', '4'),
            assignment('maxListingsPerCountry', 'maxListingsPerCountry', '50'),
            assignment('deleteAfterMisses', 'deleteAfterMisses', '1'),
            assignment('countriesJson', 'countriesJson', '[]'),
            assignment('allowedCategoriesJson', 'allowedCategoriesJson', JSON.stringify([
              'vehicles', 'electronics', 'clothing', 'jobs', 'services', 'real_estate',
              'buy_sell', 'community', 'other', 'home',
            ])),
          ],
        },
        options: {},
      },
      id: 'set-config',
      name: 'Set Policy Limits',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [410, 320],
    },
    {
      parameters: { jsCode },
      id: 'enforce-listing-policy',
      name: 'Enforce Listing Policy',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [760, 320],
    },
  ],
  connections: {
    'Manual Trigger': { main: [[{ node: 'Set Policy Limits', type: 'main', index: 0 }]] },
    'Every 6 Hours': { main: [[{ node: 'Set Policy Limits', type: 'main', index: 0 }]] },
    'Set Policy Limits': { main: [[{ node: 'Enforce Listing Policy', type: 'main', index: 0 }]] },
  },
  pinData: {},
  settings: { executionOrder: 'v1', timezone: 'America/Toronto' },
  staticData: null,
  tags: [{ name: '6ixo' }, { name: 'listings' }, { name: 'multicountry' }],
  triggerCount: 1,
  versionId: '6ixo-enforce-listing-policy-v1',
};

fs.writeFileSync(outputPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(path.relative(root, outputPath));
