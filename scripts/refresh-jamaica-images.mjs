import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_CSV = 'data/jamaica-listings.csv';
const MAX_IMAGES = 12;
const CONCURRENCY = 4;
const API_ORIGIN = 'https://www.jacars.net';

const parseCsv = (text = '') => {
    const values = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const pushCell = () => {
        row.push(cell);
        cell = '';
    };
    const pushRow = () => {
        pushCell();
        if (row.some((value) => String(value || '').trim())) values.push(row);
        row = [];
    };
    const input = String(text || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];
        if (quoted) {
            if (char === '"' && next === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            pushCell();
        } else if (char === '\n') {
            pushRow();
        } else if (char !== '\r') {
            cell += char;
        }
    }
    if (cell || row.length) pushRow();
    const headers = (values.shift() || []).map((header) => String(header || '').trim());
    const rows = values.map((cells) => headers.reduce((result, header, index) => {
        if (header) result[header] = cells[index] || '';
        return result;
    }, {}));
    return { headers, rows };
};

const csvEscape = (value = '') => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const toCsv = (headers, rows) => [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] || '')).join(',')),
].join('\n') + '\n';

const parseAttributes = (value = '') => {
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

const listingSlug = (sourceUrl = '') => {
    try {
        return new URL(sourceUrl).pathname.match(/^\/adv\/([^/]+)\/?$/)?.[1] || '';
    } catch {
        return '';
    }
};

const validFullImage = (value = '') => /^https:\/\/cdn2\.jacars\.net\/media\/cache\/[a-f0-9/]+\.(?:jpe?g|webp)(?:[?#]|$)/i.test(String(value || ''));

const fetchGallery = async (row) => {
    if (parseAttributes(row.attributes).imageQuality === 'source_detail_high_resolution') {
        return { status: 'already_high_resolution', images: [] };
    }
    const slug = listingSlug(row.source_url);
    if (!slug) return { status: 'invalid_source', images: [] };
    const endpoint = `${API_ORIGIN}/api/v2/spa/adverts/card/${encodeURIComponent(slug)}/`;
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(endpoint, {
                headers: {
                    accept: 'application/json',
                    'user-agent': '6ixo-image-quality-refresh/1.0',
                },
            });
            const data = await response.json().catch(() => ({}));
            if (response.status === 404) {
                return { status: 'gone', images: [] };
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const images = Array.from(new Set(Array.isArray(data?.gallery?.full) ? data.gallery.full : []))
                .filter(validFullImage)
                .slice(0, MAX_IMAGES);
            return { status: images.length ? 'upgraded' : 'no_full_gallery', images };
        } catch (error) {
            lastError = String(error?.message || error || 'request failed');
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
    }
    return { status: 'request_failed', images: [], error: lastError };
};

const mapWithConcurrency = async (items, limit, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    const run = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
};

const args = process.argv.slice(2);
const write = args.includes('--write');
const csvArgument = args.find((arg) => !arg.startsWith('--')) || DEFAULT_CSV;
const csvPath = path.resolve(process.cwd(), csvArgument);
const original = await fs.readFile(csvPath, 'utf8');
const { headers, rows } = parseCsv(original);

if (!headers.includes('image_urls') || !headers.includes('source_url')) {
    throw new Error(`${csvPath} is missing image_urls or source_url.`);
}

const checkedAt = new Date().toISOString();
const results = await mapWithConcurrency(rows, CONCURRENCY, fetchGallery);
const stats = { already_high_resolution: 0, upgraded: 0, gone: 0, no_full_gallery: 0, invalid_source: 0, request_failed: 0 };

rows.forEach((row, index) => {
    const result = results[index];
    stats[result.status] = (stats[result.status] || 0) + 1;
    if (!result.images.length) return;
    row.image_urls = result.images.join('|');
    const attributes = parseAttributes(row.attributes);
    row.attributes = JSON.stringify({
        ...attributes,
        imageQuality: 'source_detail_high_resolution',
        imageRefreshSource: 'jacars_gallery_full_api',
        imageRefreshAttemptedAt: checkedAt,
    });
});

if (write) await fs.writeFile(csvPath, toCsv(headers, rows), 'utf8');

console.log(JSON.stringify({
    csvPath,
    rows: rows.length,
    write,
    ...stats,
}, null, 2));
