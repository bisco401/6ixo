'use strict';

const assert = require('node:assert/strict');
const {
  applyListingPolicy,
  parseCsv,
  toCsv,
} = require('../scripts/listing-sync-policy.cjs');

const listing = (index, overrides = {}) => ({
  id: `listing-${index}`,
  status: 'published',
  country: 'Canada',
  app_category: index % 2 ? 'electronics' : 'vehicles',
  image_urls: `https://img/${index}-1.jpg|https://img/${index}-2.jpg|https://img/${index}-3.jpg|https://img/${index}-4.jpg|https://img/${index}-5.jpg`,
  source_url: `https://example.test/listing/${index}`,
  scraped_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  source_availability: 'active',
  ...overrides,
});

{
  const source = Array.from({ length: 55 }, (_, index) => listing(index));
  source.push(listing(100, { country: 'Ghana' }));
  const result = applyListingPolicy(source, { maxImages: 4, maxListingsPerCountry: 50 });
  const canada = result.rows.filter((row) => row.country === 'Canada');
  assert.equal(canada.filter((row) => row.status === 'published').length, 50);
  assert.equal(canada.filter((row) => row.sync_visibility === 'capped').length, 5);
  assert.equal(result.rows.find((row) => row.id === 'listing-54').status, 'published');
  assert.equal(result.rows.find((row) => row.id === 'listing-0').status, 'rejected');
  assert.ok(result.rows.every((row) => row.image_urls.split('|').length <= 4));
  assert.equal(result.rows.find((row) => row.country === 'Ghana').status, 'published');
}

{
  const checkedAt = '2026-08-09T10:00:00Z';
  const first = applyListingPolicy([
    listing(1, {
      source_availability: 'sold',
      source_availability_checked_at: checkedAt,
      source_unavailable_reason: 'Source page says sold.',
    }),
  ], { deleteAfterMisses: 3 });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].status, 'rejected');
  assert.equal(first.rows[0].source_miss_count, '1');

  const repeated = applyListingPolicy(first.rows, { deleteAfterMisses: 3 });
  assert.equal(repeated.rows[0].source_miss_count, '1');

  const second = applyListingPolicy([
    { ...repeated.rows[0], source_availability_checked_at: '2026-08-09T16:00:00Z' },
  ], { deleteAfterMisses: 3 });
  assert.equal(second.rows[0].source_miss_count, '2');

  const third = applyListingPolicy([
    { ...second.rows[0], source_availability_checked_at: '2026-08-09T22:00:00Z' },
  ], { deleteAfterMisses: 3 });
  assert.equal(third.rows.length, 0);
  assert.equal(third.deletedRows.length, 1);
}

{
  const csv = 'id,status,country,app_category,image_urls,source_url,scraped_at\n1,published,Canada,electronics,"a|b",https://example.test/1,2026-01-01T00:00:00Z\n';
  const parsed = parseCsv(csv);
  assert.equal(parsed.rows[0].image_urls, 'a|b');
  assert.deepEqual(parseCsv(toCsv(parsed.headers, parsed.rows)).rows, parsed.rows);
}

{
  const result = applyListingPolicy([
    listing(1, {
      source_availability: 'sold',
      source_availability_checked_at: '2026-08-09T10:00:00Z',
    }),
    listing(2, {
      source_availability: 'unknown',
      source_availability_checked_at: '2026-08-09T10:00:00Z',
    }),
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, 'listing-2');
  assert.equal(result.deletedRows[0].id, 'listing-1');
}

console.log('listing sync policy tests passed');
