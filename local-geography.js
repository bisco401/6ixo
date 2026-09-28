/* GeoNames data is served by 6ixo. Coordinates never go to a geocoding API. */
(function (root) {
    'use strict';
    const VERSION = '20260927';
    const pending = new Map();
    const validCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
    const validLocation = (lat, lng) => validCoordinate(lat, 90) && validCoordinate(lng, 180);

    async function read(name) {
        if (!/^(countries|CA-toronto|GH-accra|US-nyc|[A-Z]{2})$/.test(name)) throw new Error('Invalid geography file');
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

    // Minimum distance to every outer/hole edge in local metres. Together with
    // GPS accuracy this prevents a boundary-straddling fix from claiming a city.
    function boundaryClearanceMeters(geometry, lat, lng) {
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        const yScale = Math.PI * 6371000 / 180;
        const xScale = yScale * Math.cos(lat * Math.PI / 180);
        let min = Infinity;
        for (const rings of polygons) for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const ax = (ring[j][0] - lng) * xScale, ay = (ring[j][1] - lat) * yScale;
                const bx = (ring[i][0] - lng) * xScale, by = (ring[i][1] - lat) * yScale;
                const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
                const t = length2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
                min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
            }
        }
        return Math.floor(min);
    }

    async function countries() {
        return (await read('countries')).map(({ code, name, cityCount }) => ({ code, name, cityCount }));
    }

    async function cities(code) {
        return (await read(code)).map(([city, region, lat, lng]) => ({ city, region, lat, lng }));
    }

    async function lookup(lat, lng) {
        if (!validLocation(lat, lng)) return null;
        let districtUnavailable = false;
        // Mapped area polygons take priority over nearest town points.
        // Download boxes never determine labels; only polygon containment does.
        const boundarySets = [
            { file: 'US-nyc', box: [40.49, 40.93, -74.26, -73.69], source: 'local_nyc_boundaries' },
            { file: 'CA-toronto', box: [43.5, 43.9, -79.7, -79.0], source: 'local_toronto_boundaries' },
            { file: 'GH-accra', box: [5.62, 5.65, -0.18, -0.14], source: 'local_osm_boundaries' }
        ];
        for (const { file, box: [south, north, west, east], source } of boundarySets) {
            if (lat < south || lat > north || lng < west || lng > east) continue;
            const districts = await read(file).catch(() => {
                districtUnavailable = true;
                return [];
            });
            const district = districts.find(area => contains(area.geometry, lat, lng));
            if (district) return {
                city: district.city, region: district.region,
                country: district.country, countryCode: district.countryCode,
                source, approximate: false, cityVerified: true,
                boundaryClearanceMeters: boundaryClearanceMeters(district.geometry, lat, lng),
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
        const countryOnly = {
            city: '', region: '', country: country.name, countryCode: country.code,
            source: 'local_country_boundaries', approximate: true, distanceToCityKm: null,
            cityVerified: false, cityUnavailableReason: districtUnavailable ? 'boundary_unavailable' : 'boundary_not_covered',
            needsCityRetry: districtUnavailable
        };
        // Keep a verified country visible if finer area data is unavailable.
        // Do not replace missing district boundaries with a nearest-town guess.
        // A populated-place point cannot prove city membership, even with exact
        // GPS. Never promote a nearest settlement to the visitor's actual city.
        // GeoNames remains available for deliberate manual city searches.
        return countryOnly;
    }

    const api = { lookup, countries, cities, contains, distance, boundaryClearanceMeters };
    root.SIXO_GEOGRAPHY = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
