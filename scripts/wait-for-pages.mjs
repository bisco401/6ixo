import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { readPublishedFile } from './lib/published-site.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const expected = hash(await fs.readFile('sitemap.xml'));
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await readPublishedFile(`https://6ixo.com/sitemap.xml?seo=${Date.now()}`);
    if (response.ok && hash(response.text) === expected) {
      console.log('The published sitemap matches this release.');
      process.exit(0);
    }
  } catch (error) { if (attempt === 0) console.warn(`Waiting for publication: ${error.message}`); }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
throw new Error('The expected sitemap did not become available within the publication window.');
