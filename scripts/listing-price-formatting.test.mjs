import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import currencyLib from './lib/listing-currency.cjs';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const catalog = JSON.parse(fs.readFileSync(new URL('../data/listing-currencies.json', import.meta.url), 'utf8'));
const context = { console, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, document: { getElementById: () => null, querySelector: () => null }, localStorage: { getItem: () => null } };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.assign(Object.create(context.App.prototype), { scrapedListingIntegrityRepairs: {}, marketplaceItems: [], vehicleListings: [] });

test('all catalog countries and territories use explicit codes and the same numeric format', () => {
    assert.ok(Object.keys(catalog.countries).length >= 249);
    for (const [countryCode, entry] of Object.entries(catalog.countries)) {
        for (const country of [countryCode, entry.name, ...entry.aliases]) {
            assert.equal(app.formatListingPriceText('48571.25', { country }), `${entry.currencies[0]} 48,571.25`, country);
        }
    }

});

test('currency symbols, local names and explicit ISO codes have consistent labels', () => {
    for (const [input, options, expected] of [
        ['JA$ 48571', {}, 'JMD 48,571.00'], ['J$48571.25', {}, 'JMD 48,571.25'],
        ['GH¢ 48571', {}, 'GHS 48,571.00'], ['GH₵48571.5', {}, 'GHS 48,571.50'],
        ['cedis 48571', {}, 'GHS 48,571.00'], ['48571 Ghana cedis', {}, 'GHS 48,571.00'],
        ['KSh 48571', {}, 'KES 48,571.00'], ['Kenyan shillings 48571', {}, 'KES 48,571.00'],
        ['CA$ 48571.00', {}, 'CAD 48,571.00'], ['US$48571', {}, 'USD 48,571.00'],
        ['€1250.99', {}, 'EUR 1,250.99'], ['GBP 1250.50', {}, 'GBP 1,250.50'],
        ['G$3600000', {}, 'GYD 3,600,000.00'], ['48571 JMD', {}, 'JMD 48,571.00'],
        ['$48571', {country:'Jamaica'}, 'JMD 48,571.00'], ['$48571', {currency:'CAD'}, 'CAD 48,571.00'],
        ['¥48571', {country:'China'}, 'CNY 48,571.00'], ['¥48571', {country:'Japan'}, 'JPY 48,571.00'],
        [0, {country:'Kenya'}, 'KES 0.00'], ['0001250.09', {country:'Ghana'}, 'GHS 1,250.09'],
        ['9007199254740993.01', {currency:'JMD'}, 'JMD 9,007,199,254,740,993.01']
    ]) {
        assert.equal(app.formatListingPriceText(input, options), expected, String(input));
        assert.equal(app.formatListingPriceText(expected, options), expected, 'formatting is idempotent');
        assert.equal(currencyLib.listingCurrency.format(input, options), expected, 'browser and shared library agree');
    }
});

test('explicit source currency wins over country and conflicting imported metadata without converting amounts', () => {
    for (const country of ['Canada','Jamaica','Ghana','Kenya']) {
        assert.equal(app.formatListingPriceText('US$48571.25', {country}), 'USD 48,571.25');
        assert.equal(app.formatListingPriceText('48571.25', {country,currency:'USD'}), 'USD 48,571.25');
    }
    assert.equal(app.formatListingPriceText('CA$48571.25', {currency:'USD'}), 'CAD 48,571.25');
    assert.equal(app.formatListingPriceText('USD 48571.25', {currency:'GHS',country:'Ghana'}), 'USD 48,571.25');
    assert.equal(app.formatListingPriceText('48571', {country:'Bulgaria'}), 'EUR 48,571.00');
});

