const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../scripts/verify-ghana-listings.cjs');
const integrity = require('../scripts/lib/listing-integrity.cjs');
const { canRestore } = require('../scripts/reconcile-ghana-gallery-holds.cjs');
const url = 'https://oxglow.com.gh/listing/toyota-corolla-123';
const row = { title: 'Toyota Corolla', source_url: url, phone: '0240000000', city: 'Accra', image_urls: 'data/stale-photo.jpg', attributes: '{}' };
const page = (canonical = url, contact = '0240000000') => `<link rel="canonical" href="${canonical}"><h1>Toyota Corolla</h1>
<script>const mediaItems = [{type:'image',path:'/uploads/medium/own.jpg',original:'/uploads/original/broken.jpg'}];</script>
<aside class="seller-info"><h3>Source seller</h3><a data-full-number="${contact}">Call</a></aside>
<div class="related"><a data-full-number="0209999999">Other seller</a><img src="/uploads/medium/foreign.jpg"></div>`;

test('Ghana uses the current displayed gallery with the same verification record', () => {
  const next = verify(row, page(), '2026-11-06T06:17:00Z');
  assert.equal(next.image_urls, 'https://oxglow.com.gh/uploads/medium/own.jpg');
  assert.equal(next.phone, '0240000000');
  assert.equal(integrity.publicationIssue(next), '');
  assert.equal(JSON.parse(next.attributes).listingIdentity.checkedAt, '2026-11-06T06:17:00Z');
});
test('Ghana rejects foreign canonical pages and recommendation-only contacts', () => {
  assert.throws(() => verify(row, page('https://oxglow.com.gh/listing/foreign'), 'now'));
  assert.throws(() => verify(row, page(url, ''), 'now'));
});
test('a stale repair cannot replace current Ghana gallery proof; review holds still apply', () => {
  const next = verify(row, page(), '2026-11-06T06:17:00Z');
  const old = { title: row.title, checkedAt: '2026-10-01T00:00:00Z', images: ['data/stale-photo.jpg'],
    listingIdentity: { sourceUrl: url, title: row.title, checkedAt: '2026-10-01T00:00:00Z', images: ['data/stale-photo.jpg'] } };
  const repaired = integrity.applyRepair(next, old);
  assert.equal(repaired.image_urls, next.image_urls);
  assert.equal(integrity.publicationIssue(repaired), '');
  assert.equal(integrity.applyRepair(next, { ...old, holdReason: 'reviewed_image_mismatch' }).status, 'rejected');
});
test('automatic hold recovery requires fresh matching verified photos and preserves exclusions', () => {
  const now = Date.parse('2026-11-06T06:30:00Z');
  const next = verify({ ...row, country: 'Ghana', source_availability: 'active', attributes: '{"parser":"ghana_marketplace_sync"}' }, page(), '2026-11-06T06:17:00Z');
  const old = { sourceUrl: url, title: row.title, images: next.image_urls.split('|'), holdReason: 'foreign_gallery',
    reviewNote: 'Gallery belongs to a different source listing.', method: 'fresh_source_gallery_and_public_contact' };
  assert.ok(canRestore(next, old, now));
  assert.ok(!canRestore(next, { ...old, holdReason: 'reviewed_image_mismatch' }, now));
  assert.ok(!canRestore(next, { ...old, images: ['https://oxglow.com.gh/uploads/medium/other.jpg'] }, now));
  assert.ok(!canRestore(next, { ...old, excludedImages: next.image_urls.split('|') }, now));
  assert.ok(!canRestore(next, old, now + 7 * 3600000));
  assert.ok(!canRestore({ ...next, source_availability: 'gone' }, old, now));
});
