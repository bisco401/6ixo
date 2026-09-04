import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function addStringAssignment(workflow, nodeName, afterName, name, value) {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  const assignments = node?.parameters?.assignments?.assignments;
  if (!Array.isArray(assignments)) throw new Error(`${nodeName} assignments were not found.`);
  if (assignments.some((assignment) => assignment.name === name)) return;
  const afterIndex = assignments.findIndex((assignment) => assignment.name === afterName);
  const assignment = { id: name, name, value, type: 'string' };
  assignments.splice(afterIndex < 0 ? assignments.length : afterIndex + 1, 0, assignment);
}

function replaceOnce(text, before, after, label) {
  if (text.includes(after)) return text;
  if (!text.includes(before)) throw new Error(`Could not find ${label}.`);
  return text.replace(before, after);
}

function updateAvailabilityWorkflow() {
  const file = path.join(root, 'automations/n8n/6ixo-check-listing-availability.json');
  const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
  addStringAssignment(workflow, 'Set Config Here', 'hideUnavailableListings', 'deleteUnavailableListings', 'true');
  const node = workflow.nodes.find((candidate) => candidate.name === 'Check URLs + Update CSV');
  if (!node?.parameters?.jsCode) throw new Error('Availability code node was not found.');
  let code = node.parameters.jsCode;
  code = replaceOnce(
    code,
    "var HIDE_UNAVAILABLE = String(input.hideUnavailableListings || 'false').toLowerCase() === 'true';\nvar SOURCE_BASE_URLS = {};",
    "var HIDE_UNAVAILABLE = String(input.hideUnavailableListings || 'false').toLowerCase() === 'true';\nvar DELETE_UNAVAILABLE = String(input.deleteUnavailableListings || 'true').toLowerCase() === 'true';\nvar CONFIRMED_UNAVAILABLE = ['sold', 'unavailable', 'gone'];\nvar SOURCE_BASE_URLS = {};",
    'availability deletion settings',
  );
  code = replaceOnce(
    code,
    "    message: 'Check scraped listing availability',",
    "    message: 'Remove sold or unavailable scraped listings',",
    'availability commit message',
  );
  code = replaceOnce(
    code,
    "  if (HIDE_UNAVAILABLE && ['sold', 'unavailable', 'gone'].indexOf(result.availability) >= 0) row.status = 'rejected';",
    "  if (!DELETE_UNAVAILABLE && HIDE_UNAVAILABLE && CONFIRMED_UNAVAILABLE.indexOf(result.availability) >= 0) row.status = 'rejected';",
    'availability hide behavior',
  );
  code = replaceOnce(
    code,
    "await putGithubCsv.call(this, toCsv(parsed.headers, records), existing.sha);\nreturn [{ json: {\n  checked: counts.checked,\n  totalRows: records.length,",
    "var totalRowsBeforeDelete = records.length;\nvar deletedListingIds = [];\nif (DELETE_UNAVAILABLE) {\n  records = records.filter(function(row) {\n    var availability = String(row.source_availability || '').trim().toLowerCase();\n    if (CONFIRMED_UNAVAILABLE.indexOf(availability) < 0) return true;\n    deletedListingIds.push(String(row.id || row.source_url || ''));\n    return false;\n  });\n}\n\nawait putGithubCsv.call(this, toCsv(parsed.headers, records), existing.sha);\nreturn [{ json: {\n  checked: counts.checked,\n  totalRowsBeforeDelete: totalRowsBeforeDelete,\n  totalRows: records.length,\n  deleted: deletedListingIds.length,\n  deletedListingIds: deletedListingIds,",
    'availability row deletion',
  );
  code = replaceOnce(
    code,
    "  hideUnavailableListings: HIDE_UNAVAILABLE,\n  csvPath: CSV_PATH",
    "  hideUnavailableListings: HIDE_UNAVAILABLE,\n  deleteUnavailableListings: DELETE_UNAVAILABLE,\n  csvPath: CSV_PATH",
    'availability summary',
  );
  node.parameters.jsCode = code;
  fs.writeFileSync(file, `${JSON.stringify(workflow, null, 2)}\n`);
}

