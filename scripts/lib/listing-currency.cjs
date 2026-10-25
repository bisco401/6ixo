// Display only: no currency conversion or mutation of listing/checkout amounts.
// Country defaults and currency names are from the checked-in Unicode CLDR snapshot.
function createListingCurrency(catalog) {
    const key = value => String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s._’'()-]+/g, '');
    const countryKey = value => key(String(value ?? '').replace(/&/g, ' and ').replace(/\bst\.?\s+/gi, 'Saint ').replace(/\bthe\b/gi, ''));
    const countries = new Map();
    const aliases = new Map();
    const addAlias = (name, code) => {
        const normalized = key(name);
        if (!normalized) return;
        if (!aliases.has(normalized)) aliases.set(normalized, new Set());
        aliases.get(normalized).add(code);
    };
    for (const [code, entry] of Object.entries(catalog.countries)) {
        for (const name of [code, entry.name, ...entry.aliases]) countries.set(countryKey(name), entry.currencies);
    }
    for (const [name, country] of Object.entries({
        'United States of America': 'US', America: 'US', UK: 'GB', 'UAE': 'AE',
        'Ivory Coast': 'CI', 'Cape Verde': 'CV', 'Swaziland': 'SZ', 'Czech Republic': 'CZ',
        'South Korea': 'KR', 'North Korea': 'KP', 'East Timor': 'TL', 'Vatican City': 'VA',
        'Palestine': 'PS', 'The Bahamas': 'BS', 'The Gambia': 'GM', 'Russia': 'RU',
        'Democratic Republic of the Congo': 'CD', 'DR Congo': 'CD', 'Republic of the Congo': 'CG'
    })) countries.set(countryKey(name), catalog.countries[country].currencies);
    for (const [code, entry] of Object.entries(catalog.currencies)) {
        for (const name of [code, entry.name, ...entry.aliases]) addAlias(name, code);
    }
    for (const [code, names] of Object.entries({
        CAD: ['C$', 'CA$'], USD: ['US$', 'U.S. dollars'], JMD: ['J$', 'JA$', 'JM$'],
        GHS: ['GH¢', 'GH₵', '₵', 'cedi', 'cedis', 'Ghana cedi', 'Ghana cedis'],
        KES: ['KSh', 'KShs', 'Ksh/=', 'Kenya shilling', 'Kenya shillings'],
        UGX: ['USh'], TZS: ['TSh'], GYD: ['G$', 'GY$'], TTD: ['TT$'],
        AUD: ['A$', 'AU$'], NZD: ['NZ$'], SGD: ['S$', 'SG$'], HKD: ['HK$'],
        CNY: ['RMB', 'CN¥'], JPY: ['JP¥'], NGN: ['₦'], ZAR: ['R'], INR: ['₹']
    })) for (const name of names) addAlias(name, code);

    const countryCurrencies = options => countries.get(countryKey(options.countryCode)) || countries.get(countryKey(options.country || options.location?.country)) || [];
    const aliasCodes = token => {
        const code = String(token || '').trim().toUpperCase();
        if (Object.hasOwn(catalog.currencies, code)) return [code];
        return [...(aliases.get(key(token)) || [])];
    };
    const resolve = (token = '', options = {}) => {
        const explicit = aliasCodes(token);
        if (explicit.length === 1) return explicit[0];
        const metadata = aliasCodes(options.currency || options.price?.currency || options.vehicle?.currency || options.realestate?.currency || '');
        if (metadata.length === 1) return metadata[0];
        const local = countryCurrencies(options);
        if (!token) return local[0] || '';
        return local.find(code => explicit.includes(code)) || '';
    };
    const parse = value => {
        const raw = String(value ?? '').trim();
        const match = raw.match(/^(?:(From|Starting at)\s+)?([^\d]*?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,4}))?(.*)$/i);
        if (!match) return null;
        const [, qualifier = '', prefix, whole, fraction = '', rest] = match;
        if (/[-+()]/.test(prefix)) return null;
        const suffixMatch = rest.match(/^(.*?)(\s*(?:\/\s*[a-z][a-z\s-]*|per\s+[a-z][a-z\s-]*|\+\s*tax))?$/i);
        if (!suffixMatch) return null;
        const trailingCurrency = suffixMatch[1].trim();
        const leadingCurrency = prefix.trim();
        if (leadingCurrency && !aliasCodes(leadingCurrency).length) return null;
        if (trailingCurrency && !aliasCodes(trailingCurrency).length) return null;
        if (leadingCurrency && trailingCurrency) {
            const trailingCodes = aliasCodes(trailingCurrency);
            if (!aliasCodes(leadingCurrency).some(code => trailingCodes.includes(code))) return null;
        }
        return { qualifier, token: trailingCurrency || leadingCurrency, whole: whole.replace(/,/g, ''), fraction, suffix: suffixMatch[2] || '' };
    };
    const currency = (value, options = {}) => {
        const parsed = parse(value);
        return resolve(parsed?.token || '', options);
    };
    const format = (value, options = {}) => {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        const parsed = parse(raw);
        if (!parsed) return raw;
        const code = resolve(parsed.token, options);
        const prefix = code ? `${code} ` : parsed.token ? `${parsed.token} ` : '';
        const grouped = parsed.whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        // At least two decimals, preserving real third/fourth decimal units.
        return `${parsed.qualifier ? `${parsed.qualifier} ` : ''}${prefix}${grouped}.${parsed.fraction.padEnd(2, '0')}${parsed.suffix}`;
    };
    return { format, currency, parse, countryCurrencies };
}

module.exports = { createListingCurrency, listingCurrency: createListingCurrency(require('../../data/listing-currencies.json')) };