test('rates, precision, unknown currencies and nonnumeric price meanings are preserved', () => {
    for (const [input, expected] of [
        ['CAD 1250.50 / month','CAD 1,250.50 / month'], ['KES 1250 per week','KES 1,250.00 per week'],
        ['GHS 1250 + tax','GHS 1,250.00 + tax'], ['AED 190000/year','AED 190,000.00/year'],
        ['From JMD 1500','From JMD 1,500.00'], ['KWD 1250.123','KWD 1,250.123']
    ]) assert.equal(app.formatListingPriceText(input), expected);
    for (const input of ['Free','Contact seller','Price not provided','Negotiable','$500–$800','$48.5k','1.250,50 €','$1,25','$-50','ABC 500','']) {
        assert.equal(app.formatListingPriceText(input,{country:'Ghana'}), input);
    }
    assert.equal(app.formatListingPriceText(null), '');
    assert.equal(app.formatListingPriceText(undefined), '');
    assert.equal(app.formatListingPriceText('48571'), '48,571.00', 'unknown currency is not invented');
});

test('CSV imports, featured cards and detail data agree for every listing country', () => {
    const base = { id:'price-regression', title:'2024 Mercedes-Benz GLC 300', app_category:'vehicles', target_surface:'vehicles', source_url:'https://example.com/vehicle', phone:'4165550123', price_value:'48571.25', image_urls:'https://example.com/vehicle.jpg' };
    for (const [country, raw, expectedCurrency] of [['Canada','CA$ 48571.25','CAD'],['Jamaica','JA$ 48571.25','JMD'],['Ghana','GH₵ 48571.25','GHS'],['Kenya','KSh 48571.25','KES'],['Guyana','G$ 48571.25','GYD'],['United States','US$ 48571.25','USD'],['China','48571.25','CNY'],['United Arab Emirates','AED 48571.25','AED'],['Canada','US$ 48571.25','USD']]) {
        const row={...base,country,price_text:raw};
        const normalized=app.normalizeCsvScrapedListingRow(row);
        assert.equal(normalized.item.price, `${expectedCurrency} 48,571.25`);
        assert.equal(normalized.item.currency, expectedCurrency);
        assert.equal(normalized.item.priceValue,48571.25);
        const featured=app.buildScrapedHomeFeaturedListing(normalized);
        assert.equal(app.buildFeaturedAdDataAttrs(featured,featured.featuredAd).adPrice,`${expectedCurrency} 48,571.25`);
        assert.equal(row.price_text,raw,'source data is unchanged');
        const market=app.normalizeCsvScrapedListingRow({...row,app_category:'electronics',target_surface:'marketplace'}).item;
        assert.equal(market.priceText, `${expectedCurrency} 48,571.25`);
        assert.equal(market.price,48571.25);
        assert.equal(market.currency,expectedCurrency);
    }
    const cents=app.normalizeCsvScrapedListingRow({...base,country:'Canada',price_text:'CA$ 48571.00',price_value:'4857100'}).item;
    assert.equal(cents.priceValue,48571,'legacy cent normalization remains correct');
});

test('legacy importers, structured prices, auction prices and booking totals retain currency and cents', () => {
    const {item}=app.normalizeKijijiGtaRow({id:'price-regression',title:'Mercedes-Benz GLC 300',url:'https://www.kijiji.ca/v-cars-trucks/hamilton/price-regression',phone_numbers:'4165550123',image_urls:'https://example.com/vehicle.jpg',price:'CA$ 48571.25'});
    assert.equal(item.price,'CAD 48,571.25');
    assert.equal(item.priceValue,48571.25);
    assert.equal(item.currency,'CAD');
    assert.equal(app.parseOxglowPriceLabel('GH¢ 48571.25'),'GHS 48,571.25');
    assert.equal(app.parseOxglowPriceLabel('US$ 48571.25'),'USD 48,571.25');
    assert.equal(app.formatListingPrice({price:{amount:1250.75,currency:'KES',frequency:'month'}},'rent'),'KES 1,250.75 / month');
    for (const currency of ['JMD','GHS','KES','CAD','USD']) {
        assert.equal(app.formatHostBookingMoney(1250.75,currency),`${currency} 1,250.75`);
        assert.equal(app.formatHostBookingMoney(0,currency),`${currency} 0.00`);
        assert.equal(app.formatMarketplaceMoney(1250.75,{currency}),`${currency} 1,250.75`);
    }
});
