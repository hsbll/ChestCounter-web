// Draws the summary as a picture (PNG) that can be saved and shared, in the page's pixel / CRT look. Drawn by
// hand on a canvas: no screenshot library, nothing leaves the browser. Call loadFonts() first.
const W = 1080;
const PIXEL = '"Press Start 2P", monospace';
const LABEL = '"Silkscreen", monospace';
const TEXT = '"VT323", monospace';
const BG = '#050a14', CARD = '#0a1628', LINE = '#2f5f93', INK = '#dff8ff', INK2 = '#86a9c7';
const CYAN = '#27c2ff', CYAN_DIM = '#1477b3', KRILL = '#fcf400';
const RARITY = ['#9aa7b8', '#5bd13b', '#2fa6ff', '#b44dff', '#ff9d2e', '#9aa7b8'];

/** Where each block sits, per format (all 1080 wide). */
export const FORMATS = {
    portrait: { height: 1350, header: 120, number: 470, numberSize: 260, label: 560, since: 616, tilesTop: 668, tileH: 150, gap: 22, chartH: 230, bars: 104, footer: 38 },
    square: { height: 1080, header: 100, number: 350, numberSize: 200, label: 424, since: 470, tilesTop: 504, tileH: 116, gap: 16, chartH: 206, bars: 88, footer: 36 },
    story: { height: 1920, header: 232, number: 770, numberSize: 300, label: 880, since: 944, tilesTop: 1030, tileH: 176, gap: 26, chartH: 324, bars: 172, footer: 86 },
};

/** The three fonts are served by the site; the canvas only uses them once the browser has them. */
export async function loadFonts() {
    try {
        await Promise.all(['16px "Press Start 2P"', '16px "Silkscreen"', '700 16px "Silkscreen"', '16px "VT323"'].map(font => document.fonts.load(font)));
    } catch { /* the picture is drawn with the fallback fonts */ }
}

function fit(ctx, text, maxWidth, size, family, weight = '') {
    do {
        ctx.font = `${weight} ${size}px ${family}`.trim();
        size -= 2;
    } while (ctx.measureText(text).width > maxWidth && size > 10);
}

/** Square panel with a pixel edge and a hard black shadow. */
function panel(ctx, x, y, w, h) {
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 8, y + 8, w, h);
    ctx.fillStyle = LINE;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = CARD;
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    ctx.fillStyle = 'rgba(5, 10, 20, .6)';
    ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
}

