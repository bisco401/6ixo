(() => {
    function projectRegions(regions, box) {
        const { width, height, naturalWidth, naturalHeight, fit, position } = box;
        if (!width || !height || !naturalWidth || !naturalHeight) return [];

        let imageWidth = width;
        let imageHeight = height;
        if (fit !== 'fill') {
            const contain = Math.min(width / naturalWidth, height / naturalHeight);
            const scale = fit === 'cover' ? Math.max(width / naturalWidth, height / naturalHeight)
                : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
            imageWidth = naturalWidth * scale;
            imageHeight = naturalHeight * scale;
        }
        const [horizontal = '50%', vertical = '50%'] = position.split(/\s+/);
        const offset = (value, space) => {
            if (value.endsWith('%')) return space * parseFloat(value) / 100;
            if (value.endsWith('px')) return parseFloat(value);
            return NaN;
        };
        const dx = offset(horizontal, width - imageWidth);
        const dy = offset(vertical, height - imageHeight);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [];

        return regions.flatMap(([x, y, w, h]) => {
            const left = Math.max(0, (dx + x * imageWidth) / width);
            const top = Math.max(0, (dy + y * imageHeight) / height);
            const right = Math.min(1, (dx + (x + w) * imageWidth) / width);
            const bottom = Math.min(1, (dy + (y + h) * imageHeight) / height);
            return right > left && bottom > top ? [[left, top, right - left, bottom - top]] : [];
        });
    }

    if (typeof module === 'object' && module.exports) {
        module.exports = { projectRegions };
        return;
    }

    const svg = (tag, attributes) => {
        const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        return element;
    };

    async function start() {
        const manifest = new URL('data/profile-source-brand-regions.json?v=20261106-1', document.baseURI);
        const response = await fetch(manifest);
        if (!response.ok) return;
        const entries = await response.json();
        const regionsByUrl = new Map(Object.entries(entries).map(([url, regions]) => [new URL(url, document.baseURI).href, regions]));
        const definitions = svg('defs', {});
        const filterHost = svg('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute;pointer-events:none' });
        filterHost.append(definitions);
        document.body.append(filterHost);
        const active = new Map();
        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(changes => changes.forEach(change => update(change.target))) : null;
        let nextId = 0;

        function clear(image) {
            const state = active.get(image);
            if (!state) return;
            if (image.style.filter === state.applied) image.style.filter = state.original;
            state.filter.remove();
            observer?.unobserve(image);
            active.delete(image);
        }

        function update(image) {
            const regions = regionsByUrl.get(image.currentSrc || image.src);
            if (!image.isConnected || !regions) { clear(image); return; }

            const styles = getComputedStyle(image);
            const width = image.clientWidth;
            const height = image.clientHeight;
            const projected = projectRegions(regions, {
                width, height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
                fit: styles.objectFit, position: styles.objectPosition
            });
            let state = active.get(image);
            if (!state) {
                const id = 'six-photo-source-brand-' + ++nextId;
                const filter = svg('filter', { id, x: 0, y: 0, width: 1, height: 1,
                    filterUnits: 'objectBoundingBox', primitiveUnits: 'objectBoundingBox',
                    'color-interpolation-filters': 'sRGB' });
                const previous = styles.filter === 'none' ? '' : styles.filter + ' ';
                state = { filter, original: image.style.filter, applied: previous + 'url("#' + id + '")' };
                active.set(image, state);
                definitions.append(filter);
                observer?.observe(image);
            }
            const signature = JSON.stringify([width, height, projected]);
            if (state.signature === signature) return;
            state.signature = signature;
            if (!projected.length) { image.style.filter = state.original; return; }

            const blur = Math.max(7, ...projected.map(([, , , h]) => h * height * 0.65));
            const parts = [svg('feGaussianBlur', { in: 'SourceGraphic',
                stdDeviation: (blur / width) + ' ' + (blur / height), result: 'blurred' })];
            const mask = svg('feMerge', { result: 'mark' });
            projected.forEach(([x, y, w, h], index) => {
                const result = 'region-' + index;
                parts.push(svg('feFlood', { x, y, width: w, height: h, 'flood-color': 'white', result }));
                mask.append(svg('feMergeNode', { in: result }));
            });
            parts.push(mask,
                svg('feComposite', { in: 'blurred', in2: 'mark', operator: 'in', result: 'mark-blur' }),
                svg('feComposite', { in: 'SourceGraphic', in2: 'mark', operator: 'out', result: 'unmarked' }));
            const composite = svg('feMerge', {});
            composite.append(svg('feMergeNode', { in: 'unmarked' }), svg('feMergeNode', { in: 'mark-blur' }));
            state.filter.replaceChildren(...parts, composite);
            image.style.filter = state.applied;
            state.applied = image.style.filter;
        }

        function visit(node, action) {
            if (node.nodeType !== 1) return;
            if (node.tagName === 'IMG') action(node);
            else node.querySelectorAll('img').forEach(action);
        }
        document.querySelectorAll('img').forEach(update);
        document.addEventListener('load', event => {
            if (event.target.tagName === 'IMG') update(event.target);
        }, true);
        new MutationObserver(changes => {
            for (const change of changes) {
                if (change.type === 'attributes') {
                    if (change.target.tagName === 'IMG') update(change.target);
                    continue;
                }
                change.addedNodes.forEach(node => visit(node, update));
                change.removedNodes.forEach(node => visit(node, image => { if (!image.isConnected) clear(image); }));
            }
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });
        let resizeFrame = 0;
        window.addEventListener('resize', () => {
            if (resizeFrame) return;
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = 0;
                active.forEach((_, image) => update(image));
            });
        });
    }

    function initialize() { start().catch(error => console.warn('Profile source photo blur unavailable:', error)); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
})();
