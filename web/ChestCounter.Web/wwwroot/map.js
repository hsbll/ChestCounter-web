// A small map on a canvas: square "pixel" markers, heat cells, a route line; zoom (wheel, pinch, buttons), drag to
// pan, tap a marker to pick it. World coordinates are Unreal units (centimetres); world X points up and world Y to
// the right, the way the game's own map is usually drawn (approximate: there is no map picture underneath).

const SURFACE = '#071020', GRID = 'rgba(47, 95, 147, .35)', INK = '#dff8ff';

/**
 * createMap(host, { onPick }) -> { update(scene), reset() }
 * scene = {
 *   markers: [{ x, y, color, shape: 'square' | 'hollow' | 'diamond', label?, data? }],
 *   heat:    { points: [[x, y], …], color: [r, g, b] }   // cells coloured by how many points fall in them
 *   line:    [[x, y], …]                                 // drawn under the markers; null breaks the line
 * }
 */
export function createMap(host, { onPick } = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'mapCanvas';
    canvas.tabIndex = 0;
    const buttons = document.createElement('div');
    buttons.className = 'mapZoom';
    const button = (text, label, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.setAttribute('aria-label', label);
        b.addEventListener('click', action);
        buttons.append(b);
    };
    host.replaceChildren(canvas, buttons);
    const ctx = canvas.getContext('2d');

    let scene = { markers: [], heat: null, line: null };
    let bounds = null;      // { cx, cy, span } of everything in the scene
    let view = null;        // { cx, cy, zoom }: zoom 1 shows the whole scene
    let fitted = '';        // the bounds the current view was made for
    let picked = null;
    let heatInfo = null;    // { max, cell } of the last heat drawn, for the caller's text

    const size = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
    const scale = () => { const { w, h } = size(); return (Math.min(w, h) / bounds.span) * view.zoom; };
    const toScreen = (x, y) => { const { w, h } = size(), k = scale(); return [w / 2 + (y - view.cy) * k, h / 2 - (x - view.cx) * k]; };
    const toWorld = (sx, sy) => { const { w, h } = size(), k = scale(); return [view.cx - (sy - h / 2) / k, view.cy + (sx - w / 2) / k]; };

    function measure() {
        const xs = [], ys = [];
        const add = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); } };
        for (const m of scene.markers) add(m.x, m.y);
        for (const p of scene.heat?.points ?? []) add(p[0], p[1]);
        for (const p of scene.line ?? []) if (p) add(p[0], p[1]);
        if (xs.length === 0) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < xs.length; i++) {
            if (xs[i] < minX) minX = xs[i];
            if (xs[i] > maxX) maxX = xs[i];
            if (ys[i] < minY) minY = ys[i];
            if (ys[i] > maxY) maxY = ys[i];
        }
        return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, span: Math.max(maxX - minX, maxY - minY, 20000) * 1.12 };
    }

    function draw() {
        const { w, h } = size();
        if (w === 0 || h === 0) return;
        const ratio = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
            canvas.width = Math.round(w * ratio);
            canvas.height = Math.round(h * ratio);
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.fillStyle = SURFACE;
        ctx.fillRect(0, 0, w, h);
        heatInfo = null;
        if (!bounds) {
            ctx.fillStyle = '#86a9c7';
            ctx.font = '20px "VT323", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('Sem pontos para mostrar', w / 2, h / 2);
            return;
        }
        const k = scale();

        // Grid: one line every 250 m (or 100 m when zoomed in), fixed to the world so it moves with the map.
        const step = (25000 * k > 28 ? (10000 * k > 40 ? 10000 : 25000) : 50000);
        const [topX, leftY] = toWorld(0, 0), [bottomX, rightY] = toWorld(w, h);
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let y = Math.ceil(leftY / step) * step; y <= rightY; y += step) { const sx = Math.round(toScreen(0, y)[0]) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, h); }
        for (let x = Math.ceil(bottomX / step) * step; x <= topX; x += step) { const sy = Math.round(toScreen(x, 0)[1]) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(w, sy); }
        ctx.stroke();

        if (scene.heat?.points.length) {
            // Cells are fixed in the world (1/40 of the scene), so zooming does not reshuffle them.
            const cell = bounds.span / 40;
            const counts = new Map();
            let max = 0;
            for (const [x, y] of scene.heat.points) {
                const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
                const n = (counts.get(key) ?? 0) + 1;
                counts.set(key, n);
                if (n > max) max = n;
            }
            const [r, g, b] = scene.heat.color;
            const side = Math.max(2, cell * k - 1);
            for (const [key, n] of counts) {
                const [ix, iy] = key.split(',').map(Number);
                const [sx, sy] = toScreen((ix + 1) * cell, iy * cell);
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(0.3 + 0.7 * n / max).toFixed(3)})`;
                ctx.fillRect(sx, sy, side, side);
            }
            heatInfo = { max, cell, cells: counts.size };
        }

        if (scene.line?.length) {
            ctx.strokeStyle = 'rgba(223, 248, 255, .55)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            let pen = false;
            for (const p of scene.line) {
                if (!p) { pen = false; continue; }
                const [sx, sy] = toScreen(p[0], p[1]);
                if (pen) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
                pen = true;
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const half = scene.markers.some(m => m.label) ? 9 : 4;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '700 11px "Silkscreen", monospace';
        for (const m of scene.markers) {
            const [sx, sy] = toScreen(m.x, m.y).map(Math.round);
            if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
            ctx.fillStyle = SURFACE;
            if (m.shape === 'diamond') {
                const d = half + 4;
                ctx.beginPath(); ctx.moveTo(sx, sy - d - 2); ctx.lineTo(sx + d + 2, sy); ctx.lineTo(sx, sy + d + 2); ctx.lineTo(sx - d - 2, sy); ctx.closePath(); ctx.fill();
                ctx.fillStyle = m.color;
                ctx.beginPath(); ctx.moveTo(sx, sy - d); ctx.lineTo(sx + d, sy); ctx.lineTo(sx, sy + d); ctx.lineTo(sx - d, sy); ctx.closePath(); ctx.fill();
            } else {
                ctx.fillRect(sx - half - 2, sy - half - 2, 2 * half + 4, 2 * half + 4); // surface ring: overlapping markers stay apart
                ctx.fillStyle = m.color;
                ctx.fillRect(sx - half, sy - half, 2 * half, 2 * half);
                if (m.shape === 'hollow') {
                    // Second cue besides the colour (storm): an open square.
                    ctx.fillStyle = SURFACE;
                    const inner = Math.max(2, half - 3);
                    ctx.fillRect(sx - inner, sy - inner, 2 * inner, 2 * inner);
                }
            }
            if (m.label) {
                ctx.fillStyle = m.shape === 'hollow' ? INK : SURFACE;
                ctx.fillText(m.label, sx, sy + 1);
            }
        }
        if (picked) {
            const [sx, sy] = toScreen(picked.x, picked.y).map(Math.round);
            ctx.strokeStyle = '#fcf400';
            ctx.lineWidth = 3;
            ctx.strokeRect(sx - half - 6, sy - half - 6, 2 * half + 12, 2 * half + 12);
        }
    }

    function zoomAt(factor, sx, sy) {
        if (!bounds) return;
        const { w, h } = size();
        const [wx, wy] = toWorld(sx ?? w / 2, sy ?? h / 2);
        view.zoom = Math.min(40, Math.max(0.6, view.zoom * factor));
        // Keep the point under the cursor where it was.
        const k = scale();
        view.cx = wx + ((sy ?? h / 2) - h / 2) / k;
        view.cy = wy - ((sx ?? w / 2) - w / 2) / k;
        draw();
    }
    function reset() {
        if (bounds) view = { cx: bounds.cx, cy: bounds.cy, zoom: 1 };
        draw();
    }
    button('+', 'Aproximar', () => zoomAt(1.6));
    button('−', 'Afastar', () => zoomAt(1 / 1.6));
    button('Tudo', 'Mostrar tudo', reset);

    canvas.addEventListener('wheel', event => {
        event.preventDefault();
        const box = canvas.getBoundingClientRect();
        zoomAt(event.deltaY < 0 ? 1.25 : 0.8, event.clientX - box.left, event.clientY - box.top);
    }, { passive: false });

    // One pointer drags, two pinch; a press that barely moved is a tap on a marker.
    const pointers = new Map();
    let moved = 0, pinch = 0;
    canvas.addEventListener('pointerdown', event => {
        canvas.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
        if (pointers.size === 1) moved = 0;
        pinch = 0;
    });
    canvas.addEventListener('pointermove', event => {
        const before = pointers.get(event.pointerId);
        if (!before || !bounds) return;
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
        if (pointers.size === 1) {
            const dx = event.clientX - before[0], dy = event.clientY - before[1];
            moved += Math.abs(dx) + Math.abs(dy);
            const k = scale();
            view.cy -= dx / k;
            view.cx += dy / k;
            draw();
        } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
            const box = canvas.getBoundingClientRect();
            if (pinch > 0 && distance > 0) zoomAt(distance / pinch, (a[0] + b[0]) / 2 - box.left, (a[1] + b[1]) / 2 - box.top);
            pinch = distance;
            moved = 99;
        }
    });
    const release = event => {
        const had = pointers.delete(event.pointerId);
        pinch = 0;
        if (!had || event.type !== 'pointerup' || moved > 6 || pointers.size > 0 || !bounds) return;
        const box = canvas.getBoundingClientRect();
        const px = event.clientX - box.left, py = event.clientY - box.top;
        let best = null, bestDistance = 18;
        for (const m of scene.markers) {
            const [sx, sy] = toScreen(m.x, m.y);
            const distance = Math.hypot(sx - px, sy - py);
            if (distance < bestDistance) { best = m; bestDistance = distance; }
        }
        picked = best;
        draw();
        onPick?.(best?.data ?? null);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('keydown', event => {
        if (!bounds) return;
        const step = bounds.span / view.zoom / 10;
        if (event.key === '+' || event.key === '=') zoomAt(1.6);
        else if (event.key === '-') zoomAt(1 / 1.6);
        else if (event.key === 'ArrowUp') { view.cx += step; draw(); }
        else if (event.key === 'ArrowDown') { view.cx -= step; draw(); }
        else if (event.key === 'ArrowLeft') { view.cy -= step; draw(); }
        else if (event.key === 'ArrowRight') { view.cy += step; draw(); }
        else return;
        event.preventDefault();
    });

    new ResizeObserver(draw).observe(canvas);

    return {
        /** Draws a new scene. The zoom is kept while the scene covers the same area; it is refitted otherwise. */
        update(next) {
            scene = { markers: next.markers ?? [], heat: next.heat ?? null, line: next.line ?? null };
            bounds = measure();
            const key = bounds ? `${Math.round(bounds.cx / 5000)},${Math.round(bounds.cy / 5000)},${Math.round(bounds.span / 5000)}` : '';
            if (bounds && (key !== fitted || !view)) view = { cx: bounds.cx, cy: bounds.cy, zoom: 1 };
            fitted = key;
            if (picked && !scene.markers.some(m => m.data === picked.data)) { picked = null; onPick?.(null); }
            draw();
            return heatInfo;
        },
        reset,
    };
}
