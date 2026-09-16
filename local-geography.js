/* GeoNames data is served by 6ixo. Coordinates never go to a geocoding API. */
(function (root) {
    'use strict';
    const VERSION = '20260916';
    const pending = new Map();
    const validCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
    const validLocation = (lat, lng) => validCoordinate(lat, 90) && validCoordinate(lng, 180);

    async function read(name) {
        if (!/^(countries|CA-toronto|[A-Z]{2})$/.test(name)) throw new Error('Invalid geography file');
        if (!pending.has(name)) {
            const request = (async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 12000);
                try {
                    const response = await fetch(`/data/geography/${name}.json?v=${VERSION}`, { signal: controller.signal, credentials: 'omit' });
                    if (!response.ok) throw new Error('Area data unavailable');
                    const data = await response.json();
                    if (!Array.isArray(data)) throw new Error('Invalid area data');
                    return data;
                } finally { clearTimeout(timer); }
            })();
            pending.set(name, request);
            request.catch(() => { if (pending.get(name) === request) pending.delete(name); });
        }
        return pending.get(name);
    }

    function inRing(lng, lat, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [x, y] = ring[i], [px, py] = ring[j];
            if (((y > lat) !== (py > lat)) && lng < (px - x) * (lat - y) / (py - y) + x) inside = !inside;
        }
        return inside;
    }

    function contains(geometry, lat, lng) {
        if (!geometry || !validLocation(lat, lng)) return false;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        return polygons.some(rings => rings.length && inRing(lng, lat, rings[0]) && !rings.slice(1).some(r => inRing(lng, lat, r)));
    }

    function distance(lat, lng, otherLat, otherLng) {
        const rad = Math.PI / 180;
        const a = Math.sin((otherLat - lat) * rad / 2) ** 2 + Math.cos(lat * rad) * Math.cos(otherLat * rad) * Math.sin((otherLng - lng) * rad / 2) ** 2;
        return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
    }

    async function countries() {
        return (await read('countries')).map(({ code, name, cityCount }) => ({ code, name, cityCount }));
    }

    async function cities(code) {
        return (await read(code)).map(([city, region, lat, lng]) => ({ city, region, lat, lng }));
    }

    async function lookup(lat, lng) {
        if (!validLocation(lat, lng)) return null;
        // Official district polygons take priority over nearest town points.
        // The coarse box only limits downloads; it never determines the label.
        if (lat >= 43.5 && lat <= 43.9 && lng >= -79.7 && lng <= -79.0) {
            const districts = await read('CA-toronto');
            const district = districts.find(area => contains(area.geometry, lat, lng));
            if (district) return {
                city: district.city, region: district.region,
                country: district.country, countryCode: district.countryCode,
                source: 'local_toronto_boundaries', approximate: false,
                distanceToCityKm: null
            };
        }
        const catalog = await read('countries');
        let country = catalog.find(c => contains(c.geometry, lat, lng));
        if (!country) {
            // Recover small coastal simplification gaps only when all nearby
            // land belongs to one country. Ambiguous border areas stay manual.
            const delta = 0.012;
            const lngDelta = delta / Math.max(.1, Math.cos(lat * Math.PI / 180));
            const coastal = catalog.filter(c => [[delta,0],[-delta,0],[0,lngDelta],[0,-lngDelta]]
                .some(([dy,dx]) => contains(c.geometry, lat + dy, lng + dx)));
            if (coastal.length === 1) country = coastal[0];
        }
        // Simplified borders/coastlines are imperfect. Do not guess far offshore.
        if (!country) return null;
        let nearest = null, km = Infinity;
        for (const candidate of await cities(country.code)) {
            const d = distance(lat, lng, candidate.lat, candidate.lng);
            if (d < km) { km = d; nearest = candidate; }
        }
        // Remote areas can still browse the correct country without being given
        // a distant town as their device location. City labels are always approximate.
        const close = nearest && km <= 80;
        return {
            city: close ? nearest.city : '', region: close ? nearest.region : '',
            country: country.name, countryCode: country.code,
            source: 'local_geonames', approximate: true,
            distanceToCityKm: close ? Math.round(km * 10) / 10 : null
        };
    }

    const api = { lookup, countries, cities, contains, distance };
    root.SIXO_GEOGRAPHY = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
