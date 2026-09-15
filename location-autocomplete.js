/* GeoNames autocomplete data is served by 6ixo, without a paid search API. */
(function (root) {
    'use strict';
    const VERSION = '20260914-autocomplete-1';
    const cache = new Map();
    const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
    const prefixKey = value => Array.from(value).slice(0, 2).map(c => c.codePointAt(0).toString(16)).join('-');
    const aliases = { US: ['usa', 'u.s.', 'u.s.a.', 'united states of america'], GB: ['uk', 'u.k.', 'britain', 'great britain'] };
    async function read(name) {
        if (!/^(catalog|[0-9a-f]+(?:-[0-9a-f]+)?)$/.test(name)) throw new Error('Invalid search data');
        if (!cache.has(name)) {
            const promise = (async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 12000);
                try {
                    const response = await fetch(`/data/geography/search/${name}.json?v=${VERSION}`, { credentials: 'omit', signal: controller.signal });
                    if (!response.ok) throw new Error('Location suggestions unavailable');
                    return await response.json();
                } finally { clearTimeout(timer); }
            })();
            cache.set(name, promise);
            promise.catch(() => { if (cache.get(name) === promise) cache.delete(name); });
        }
        return cache.get(name);
    }
    async function search(value, { limit = 12 } = {}) {
        const text = normalize(value).slice(0, 160);
        const parts = text.split(',').map(part => part.trim()).filter(Boolean);
        const query = parts[0] || '', qualifiers = parts.slice(1);
        const catalog = await read('catalog');
        const countries = catalog.countries;
        const countryNames = row => [normalize(row.name), row.code.toLowerCase(), ...(aliases[row.code] || [])];
        const countryResults = qualifiers.length ? [] : countries.filter(row => !query || countryNames(row).some(name => name.startsWith(query)))
            .map(row => ({ id: `country-${row.code}`, city: '', country: row.name, countryCode: row.code, region: '', label: row.name, type: 'country', exact: countryNames(row).includes(query) }));
        if (!query) return countryResults;
        const countryMap = new Map(countries.map(row => [row.code, row]));
        const key = prefixKey(query);
        let cityResults = [];
        if (Array.from(query).length >= 2 && catalog.shards.includes(key)) {
            const records = await read(key);
            cityResults = records.filter(([, , region, code, , names]) => names.some(name => name.startsWith(query))
                && qualifiers.every(part => [normalize(region), ...countryNames(countryMap.get(code))].some(name => name.startsWith(part))))
                .map(([id, city, region, code, population, names]) => ({ id: `city-${id}`, city, region, country: countryMap.get(code).name,
                    countryCode: code, population, label: `${city}, ${countryMap.get(code).name}`, type: 'city', exact: names.includes(query) }));
        }
        // Population makes a short prefix useful: Atlanta should precede the
        // much smaller settlement named Atla. Exact city names get a modest boost.
        return [...countryResults, ...cityResults].sort((a, b) => Number(b.type === 'country' && b.exact) - Number(a.type === 'country' && a.exact)
            || Number(b.type === 'country') - Number(a.type === 'country')
            || (b.population || 0) * (b.exact ? 1.15 : 1) - (a.population || 0) * (a.exact ? 1.15 : 1)
            || Number(b.exact) - Number(a.exact)
            || a.label.localeCompare(b.label)).slice(0, Math.min(50, Math.max(1, limit)));
    }
    const api = { search, normalize };
    root.SIXO_LOCATION_AUTOCOMPLETE = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
