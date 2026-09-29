/* Worldwide, consented device-coordinate lookup. Never use an IP fallback. */
(function (root) {
    'use strict';
    const endpoint = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
    let active = null, retryAt = 0;
    const fresh = fix => fix && typeof fix.lat === 'number' && Number.isFinite(fix.lat) && Math.abs(fix.lat) <= 90
        && typeof fix.lng === 'number' && Number.isFinite(fix.lng) && Math.abs(fix.lng) <= 180
        && typeof fix.timestamp === 'number' && Number.isFinite(fix.timestamp)
        && fix.timestamp > 0 && Date.now() - fix.timestamp < 30000 && fix.timestamp <= Date.now() + 5000;
    const name = value => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 150) : '';

    function parse(data, fix) {
        // Both documented and legacy GPS source names are allowed. IP-derived
        // responses, mismatched echoes, and unnamed countries fail closed.
        if (!data || !['coordinates', 'reverseGeocoding'].includes(data.lookupSource)
            || typeof data.latitude !== 'number' || typeof data.longitude !== 'number'
            || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)
            || Math.abs(data.latitude - fix.lat) > 0.00001 || Math.abs(data.longitude - fix.lng) > 0.00001
            || !/^[A-Z]{2}$/.test(data.countryCode || '') || !name(data.countryName)) return null;
        const city = name(data.city), locality = name(data.locality || data.localityName);
        return {
            city: city || locality, region: name(data.principalSubdivision),
            country: name(data.countryName), countryCode: data.countryCode,
            locality, locationLevel: city ? 'city' : locality ? 'locality' : 'country',
            source: 'bigdatacloud_gps', coordinateMatched: true,
            // Provider locality is not a locally verified polygon. Keep the
            // distinction visible instead of inventing boundary confidence.
            cityVerified: false, approximate: true, resolvedAt: Date.now(),
            needsCityRetry: !(city || locality)
        };
    }

    function cancel() {
        active?.controller.abort();
        active = null;
    }

    async function lookup(fix, { isCurrent } = {}) {
        if (!fresh(fix) || typeof isCurrent !== 'function' || !isCurrent() || Date.now() < retryAt) return null;
        const key = `${fix.lat},${fix.lng}`;
        if (active?.key === key) return active.promise;
        cancel();
        const controller = new AbortController();
        const request = { key, controller, promise: null };
        active = request;
        request.promise = (async () => {
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const url = new URL(endpoint);
                url.searchParams.set('latitude', String(fix.lat));
                url.searchParams.set('longitude', String(fix.lng));
                url.searchParams.set('localityLanguage', 'en');
                const response = await fetch(url.href, {
                    signal: controller.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
                });
                if (!isCurrent() || controller.signal.aborted) return null;
                if (!response.ok) {
                    retryAt = Date.now() + ([402, 429].includes(response.status) ? 300000 : 15000);
                    return null;
                }
                const data = await response.json();
                if (!isCurrent() || controller.signal.aborted || !fresh(fix)) return null;
                const result = parse(data, fix);
                retryAt = result ? (result.needsCityRetry ? Date.now() + 60000 : 0) : Date.now() + 15000;
                return result;
            } catch {
                if (active === request) retryAt = Date.now() + 15000;
                return null;
            } finally {
                clearTimeout(timer);
                if (active === request) active = null;
            }
        })();
        return request.promise;
    }
    root.SIXO_DEVICE_GEOCODER = { lookup, cancel };
})(typeof window === 'object' ? window : globalThis);
