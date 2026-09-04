'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function workflow(pathname, codeNodeName) {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, pathname), 'utf8'));
  const configNode = parsed.nodes.find((node) => node.name === 'Set Config Here');
  const assignments = configNode?.parameters?.assignments?.assignments || [];
  const deletionSetting = assignments.find((assignment) => assignment.name === 'deleteUnavailableListings');
  assert.equal(deletionSetting?.value, 'true', `${pathname} must enable deletion by default`);
  const code = parsed.nodes.find((node) => node.name === codeNodeName)?.parameters?.jsCode || '';
  assert.match(code, /CONFIRMED_UNAVAILABLE\s*=\s*\['sold', 'unavailable', 'gone'\]/);
  assert.match(code, /DELETE_UNAVAILABLE/);
  assert.match(code, /deleteUnavailableListings/);
  assert.match(code, /deleted/);
  assert.doesNotMatch(code, /CONFIRMED_UNAVAILABLE\s*=.*unknown/);
  return code;
}

const availabilityCode = workflow(
  'automations/n8n/6ixo-check-listing-availability.json',
  'Check URLs + Update CSV',
);
assert.match(availabilityCode, /records\s*=\s*records\.filter/);
assert.match(availabilityCode, /CONFIRMED_UNAVAILABLE\.indexOf\(availability\)\s*<\s*0/);
assert.match(availabilityCode, /Temporary source error/);
assert.match(availabilityCode, /Blocked or rate limited/);

const kijijiCode = workflow(
  'automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json',
  'Sync New Updated Sold Rows',
);
assert.match(kijijiCode, /rowsByUrl\.delete\(key\)/);
assert.match(kijijiCode, /CONFIRMED_UNAVAILABLE\.includes\(availability\)/);

console.log('n8n confirmed-unavailable deletion tests passed');
