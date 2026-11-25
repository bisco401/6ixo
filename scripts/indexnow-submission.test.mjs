import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '6ixo-indexnow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts/lib'), { recursive: true });
  for (const file of ['submit-indexnow.mjs', 'lib/published-site.mjs']) {
    await fs.copyFile(path.join(import.meta.dirname, file), path.join(root, 'scripts', file));
  }
  await fs.writeFile(path.join(root, 'indexnow.config.json'), JSON.stringify({
    origin: 'https://6ixo.com', endpoint: 'https://api.indexnow.org/indexnow', keyFile: 'test-key.txt'
  }));
  await fs.writeFile(path.join(root, 'test-key.txt'), 'test-key\n');
  const urls = Array.from({ length: 10008 }, (_, i) => `https://6ixo.com/listing/test-${i}/`);
  await fs.writeFile(path.join(root, 'sitemap.xml'), [...urls, urls[0]].map(url => `<loc>${url}</loc>`).join('\n'));
  const mock = path.join(root, 'fetch-mock.mjs');
  await fs.writeFile(mock, `
    import fs from 'node:fs/promises';
    let posts = 0;
    globalThis.fetch = async (url, options) => {
      if (url === 'https://6ixo.com/test-key.txt') return new Response('test-key\\n');
      if (url !== 'https://api.indexnow.org/indexnow' || options?.method !== 'POST') throw new Error('Unexpected network request');
      const body = JSON.parse(options.body);
      await fs.appendFile(process.env.INDEXNOW_TEST_LOG, JSON.stringify(body)+'\\n');
      posts += 1;
      return new Response(posts === 2 && process.env.INDEXNOW_TEST_FAIL ? 'unavailable' : '', {
        status: posts === 2 && process.env.INDEXNOW_TEST_FAIL ? 503 : 202
      });
    };
  `);
  const log = path.join(root, 'requests.jsonl');
  const run = (...args) => spawnSync(process.execPath, ['--import', mock, path.join(root, 'scripts/submit-indexnow.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, SIXO_VERIFY_GITHUB_PAGES_ORIGIN: '', INDEXNOW_TEST_LOG: log }
  });
  return { root, urls, log, run, mock };
}

test('a sitemap above the API limit submits every unique URL once in bounded requests', async t => {
  const f = await fixture(t);
  const dry = f.run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /10008 URL\(s\) in 2 batch/);
  await assert.rejects(fs.access(f.log));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const requests = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(r => r.urlList.length), [10000, 8]);
  assert.deepEqual(requests.flatMap(r => r.urlList), f.urls);
  assert.ok(requests.every(r => r.host === '6ixo.com' && r.keyLocation === 'https://6ixo.com/test-key.txt' && r.key === 'test-key'));
});

test('a failed later batch fails the command and identifies the incomplete submission', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, ['--import', f.mock, path.join(f.root, 'scripts/submit-indexnow.mjs')], {
    encoding: 'utf8', env: { ...process.env, SIXO_VERIFY_GITHUB_PAGES_ORIGIN: '', INDEXNOW_TEST_LOG: f.log, INDEXNOW_TEST_FAIL: '1' }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /batch 2\/2 returned HTTP 503/);
  assert.doesNotMatch(result.stdout, /accepted all/);
});
