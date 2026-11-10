// Apply measured photo decisions through the existing reviewed-listing mechanism.
// Run after upgrade-listing-photo-quality.py; preserve seller/source identity proofs.
const fs = require('node:fs');
const integrity = require('./lib/listing-integrity.cjs');
const {parseCsv, toCsv} = require('./listing-sync-policy.cjs');

function reviewGallery(row, measurements) {
    const photos = String(row.image_urls || '').split('|').filter(Boolean);
    let attributes = {};
    try { attributes = JSON.parse(row.attributes || '{}'); } catch {}
    const removed = [], kept = [], unknown = [];
    photos.forEach((url, index) => {
        const measured = measurements.get(url);
        // These legacy files were enlarged from 224px thumbnails. The saved
        // 640px dimensions do not represent additional photographic detail.
        const source = attributes.originalImageUrls?.[index] || '';
        const thumbnailWidth = /data\/pigiame-clean-images\//.test(url)
            ? Number(source.match(/listing-thumb-(\d+)w\//)?.[1] || 0) : 0;
        const longest = thumbnailWidth || Math.max(measured?.width || 0, measured?.height || 0);
        const unavailable = measured?.attempts >= 2 && /^HTTP Error (400|404|410):/.test(measured.error || '');
        if ((longest && longest < 600) || unavailable || /\/awaiting_car[^/]*\.(?:gif|png|jpe?g)$/i.test(url)) removed.push(url);
        else { kept.push(url); if (!longest) unknown.push(url); }
    });
    // Never suppress a listing just because an audit request timed out.
    return { kept, removed, unknown, hold: photos.length > 0 && kept.length === 0 };
}

function main() {
    const [inventoryFile, auditFile, reportFile] = process.argv.slice(2);
    if (!reportFile) throw new Error('Usage: node scripts/apply-listing-photo-quality.cjs INVENTORY AUDIT.jsonl REPORT.json');
    const rows = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
    const measurements = new Map(fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(line => {
        const result = JSON.parse(line); return [result.url, result];
    }));
    const missing = rows.flatMap(row => row.image_urls.split('|')).filter(url => url && !measurements.has(url));
    if (missing.length) throw new Error(`Audit incomplete: ${new Set(missing).size} photos have not been checked`);
    const filename = 'data/listing-integrity-repairs.json';
    const originalRepairs = fs.readFileSync(filename, 'utf8');
    const repairs = JSON.parse(originalRepairs);
    const checkedAt = new Date().toISOString();
    const changes = [], countries = {};
    for (const row of rows) {
        const review = reviewGallery(row, measurements);
        if (!review.removed.length) continue;
        const key = integrity.key(row.source_url);
        const previous = repairs.listings[key] || {};
        if (previous.holdReason) continue;
        const repair = { ...previous, sourceUrl: row.source_url, title: row.title };
        repair.excludedImages = [...new Set([...(previous.excludedImages || []), ...review.removed])];
        repair.photoQualityReview = { checkedAt, minimumLongEdge: 600, excludedPhotos: review.removed.length,
            reason: 'Source photo has insufficient native detail for listing cards and galleries.' };
        if (review.hold) {
            repair.holdReason = 'low_resolution_photos';
            repair.reviewNote = 'No usable photo at 600px or above; removed from public view after image-quality review.';
        }
        repairs.listings[key] = repair;
        const counts = countries[row.country] ||= { hidden: 0, galleriesCleaned: 0, photosRemoved: 0 };
        counts[review.hold ? 'hidden' : 'galleriesCleaned']++;
        counts.photosRemoved += review.removed.length;
        changes.push({ id: row.id, title: row.title, country: row.country, sourceUrl: row.source_url,
            hidden: review.hold, removed: review.removed, retained: review.kept });
    }
    fs.writeFileSync(filename, JSON.stringify(repairs, null, /^\{\s*\n/.test(originalRepairs) ? 2 : undefined) + '\n');
    const changedSources = new Set(changes.map(change => integrity.key(change.sourceUrl)));
    const feeds = ['scraped-listings', 'kenya-listings', 'jamaica-listings', 'dubai-listings', 'guyana-listings',
        'kijiji-gta-recent-with-phones', 'oxglow-electronics-recent', 'oxglow-real-estate-recent', 'oxglow-auto-parts-accessories-recent'];
    for (const feed of feeds) {
        const file = `data/${feed}.csv`;
        if (!fs.existsSync(file)) continue;
        const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
        let changed = 0;
        for (const row of parsed.rows) {
            if (!changedSources.has(integrity.key(integrity.sourceUrl(row)))) continue;
            const next = integrity.applyRepair(row, integrity.resolveRepair(row, repairs.listings));
            if (JSON.stringify(next) === JSON.stringify(row)) continue;
            Object.assign(row, next);
            for (const field of Object.keys(next)) if (!parsed.headers.includes(field)) parsed.headers.push(field);
            changed++;
        }
        if (changed) fs.writeFileSync(file, toCsv(parsed.headers, parsed.rows));
        console.log(`${file}: ${changed} photo corrections`);
    }
    const summary = { checkedAt, auditedPhotos: measurements.size, countries,
        hidden: changes.filter(row => row.hidden).length, galleriesCleaned: changes.filter(row => !row.hidden).length,
        photosRemoved: changes.reduce((sum, row) => sum + row.removed.length, 0) };
    fs.writeFileSync(reportFile, JSON.stringify({ ...summary, changes }, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
}
module.exports = { reviewGallery };
if (require.main === module) main();
