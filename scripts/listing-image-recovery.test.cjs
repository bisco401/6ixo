const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSource } = require('../assets/listing-image-recovery.js');
test('dealer originals use bounded, iOS-compatible renditions', () => {
    for (const query of ['', '?format=auto', '?width=6000&format=avif']) {
        const result = new URL(normalizeSource('https://storage.albacars.ae/vehicles/drafts/2332/1.jpg' + query));
        assert.equal(result.pathname, '/vehicles/drafts/2332/1.jpg');
        assert.equal(result.searchParams.get('width'), '1600');
        assert.equal(result.searchParams.get('format'), 'jpeg');
        assert.equal(normalizeSource(result.href), result.href);
    }
});
test('every Nigeria dealer gallery photo has a same-origin copy', () => {
    const root = path.resolve(__dirname, '..');
    const { parseCsv } = require('./listing-sync-policy.cjs');
    const cache = JSON.parse(fs.readFileSync(path.join(root, 'data/listing-image-cache.json')));
    const { rows } = parseCsv(fs.readFileSync(path.join(root, 'data/scraped-listings.csv'), 'utf8'));
    for (const row of rows.filter(row => row.country === 'Nigeria' && row.status === 'published')) {
        for (const source of row.image_urls.split('|').filter(url => url.startsWith('https://www.korrectcars.com/uploads/cars/'))) {
            assert.ok(cache[source], `${row.title} is missing a cached gallery photo: ${source}`);
            assert.ok(fs.statSync(path.join(root, cache[source])).size > 1024);
        }
    }
});
test('unrelated providers, signed query strings and local photos retain their identity', () => {
    const signed = 'https://example.com/image.jpg?token=a%2Bb&width=50';
    assert.equal(normalizeSource(signed), signed);
    assert.equal(normalizeSource('/data/real-photo.jpg', 'https://6ixo.com/listing/item/'), 'https://6ixo.com/data/real-photo.jpg');
    assert.equal(normalizeSource('https://via.placeholder.com/600?text=Listing'), 'https://6ixo.com/assets/listing-photo-unavailable.svg');
});
test('all cached cover mappings point to shipped images', () => {
    const root = path.resolve(__dirname, '..');
    const cache = JSON.parse(fs.readFileSync(path.join(root, 'data/listing-image-cache.json')));
    assert.ok(Object.keys(cache).length >= 46);
    for (const [source, local] of Object.entries(cache)) {
        assert.match(source, /^https:\/\//);
        assert.match(local, /^\/data\/listing-image-cache\/[a-f0-9]+\.(jpg|png)$/);
        const bytes = fs.readFileSync(path.join(root, local));
        assert.ok(bytes.length > 1024);
        assert.ok(bytes[0] === 0xff || bytes[0] === 0x89);
    }
});
