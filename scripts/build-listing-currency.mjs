import fs from 'node:fs';
import { createListingCurrency } from './lib/listing-currency.cjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/listing-currencies.json', import.meta.url), 'utf8'));
const file = new URL('../app.js', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const embedded = `// BEGIN GENERATED LISTING CURRENCY\n${createListingCurrency.toString()}\nconst ListingCurrency = createListingCurrency(${JSON.stringify(catalog)});\n// END GENERATED LISTING CURRENCY\n`;
const updated = source.includes('// BEGIN GENERATED LISTING CURRENCY')
    ? source.replace(/\/\/ BEGIN GENERATED LISTING CURRENCY[\s\S]*\/\/ END GENERATED LISTING CURRENCY\n/, () => embedded)
    : `${embedded}\n${source}`;
if (updated !== source) fs.writeFileSync(file, updated);
console.log(`Embedded listing currency formatting for ${Object.keys(catalog.countries).length} countries and territories.`);
