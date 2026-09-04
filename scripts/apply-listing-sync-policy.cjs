#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyListingPolicy, parseCsv, toCsv } = require('./listing-sync-policy.cjs');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  const next = process.argv[index + 1];
  args.set(key.slice(2), next && !next.startsWith('--') ? process.argv[++index] : true);
}

const inputPath = path.resolve(String(args.get('input') || 'data/scraped-listings.csv'));
const outputPath = path.resolve(String(args.get('output') || inputPath));
const parsed = parseCsv(fs.readFileSync(inputPath, 'utf8'));
const result = applyListingPolicy(parsed.rows, {
  maxImages: Number(args.get('max-images') || 4),
  maxListingsPerCountry: Number(args.get('max-per-country') || 50),
  deleteAfterMisses: Number(args.get('delete-after-misses') || 1),
  countries: args.get('countries') || '[]',
  allowedCategories: args.get('categories') || undefined,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, toCsv(parsed.headers, result.rows), 'utf8');
process.stdout.write(`${JSON.stringify({ inputPath, outputPath, ...result.stats }, null, 2)}\n`);