function updateKijijiWorkflow() {
  const file = path.join(root, 'automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json');
  const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
  addStringAssignment(workflow, 'Set Config Here', 'hideUnavailableListings', 'deleteUnavailableListings', 'true');
  const node = workflow.nodes.find((candidate) => candidate.name === 'Sync New Updated Sold Rows');
  if (!node?.parameters?.jsCode) throw new Error('Kijiji sync code node was not found.');
  let code = node.parameters.jsCode;
  code = replaceOnce(
    code,
    "const HIDE_UNAVAILABLE = String(input.hideUnavailableListings ?? 'true').toLowerCase() === 'true';\nconst AVAILABILITY_MAX_ROWS",
    "const HIDE_UNAVAILABLE = String(input.hideUnavailableListings ?? 'true').toLowerCase() === 'true';\nconst DELETE_UNAVAILABLE = String(input.deleteUnavailableListings ?? 'true').toLowerCase() === 'true';\nconst CONFIRMED_UNAVAILABLE = ['sold', 'unavailable', 'gone'];\nconst AVAILABILITY_MAX_ROWS",
    'Kijiji deletion settings',
  );
  code = replaceOnce(
    code,
    "  } else if (result.availability === 'sold') {\n    sold += 1;\n  } else if (['unavailable', 'gone'].includes(result.availability)) {\n    unavailable += 1;\n    if (HIDE_UNAVAILABLE) {\n      row.status = 'rejected';\n      hidden += 1;\n    }\n  } else {",
    "  } else if (result.availability === 'sold') {\n    sold += 1;\n    if (!DELETE_UNAVAILABLE && HIDE_UNAVAILABLE) {\n      row.status = 'rejected';\n      hidden += 1;\n    }\n  } else if (['unavailable', 'gone'].includes(result.availability)) {\n    unavailable += 1;\n    if (!DELETE_UNAVAILABLE && HIDE_UNAVAILABLE) {\n      row.status = 'rejected';\n      hidden += 1;\n    }\n  } else {",
    'Kijiji hide fallback',
  );
  code = replaceOnce(
    code,
    "\nconst nextRows = Array.from(rowsByUrl.values()).sort((a, b) => String(b.scraped_at || '').localeCompare(String(a.scraped_at || '')));\nawait putGithubCsv(toCsv(nextRows), existing.sha);",
    "\nlet deleted = 0;\nif (DELETE_UNAVAILABLE) {\n  for (const [key, row] of rowsByUrl.entries()) {\n    const availability = String(row.source_availability || '').trim().toLowerCase();\n    if (!CONFIRMED_UNAVAILABLE.includes(availability)) continue;\n    rowsByUrl.delete(key);\n    deleted += 1;\n  }\n}\n\nconst nextRows = Array.from(rowsByUrl.values()).sort((a, b) => String(b.scraped_at || '').localeCompare(String(a.scraped_at || '')));\nawait putGithubCsv(toCsv(nextRows), existing.sha);",
    'Kijiji row deletion',
  );
  code = replaceOnce(
    code,
    "    unknown,\n    hidden,\n    hideUnavailableListings: HIDE_UNAVAILABLE",
    "    unknown,\n    hidden,\n    deleted,\n    hideUnavailableListings: HIDE_UNAVAILABLE,\n    deleteUnavailableListings: DELETE_UNAVAILABLE",
    'Kijiji summary',
  );
  node.parameters.jsCode = code;
  fs.writeFileSync(file, `${JSON.stringify(workflow, null, 2)}\n`);
}

updateAvailabilityWorkflow();
updateKijijiWorkflow();
console.log('Configured confirmed-unavailable deletion in availability and Kijiji workflows.');