/** Text with a 1-pixel red / cyan split, like a CRT slightly out of convergence. */
function crtText(ctx, text, x, y, color, shift = 3) {
    ctx.fillStyle = '#000';
    ctx.fillText(text, x + shift * 3, y + shift * 3);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(180, 77, 255, .7)';
    ctx.fillText(text, x - shift, y);
    ctx.fillStyle = 'rgba(39, 194, 255, .7)';
    ctx.fillText(text, x + shift, y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}

/** Every text is already formatted by the caller: { format, totalText, name, period, since, tiles[6], days[7], generated }. */
export function drawSummary({ format = 'portrait', totalText, name, period, since, tiles, days, generated }) {
    const L = FORMATS[format] ?? FORMATS.portrait;
    const H = L.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Water, a faint pixel grid, and a glow behind the number.
    const water = ctx.createLinearGradient(0, 0, 0, H);
    water.addColorStop(0, '#0c1f4d');
    water.addColorStop(0.55, BG);
    water.addColorStop(1, '#160a33');
    ctx.fillStyle = water;
    ctx.fillRect(0, 0, W, H);
    const storm = ctx.createRadialGradient(W / 2, H * 1.1, 40, W / 2, H * 1.1, H * 0.6);
    storm.addColorStop(0, 'rgba(138, 61, 255, .5)');
    storm.addColorStop(1, 'rgba(138, 61, 255, 0)');
    ctx.fillStyle = storm;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(39, 194, 255, .08)';
    for (let y = 4; y < H; y += 12) for (let x = 4; x < W; x += 12) ctx.fillRect(x, y, 2, 2);
    const glow = ctx.createRadialGradient(W / 2, L.number - 60, 20, W / 2, L.number - 60, 520);
    glow.addColorStop(0, 'rgba(39, 120, 255, .35)');
    glow.addColorStop(1, 'rgba(39, 120, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Title bar
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `32px ${PIXEL}`;
    crtText(ctx, 'CHEST', 70, L.header, INK, 1);
    const brand = ctx.measureText('CHEST ').width;
    crtText(ctx, 'LOOKOUT', 70 + brand, L.header, KRILL, 1);
    if (name) {
        ctx.textAlign = 'right';
        fit(ctx, name, 380, 44, TEXT);
        ctx.fillStyle = CYAN;
        ctx.fillText(name, W - 70, L.header);
    }
    ctx.fillStyle = LINE;
    for (let x = 70; x < W - 70; x += 12) ctx.fillRect(x, L.header + 22, 6, 4);

    // Headline number
    ctx.textAlign = 'center';
    // Big digits in Silkscreen: Press Start 2P's slanted 8 reads like an S at this size.
    fit(ctx, totalText, W - 160, L.numberSize, LABEL, '700');
    crtText(ctx, totalText, W / 2, L.number, KRILL, 3);
    const label = period ? `BAÚS · ${period.toUpperCase()}` : 'BAÚS ABERTOS';
    // Slanted yellow tag behind the label.
    fit(ctx, label, W - 200, 40, LABEL, '700');
    const tagW = ctx.measureText(label).width + 60, tagH = 64, tagY = L.label - 48;
    ctx.save();
    ctx.translate(W / 2, tagY + tagH / 2);
    ctx.transform(1, 0, -0.18, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(-tagW / 2 + 8, -tagH / 2 + 8, tagW, tagH);
    ctx.fillStyle = KRILL;
    ctx.fillRect(-tagW / 2, -tagH / 2, tagW, tagH);
    ctx.restore();
    ctx.fillStyle = '#1a1600';
    ctx.fillText(label, W / 2, L.label);
    if (since) {
        ctx.fillStyle = INK2;
        ctx.font = `38px ${TEXT}`;
        ctx.fillText(since, W / 2, L.since);
    }

    // Tiles: 3 per row
    const cols = 3, left = 70, tileW = (W - 2 * left - (cols - 1) * L.gap) / cols;
    tiles.forEach((tile, i) => {
        const x = left + (i % cols) * (tileW + L.gap), y = L.tilesTop + Math.floor(i / cols) * (L.tileH + L.gap);
        panel(ctx, x, y, tileW, L.tileH);
        ctx.fillStyle = RARITY[i % RARITY.length];
        ctx.fillRect(x, y, tileW, 8);
        ctx.textAlign = 'center';
        ctx.fillStyle = INK2;
        fit(ctx, tile.label.toUpperCase(), tileW - 40, 22, LABEL, '700');
        ctx.fillText(tile.label.toUpperCase(), x + tileW / 2, y + L.tileH * 0.34);
        fit(ctx, tile.value, tileW - 50, Math.round(L.tileH * 0.42), LABEL, '700');
        crtText(ctx, tile.value, x + tileW / 2, y + L.tileH * 0.78, INK, 1);
    });

    // Last 7 days
    const chartTop = L.tilesTop + 2 * (L.tileH + L.gap) + 14;
    panel(ctx, left, chartTop, W - 2 * left, L.chartH);
    ctx.textAlign = 'left';
    ctx.fillStyle = CYAN;
    ctx.font = `700 22px ${LABEL}`;
    ctx.fillText('ÚLTIMOS 7 DIAS', left + 34, chartTop + 46);
    const max = Math.max(1, ...days.map(d => d.chests));
    const slot = (W - 2 * left - 80) / days.length, base = chartTop + L.chartH - 54;
    ctx.fillStyle = LINE;
    ctx.fillRect(left + 34, base, W - 2 * left - 68, 4);
    days.forEach((day, i) => {
        const cx = Math.round(left + 40 + slot * i + slot / 2), barW = Math.min(56, Math.round(slot * 0.5));
        const h = Math.round((day.chests / max) * L.bars / 8) * 8; // whole 8-pixel steps
        if (h > 0) {
            ctx.fillStyle = CYAN;
            ctx.fillRect(cx - barW / 2, base - h, barW, h);
            ctx.fillStyle = CYAN_DIM;
            ctx.fillRect(cx + barW / 2 - 10, base - h, 10, h);
            ctx.textAlign = 'center';
            ctx.fillStyle = INK;
            ctx.font = `700 24px ${LABEL}`;
            ctx.fillText(day.valueText, cx, base - h - 12);
        }
        ctx.textAlign = 'center';
        ctx.fillStyle = INK2;
        ctx.font = `700 20px ${LABEL}`;
        ctx.fillText(day.label.toUpperCase(), cx, base + 36);
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = INK2;
    ctx.font = `30px ${TEXT}`;
    ctx.fillText(generated, W / 2, H - L.footer);

    // CRT: scanlines and dark corners over the whole picture.
    ctx.fillStyle = 'rgba(0, 0, 0, .22)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);
    const edge = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
    edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
    edge.addColorStop(1, 'rgba(0, 0, 0, .6)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, W, H);
    return canvas;
}
