import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const integrity = require('./lib/listing-integrity.cjs');
const { parseCsv } = require('./listing-sync-policy.cjs');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/application\/ld\+json/.test(match[1]))
  .map((match, index) => {
    const src = match[1].match(/\bsrc="([^"]+)"/)?.[1];
    assert.ok(!src || !/^https?:/.test(src), 'Startup JavaScript must be local.');
    return { name: src || `inline-${index}`, source: src ? fs.readFileSync(path.join(root, src.split('?')[0]), 'utf8') : match[2] };
  });
const sentenceExpression = app.match(/const sentences = (\(line\.match\([^;]+);/)[1];
const sentences = new Function('line', 'normalizeCandidate', `return ${sentenceExpression};`);
const normalizeCandidate = value => value.trim();

test('every shipped startup script avoids unsupported Safari 16.1 regex lookbehind', () => {
  for (const script of scripts) {
    assert.doesNotMatch(script.source, /\(\?<(?:[=!])/, script.name);
    assert.doesNotThrow(() => new Function(script.source), script.name);
  }
});

const fixtures = [
  '', ' ', 'One sentence.', 'Available now! Delivery included. Call for details.',
  'Price: 12.99. Mileage: 90,000 km.', 'Great condition?! Yes!  Ready now',
  'Engine: 2.0L\tTransmission: Automatic.', 'First.\nSecond?\r\nThird!',
  'Mr. Smith has this ad.', 'Ends with punctuation!   ', 'No ending punctuation'
];
test('compatible sentence extraction preserves listing descriptions and punctuation', () => {
  for (const line of fixtures) {
    assert.deepEqual(sentences(line, normalizeCandidate), line.split(/(?<=[.!?])\s+/).map(normalizeCandidate).filter(Boolean), line);
  }
});

function previousPhone(...values) {
  return [...new Set(values.flatMap(value => String(value || '').split(/\s*(?:[|;,/\n]|\bor\b)\s*|(?<=\d{7})\s+(?=\+?\d{7})/i))
    .map(value => value.trim()).filter(value => {
      if (!/^\+?[\d\s().-]+$/.test(value)) return false;
      const digits = value.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 && !/^(\d)\1+$/.test(digits) && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value);
    }))].join(' | ');
}
test('compatible phone parsing preserves all existing feed contacts', () => {
  for (const value of ['+86 755 1234 5678', '(647) 403-0077', '0759710738 0756500101', '0595972097/0260180627', '0248928734 or 0553346512', '+16474030077 +14165550123 0759710738', 'N/A', '0000000000', '2026-09-13']) {
    assert.equal(integrity.phone(value), previousPhone(value), value);
  }
  let checked = 0;
  for (const file of fs.readdirSync(path.join(root, 'data')).filter(name => name.endsWith('.csv'))) {
    for (const row of parseCsv(fs.readFileSync(path.join(root, 'data', file), 'utf8')).rows) {
      const fields = [row.phone, row.phone_numbers, row.contactPhone];
      assert.equal(integrity.phone(...fields), previousPhone(...fields), `${file}: ${row.id || row.title}`);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

const jsc = process.env.SIXO_JSC_BINARY || '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
test('installed Safari JavaScriptCore parses every startup script and runs listing helpers', { skip: !fs.existsSync(jsc) }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '6ixo-safari-compat-'));
  try {
    const filename = path.join(directory, 'check.js');
    const core = fs.readFileSync(path.join(root, 'scripts/lib/listing-integrity.cjs'), 'utf8').replace(/module\.exports = createListingIntegrity\(\);\s*$/, '');
    const expected = fixtures.map(line => sentences(line, normalizeCandidate));
    fs.writeFileSync(filename, `var scripts = ${JSON.stringify(scripts)};
      scripts.forEach(function(script) { try { new Function(script.source); } catch(error) { throw new Error(script.name + ': ' + error); } });
      ${core}
      var integrity = createListingIntegrity();
      if (integrity.phone('0759710738 0756500101') !== '0759710738 | 0756500101') throw new Error('Phone parsing failed');
      var fixtures = ${JSON.stringify(fixtures)}, expected = ${JSON.stringify(expected)};
      function normalizeCandidate(value) { return value.trim(); }
      fixtures.forEach(function(line, index) { if (JSON.stringify(${sentenceExpression}) !== JSON.stringify(expected[index])) throw new Error('Sentence extraction failed'); });
      print('Safari JavaScriptCore: ' + scripts.length + ' startup scripts and listing helpers passed.');`);
    const result = spawnSync(jsc, [filename], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
    assert.match(result.stdout, /startup scripts and listing helpers passed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
