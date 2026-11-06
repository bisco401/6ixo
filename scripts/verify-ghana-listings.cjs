#!/usr/bin/env node
// Bind Ghana's displayed photos and public contact to the exact canonical ad.
const fs = require('node:fs');
const integrity = require('./lib/listing-integrity.cjs');

function verify(row, html, checkedAt) {
  const verified = integrity.verifyRecord(row, html, checkedAt);
  const result = verified.result;
  if (!result.matched || result.identityIssue || result.method !== 'primary_displayed_source_gallery') {
    throw Error(result.identityIssue || 'Exact displayed source gallery not verified');
  }
  const contact = integrity.phone(...(result.phones || []));
  if (!contact) throw Error('No complete public seller contact on the exact ad');
  const next = { ...verified.row, phone: contact };
  const issue = integrity.publicationIssue(next);
  if (issue) throw Error(issue);
  return next;
}

async function main() {
  const { candidates, checkedAt } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const rows = [], held = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < candidates.length) {
      const { row, html } = candidates[cursor++];
      try {
        const next = verify(row, html, checkedAt);
        const images = [];
        for (const url of next.image_urls.split('|')) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (response.ok && (response.headers.get('content-type') || '').startsWith('image/')) images.push(url);
            await response.body?.cancel();
          } catch { /* Hold photos that cannot currently be loaded. */ }
        }
        if (!images.length) throw Error('No working photo from the exact source gallery');
        const attributes = JSON.parse(next.attributes);
        attributes.listingIdentity.images = images;
        next.attributes = JSON.stringify(attributes);
        next.image_urls = images.join('|');
        rows.push(next);
      } catch (error) { held.push({ url: row.source_url, reason: error.message }); }
    }
  }));
  process.stdout.write(JSON.stringify({ rows, held }));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
