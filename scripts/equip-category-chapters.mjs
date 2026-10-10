import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryRoutes, categoryChapters } from './lib/category-chapters.mjs';
import { writeChanged } from './lib/seo.mjs';

export async function equipCategoryChapters(root = path.resolve(import.meta.dirname, '..')) {
  let count = 0;
  for (const [slug, label] of categoryRoutes) {
    const file = path.join(root, slug, 'index.html');
    let html;
    try { html = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await writeChanged(file, categoryChapters(html, slug, label));
    count++;
  }
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Applied chapter navigation to ${await equipCategoryChapters()} category pages.`);
}
