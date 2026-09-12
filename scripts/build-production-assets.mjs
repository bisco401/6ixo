import fs from 'node:fs/promises';
import path from 'node:path';
import CleanCSS from 'clean-css';
import { minify } from 'terser';

const ROOT = path.resolve(import.meta.dirname, '..');
const [appSource, cssSource] = await Promise.all([
  fs.readFile(path.join(ROOT, 'app.js'), 'utf8'),
  fs.readFile(path.join(ROOT, 'styles.css'), 'utf8')
]);

const [appResult, cssResult] = await Promise.all([
  minify(appSource, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false }
  }),
  Promise.resolve(new CleanCSS({ level: 2 }).minify(cssSource))
]);

if (!appResult.code) throw new Error('Terser did not produce app output.');
if (cssResult.errors?.length) throw new Error(`CSS minification failed: ${cssResult.errors.join('; ')}`);

await Promise.all([
  fs.writeFile(path.join(ROOT, 'app.min.js'), `${appResult.code}\n`),
  fs.writeFile(path.join(ROOT, 'styles.min.css'), `${cssResult.styles}\n`)
]);

console.log(`Built app.min.js (${Buffer.byteLength(appResult.code)} bytes) and styles.min.css (${Buffer.byteLength(cssResult.styles)} bytes).`);
