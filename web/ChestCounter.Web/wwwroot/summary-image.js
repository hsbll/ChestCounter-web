// Draws the summary as a 1080 x 1350 picture (PNG) that can be saved and shared. Drawn by hand on a canvas:
// no screenshot library, nothing leaves the browser.
const W = 1080, H = 1350;
// Impact has a single weight; where it is missing the fallback is drawn at its heaviest instead.
const HAS_IMPACT = (() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '72px monospace';
    const plain = ctx.measureText('mmmmmmmmmlli').width;
    ctx.font = '72px Impact, monospace';
    return ctx.measureText('mmmmmmmmmlli').width !== plain;
})();
const DISPLAY = HAS_IMPACT ? 'Impact' : '"Roboto Condensed", "Arial Narrow", system-ui, sans-serif';
const HEAVY = HAS_IMPACT ? '' : '900';
const TEXT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const YELLOW = '#ffe14a', WHITE = '#ffffff', SOFT = '#c3ceff', PANEL = 'rgba(8, 16, 70, 0.62)', EDGE = 'rgba(132, 160, 255, 0.55)';

function fit(ctx, text, maxWidth, size, family, weight = '') {
    do {
        ctx.font = `${weight} ${size}px ${family}`.trim();
        size -= 2;
    } while (ctx.measureText(text).width > maxWidth && size > 12);
}

function panel(ctx, x, y, w, h, slant = 16) {
    ctx.beginPath();
    ctx.moveTo(x + slant, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - slant, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fillStyle = PANEL;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = EDGE;
    ctx.stroke();
}

/** s = stats.build(data); labels are already formatted by the caller. */
export function drawSummary(s, { name, tiles, days, since, generated }) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const sky = ctx.createLinearGradient(0, 0, W, H);
    sky.addColorStop(0, '#1c47d8');
    sky.addColorStop(0.55, '#3a2bc4');
    sky.addColorStop(1, '#7a2bd0');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 430, 40, W / 2, 430, 620);
    glow.addColorStop(0, 'rgba(120, 190, 255, 0.55)');
    glow.addColorStop(1, 'rgba(120, 190, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = WHITE;
    for (let x = -H; x < W; x += 90) {
        ctx.beginPath();
        ctx.moveTo(x, H); ctx.lineTo(x + 40, H); ctx.lineTo(x + 40 + H * 0.5, 0); ctx.lineTo(x + H * 0.5, 0);
        ctx.fill();
    }
    ctx.restore();

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = WHITE;
    ctx.font = `${HEAVY} 54px ${DISPLAY}`.trim();
    ctx.fillText('CHESTCOUNTER', 70, 118);
    const brand = ctx.measureText('CHESTCOUNTER ').width;
    ctx.fillStyle = YELLOW;
    ctx.fillText('WEB', 70 + brand, 118);
    if (name) {
        ctx.textAlign = 'right';
        ctx.fillStyle = WHITE;
        fit(ctx, name, 420, 40, TEXT, '700');
        ctx.fillText(name, W - 70, 112);
    }

    // Headline number
    ctx.textAlign = 'center';
    const total = s.totalText;
    fit(ctx, total, W - 160, 330, DISPLAY, HEAVY);
    ctx.fillStyle = 'rgba(6, 12, 60, 0.55)';
    ctx.fillText(total, W / 2 + 8, 470 + 10);
    ctx.fillStyle = YELLOW;
    ctx.fillText(total, W / 2, 470);
    ctx.fillStyle = WHITE;
    ctx.font = `${HEAVY} 64px ${DISPLAY}`.trim();
    ctx.fillText('BAÚS ABERTOS', W / 2, 556);
    if (since) {
        ctx.fillStyle = SOFT;
        ctx.font = `30px ${TEXT}`;
        ctx.fillText(since, W / 2, 606);
    }

    // Tiles: 3 per row
    const cols = 3, gap = 22, left = 70, tileW = (W - 2 * left - (cols - 1) * gap) / cols, tileH = 150, top = 660;
    tiles.forEach((tile, i) => {
        const x = left + (i % cols) * (tileW + gap), y = top + Math.floor(i / cols) * (tileH + gap);
        panel(ctx, x, y, tileW, tileH);
        ctx.textAlign = 'center';
        ctx.fillStyle = SOFT;
        ctx.font = `600 25px ${TEXT}`;
        ctx.fillText(tile.label.toUpperCase(), x + tileW / 2, y + 46);
        ctx.fillStyle = WHITE;
        fit(ctx, tile.value, tileW - 50, 70, DISPLAY, HEAVY);
        ctx.fillText(tile.value, x + tileW / 2, y + 118);
    });

    // Last 7 days
    const chartTop = top + 2 * (tileH + gap) + 12, chartH = 250;
    panel(ctx, left, chartTop, W - 2 * left, chartH, 22);
    ctx.textAlign = 'left';
    ctx.fillStyle = SOFT;
    ctx.font = `600 25px ${TEXT}`;
    ctx.fillText('ÚLTIMOS 7 DIAS', left + 44, chartTop + 46);
    const max = Math.max(1, ...days.map(d => d.chests));
    const slot = (W - 2 * left - 90) / days.length, base = chartTop + chartH - 52, tallest = 118;
    days.forEach((day, i) => {
        const cx = left + 45 + slot * i + slot / 2, barW = Math.min(64, slot * 0.5), h = Math.round((day.chests / max) * tallest);
        ctx.fillStyle = YELLOW;
        if (h > 0) {
            ctx.beginPath();
            ctx.roundRect(cx - barW / 2, base - h, barW, h, [5, 5, 0, 0]);
            ctx.fill();
        }
        ctx.fillStyle = 'rgba(195, 206, 255, 0.5)';
        ctx.fillRect(cx - barW / 2, base, barW, 2);
        ctx.textAlign = 'center';
        if (day.chests) {
            ctx.fillStyle = WHITE;
            ctx.font = `700 24px ${TEXT}`;
            ctx.fillText(day.valueText, cx, base - h - 10);
        }
        ctx.fillStyle = SOFT;
        ctx.font = `24px ${TEXT}`;
        ctx.fillText(day.label, cx, base + 34);
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `24px ${TEXT}`;
    ctx.fillText(generated, W / 2, H - 44);
    return canvas;
}
