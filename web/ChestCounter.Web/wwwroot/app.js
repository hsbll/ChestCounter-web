import { createEngine, isFatal } from './engine.js';
import * as store from './store.js';
import * as stats from './stats.js';
import { listReplays } from './zip.js';
import { drawSummary, loadFonts } from './summary-image.js';
import { createMap, HEAT_CSS } from './map.js';
import * as treasure from './treasure.js';

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('pt-BR');
const fmt1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateShort = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateFull = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const dayLong = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

const KIND_NAMES = {
    'Chest': 'Baú', 'Rare chest': 'Baú raro', 'Buried chest': 'Baú enterrado',
    'Extraction / relic chest': 'Baú de extração / relíquia', 'Spirit poster chest': 'Baú do pôster',
    'Other chest': 'Outro baú', 'Loot cannon': 'Canhão de loot', 'Ammo box': 'Caixa de munição',
    'Food box': 'Caixa de comida', 'Other container': 'Outro contêiner', 'unknown': 'Desconhecido',
};
const TREASURE_NAMES = {
    'Golden firework': 'Fogo de artifício dourado', 'Portable extractor': 'Extrator portátil',
    'Spirit locator': 'Localizador de espíritos', 'Lucky locator': 'Localizador da sorte',
    'Extraction accelerator': 'Acelerador de extração', 'Treasure gizmo': 'Item de tesouro',
};
const SIZE_NAMES = { solo: 'Solo', duo: 'Duplas', trio: 'Trios', squad: 'Esquadrões' };
const PERIOD_NAMES = { today: 'hoje', 7: 'últimos 7 dias', 30: 'últimos 30 dias', month: 'este mês', year: 'este ano' };
const kindName = kind => KIND_NAMES[kind] ?? kind;
const treasureName = find => TREASURE_NAMES[find.displayName] ?? find.displayName ?? find.item ?? 'Tesouro';
const pct = (part, whole) => (whole > 0 ? fmt1.format(100 * part / whole) + '%' : '—');
const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;

// Long lists start short: [rows shown at first, rows added by "Mostrar mais"].
const LIST = { matches: [10, 25], treasures: [5, 20], mates: [5, 20], rankChests: [10, 15], rankTreasures: [10, 15] };
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || 'dev';

let data = store.emptyData();
let engine = null;
let busy = false;
let stopRequested = false;
const readTimes = []; // seconds per replay, for the diagnostic
let persistent = true;   // false: the browser keeps nothing (private window…)
let protectedStorage = null;
const shownRows = {};
const resetLists = () => { for (const name of Object.keys(LIST)) shownRows[name] = LIST[name][0]; };
resetLists();
let chartDays = 7;
let tab = 'resumo';
let openKey = null;      // match shown in the dialog
const filter = { period: 'all', size: '', range: null };
let rangeError = null; // message for hours that cannot be right
const problems = [];     // latest errors, for "Copiar diagnóstico"
const startup = { began: Date.now(), ms: null, fallback: false };

// ---- small DOM helpers (everything read from a replay is inserted as text, never as HTML) ----------------
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    node.append(...children.filter(child => child != null));
    return node;
}

/** rows: arrays of cells (text, or { t, c }); onRow(index) makes the rows clickable (mouse and keyboard). */
function table(target, head, rows, emptyText, onRow) {
    target.replaceChildren();
    if (rows.length === 0) {
        target.append(el('tbody', {}, el('tr', {}, el('td', { class: 'none', text: emptyText }))));
        return;
    }
    target.append(el('thead', {}, el('tr', {}, ...head.map(h => el('th', { class: h.n ? 'n' : '', text: h.t })))));
    target.append(el('tbody', {}, ...rows.map((cells, index) => {
        const row = el('tr', onRow ? { tabindex: '0', role: 'button' } : {}, ...cells.map((cell, i) => {
            const c = cell && typeof cell === 'object' ? cell : { t: cell };
            return el('td', { class: [head[i]?.n ? 'n' : '', c.c ?? ''].join(' ').trim(), text: c.t ?? '' });
        }));
        if (onRow) {
            row.addEventListener('click', () => onRow(index));
            row.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRow(index); }
            });
        }
        return row;
    })));
}

/** How many rows of a long list to show, and its "Mostrar mais / menos" buttons brought up to date. */
function pager(name, total) {
    const n = Math.min(shownRows[name], total);
    $(`more-${name}`).hidden = total <= n;
    $(`more-${name}`).textContent = `Mostrar mais (${fmt.format(total - n)})`;
    $(`less-${name}`).hidden = n <= LIST[name][0];
    return n;
}

function modeName(playlist) {
    if (!playlist) return '—';
    const p = playlist.toLowerCase();
    const parts = [];
    const size = SIZE_NAMES[stats.teamSize(playlist)];
    if (size) parts.push(size);
    if (p.includes('showdown') || p.includes('ranked')) parts.push('Ranqueado');
    if (p.includes('nobuild')) parts.push('Zero Construção');
    if (p.includes('reload') || p.includes('punchberry') || p.includes('blastberry')) parts.push('Recarga');
    return parts.length ? parts.join(' · ') : playlist.replace(/^Playlist_/i, '').replaceAll('_', ' ');
}
const clock = seconds => seconds == null ? '' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const placeCell = m => m.placement == null
    ? { t: '—' }
    : { t: (m.placement === 1 ? '🏆 ' : '') + m.placement + 'º', c: m.placement === 1 ? 'win' : m.placement <= 10 ? 'top10' : '' };

function download(blob, name) {
    const link = el('a', { href: URL.createObjectURL(blob), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

// ---- rendering ------------------------------------------------------------------------------------------
/** A history the page cannot draw must not leave a blank page: the error is shown and export still works. */
function render() {
    try {
        draw();
        $('renderError').hidden = true;
    } catch (error) {
        console.error(error);
        problems.push(`render: ${error.message}`);
        $('renderError').textContent = `Não foi possível mostrar o histórico (${error.message}). Seus dados continuam salvos: use "Exportar histórico" e "Copiar diagnóstico" nos Ajustes.`;
        $('renderError').hidden = false;
    }
}

function draw() {
    const s = stats.build(data, filter);
    const settings = data.settings;
    const all = stats.profiles(data);

    $('profileBox').hidden = all.length < 2;
    $('profile').replaceChildren(...all.map(p => {
        const option = el('option', { value: p.key, text: `${p.name} (${fmt.format(p.matches.length)})` });
        option.selected = p.key === s.profile?.key;
        return option;
    }));

    for (const box of document.querySelectorAll('[data-setting]')) box.checked = !!settings[box.dataset.setting];
    const initial = Math.max(0, settings.initialChests?.[s.profile?.key ?? ''] ?? 0);
    if (document.activeElement !== $('initial')) $('initial').value = initial || '';
    $('initial').disabled = !s.profile;
    drawNotices();

    const has = s.available > 0;
    $('empty').hidden = has;
    $('report').hidden = !has;
    if (!has) {
        const hidden = Object.values(data.matches).length;
        $('empty').querySelector('p').textContent = hidden > 0 && !settings.includeOld
            ? `Há ${plural(hidden, 'partida', 'partidas')} de versões anteriores à v43 no histórico. Ative "Incluir partidas anteriores à v43" nos Ajustes para vê-las.`
            : 'Adicione seus replays acima. Cada partida é contada uma única vez, e o histórico continua aqui mesmo que você apague os arquivos depois.';
        return;
    }

    // Filters: only the team sizes this account has played are offered.
    if (filter.size && !s.sizes.includes(filter.size)) filter.size = '';
    $('size').replaceChildren(el('option', { value: '', text: 'Todos' }),
        ...Object.keys(SIZE_NAMES).filter(size => s.sizes.includes(size)).map(size => el('option', { value: size, text: SIZE_NAMES[size] })));
    $('size').value = filter.size;
    $('period').value = filter.period;
    $('rangeBox').hidden = filter.period !== 'custom';
    $('filterNote').textContent = s.filtered ? `${plural(s.matches, 'partida', 'partidas')} de ${fmt.format(s.available)}` : '';
    $('rangeNote').classList.toggle('error', filter.period === 'custom' && !!rangeError);
    if (filter.period === 'custom' && rangeError) {
        $('rangeNote').hidden = false;
        $('rangeNote').textContent = `${rangeError}` + (filter.range ? ` Continua valendo o horário anterior (${rangeText(filter.range)}).` : '');
    } else if (filter.period === 'custom' && filter.range) {
        $('rangeNote').hidden = false;
        $('rangeNote').textContent = s.clipped
            ? `${plural(s.clipped, 'partida começa ou termina', 'partidas começam ou terminam')} fora do horário escolhido: nelas contam só os baús e tesouros abertos dentro dele (pelo horário de cada um, com precisão de cerca de meio minuto). Caixas de munição e comida e os baús dos companheiros dessas partidas ficam de fora, porque o replay só os traz como total da partida.`
            : 'Todas as partidas mostradas estão inteiras dentro do horário escolhido.';
    } else if (filter.period !== 'custom') {
        $('rangeNote').hidden = true;
    }

    $('total').textContent = fmt.format(s.total);
    const notes = [];
    if (s.profile?.name) notes.push(s.profile.name);
    if (s.filtered) notes.push(filterText());
    else if (s.since) notes.push(`desde ${dateDay.format(s.since)}`);
    if (s.initial) notes.push(`inclui ${fmt.format(s.initial)} de antes do contador`);
    if (settings.countTeammates) notes.push('inclui os baús vistos dos companheiros');
    $('totalNote').textContent = notes.join(' · ');
    $('openImage').disabled = s.matches === 0;

    const tile = (label, value, small) => el('div', {}, el('dt', { text: label }), el('dd', { text: value }, small ? el('small', { text: small }) : null));
    const share = n => (s.placed ? `${fmt1.format(100 * n / s.placed)}% de ${fmt.format(s.placed)}` : null);
    $('tiles').replaceChildren(
        tile('Partidas', fmt.format(s.matches)),
        tile('Média por partida', fmt1.format(s.average)),
        tile('Melhor partida', fmt.format(s.bestMatch)),
        tile('Hoje', fmt.format(s.today)),
        tile('Melhor dia', s.bestDay ? fmt.format(s.bestDay.chests) : '—', s.bestDay ? s.bestDay.key.split('-').reverse().join('/') : null),
        tile('Tesouros', fmt.format(s.treasures.length)),
        tile('Token pirata', s.tokens.length ? fmt.format(s.tokens.length) : 'Não', s.tokens.length ? `último ${dateDay.format(s.tokens[0].date)}` : 'nenhum visto ainda'),
        tile('Vitórias', fmt.format(s.wins), share(s.wins)),
        tile('Top 10', fmt.format(s.top10), share(s.top10)),
        ...(settings.showTeammates ? [tile('Baús dos companheiros', '≥ ' + fmt.format(s.teamChests))] : []),
    );

    drawChart(chartDays === 30 ? s.days30 : s.lastDays);
    drawTabs();
    drawStorm(s);
    drawRankings(s);
    drawTreasure(s);
    drawMap(s);
    drawExtras(s);

    const chestTotal = s.byKind.reduce((sum, [, n]) => sum + n, 0);
    table($('kinds'), [{ t: 'Tipo' }, { t: 'Baús', n: true }, { t: '%', n: true }],
        s.byKind.map(([kind, n]) => [kindName(kind), fmt.format(n), fmt1.format(100 * n / chestTotal)]), 'Nenhum baú aberto.');
    const counted = new Set(stats.extraKinds(settings));
    table($('others'), [{ t: 'Tipo' }, { t: 'Abertos', n: true }, { t: 'No total?' }],
        s.others.map(([kind, n]) => [kindName(kind), fmt.format(n), counted.has(kind) ? 'Sim' : 'Não']), 'Nenhum outro contêiner.');
    const modes = new Map();
    for (const row of s.rows) {
        const name = modeName(row.m.playlist);
        const entry = modes.get(name) ?? { matches: 0, chests: 0 };
        entry.matches++;
        entry.chests += row.total;
        modes.set(name, entry);
    }
    table($('modes'), [{ t: 'Modo' }, { t: 'Partidas', n: true }, { t: 'Baús', n: true }, { t: 'Média', n: true }],
        [...modes].sort((a, b) => b[1].chests - a[1].chests).map(([name, e]) => [{ t: name, c: 'wrap' }, fmt.format(e.matches), fmt.format(e.chests), fmt1.format(e.chests / e.matches)]),
        'Nenhuma partida.');

    const withTreasure = s.rows.filter(row => row.m.treasureFinds.length > 0).length;
    $('treasureSummary').textContent = s.treasures.length
        ? `${plural(s.treasures.length, 'tesouro', 'tesouros')} em ${plural(withTreasure, 'partida', 'partidas')} (${fmt1.format(100 * withTreasure / s.matches)}% das partidas mostradas).`
        : '';
    const types = new Map();
    for (const { find } of s.treasures) types.set(treasureName(find), (types.get(treasureName(find)) ?? 0) + 1);
    $('treasureTypes').replaceChildren(...[...types].sort((a, b) => b[1] - a[1]).map(([name, n]) => el('span', { class: 'chip', text: `${name} × ${fmt.format(n)}` })));

    table($('treasures'), [{ t: 'Tesouro' }, { t: 'Partida' }, { t: 'Momento', n: true }, { t: 'Origem' }],
        s.treasures.slice(0, pager('treasures', s.treasures.length)).map(({ find, date }) => [
            { t: (find.fromGoldenChest ? '★★ ' : '★ ') + treasureName(find) + (find.isPirateToken ? ' · TOKEN PIRATA' : '') + (find.scope === 'team' ? ` (achado por ${find.finder || 'companheiro'})` : ''), c: find.isPirateToken ? 'wrap win' : 'wrap' },
            dateShort.format(date), clock(find.obtainedAtSeconds),
            kindName(find.sourceKind) + (find.sourceDestroyed ? ' (destruído)' : '') + (find.sourceIsChest === false ? ' ⚑' : ''),
        ]), 'Nenhum tesouro encontrado nas partidas mostradas.');

    $('matesCard').hidden = !settings.showTeammates;
    if (settings.showTeammates) {
        table($('mates'), [{ t: 'Companheiro' }, { t: 'Partidas juntos', n: true }, { t: 'Vitórias juntos', n: true }, { t: 'Baús vistos', n: true }, { t: 'Parte do time', n: true }, { t: 'Média', n: true }, { t: 'Recorde', n: true }],
            s.mates.slice(0, pager('mates', s.mates.length)).map(m => [m.name || 'Companheiro', fmt.format(m.matches), fmt.format(m.wins), '≥ ' + fmt.format(m.seen),
                m.team ? fmt1.format(100 * m.seen / m.team) + '%' : '—', fmt1.format(m.seen / m.matches), fmt.format(m.best)]),
            'Nenhuma partida em equipe.');
    }

    const visible = s.rows.slice(0, pager('matches', s.rows.length));
    $('matchesNote').textContent = s.rows.length > visible.length ? `(${fmt.format(visible.length)} de ${fmt.format(s.rows.length)})` : `(${fmt.format(s.rows.length)})`;
    const head = [{ t: 'Data' }, { t: 'Modo' }, { t: 'Colocação', n: true }, { t: 'Elim.', n: true }, { t: 'Baús', n: true }, { t: 'Na tempestade', n: true }, { t: 'Tesouros', n: true }];
    if (settings.showTeammates) head.push({ t: 'Equipe' });
    table($('matches'), head, visible.map(({ m, date, total, own, storm }) => {
        const row = [dateShort.format(date), modeName(m.playlist), placeCell(m), m.eliminations ?? '—',
            fmt.format(total) + (total !== own ? ` (${fmt.format(own)} meus)` : ''),
            storm ? `${fmt.format(storm.in)} de ${fmt.format(storm.known)} (${pct(storm.in, storm.known)})` : '—',
            m.treasureFinds?.length ? fmt.format(m.treasureFinds.length) : ''];
        if (settings.showTeammates) {
            row.push({ t: (m.teammates ?? []).map(t => `${t.name} ≥${stats.mateSeen(t, stats.extraKinds(settings))}`).join(', ') || '—', c: 'wrap' });
        }
        return row;
    }), 'Nenhuma partida neste filtro.', index => openMatch(visible[index].m));
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** "13/11 20:00 – 14/11 02:00" (the second day left out when it is the same). */
function rangeText(range) {
    const from = new Date(range.from), to = new Date(range.to);
    const sameDay = stats.dayKey(from) === stats.dayKey(to);
    return `${dateTime.format(from)} – ${sameDay ? timeOnly.format(to) : dateTime.format(to)}`;
}

function filterText() {
    const period = filter.period === 'custom' && filter.range ? rangeText(filter.range) : PERIOD_NAMES[filter.period];
    return [period, SIZE_NAMES[filter.size]].filter(Boolean).join(' · ');
}

/** 'YYYY-MM-DDTHH:MM' in local time, as a datetime-local input wants it. */
const localInput = date => `${stats.dayKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/** Reads the two fields; a window that ends before it starts is refused with a message. */
function readRange() {
    const from = new Date($('rangeFrom').value).getTime(), to = new Date($('rangeTo').value).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to)) return { error: 'Preencha a data e a hora de início e de fim.' };
    if (to <= from) return { error: 'O fim precisa ser depois do início.' };
    return { from, to };
}

function applyRange() {
    const range = readRange();
    // A window that cannot be right keeps the last good one on screen, with the message.
    if (!range.error) filter.range = range;
    rangeError = range.error ?? null;
    if (!range.error) {
        data.settings.range = { from: $('rangeFrom').value, to: $('rangeTo').value };
        store.save(data);
    }
    resetLists();
    render();
}

function drawNotices() {
    drawUpgrade();
    $('storageNotice').hidden = persistent;
    const count = Object.keys(data.matches).length;
    const unsaved = count - (data.backup.at ? data.backup.matches : 0);
    const due = data.backup.at ? unsaved >= 20 : count >= 10;
    $('backupNotice').hidden = !due;
    if (due) {
        $('backupText').textContent = data.backup.at
            ? `${plural(unsaved, 'partida nova', 'partidas novas')} desde o último backup (${dateDay.format(new Date(data.backup.at))}).`
            : `Você tem ${plural(count, 'partida', 'partidas')} e nenhum backup. Limpar os dados do navegador apaga o histórico.`;
    }
    $('storageState').textContent = !persistent
        ? 'Armazenamento: nada está sendo guardado nesta janela.'
        : protectedStorage === true
            ? 'Armazenamento: protegido. O navegador não apaga o histórico sozinho.'
            : protectedStorage === false
                ? 'Armazenamento: o navegador pode apagar o histórico se o disco encher. Mantenha um backup (Exportar histórico).'
                : '';
    $('appVersion').textContent = `Versão ${APP_VERSION}` + (engine ? ` · analisador ${engine.analyzerVersion}` + (engine.nativeBytes && engine.nativeBytes <= 8 * 1048576 ? ' · sem AOT' : '') : '');
}

function drawTabs() {
    for (const button of document.querySelectorAll('[data-tab-button]')) {
        const on = button.dataset.tabButton === tab;
        button.classList.toggle('primary', on);
        button.setAttribute('aria-selected', String(on));
    }
    for (const panel of document.querySelectorAll('[data-tab]')) panel.hidden = panel.dataset.tab !== tab;
}

/** One horizontal bar split in two (safe zone / storm), with the figures written under it. */
function splitBar(label, safe, storm, scale = 1) {
    const total = safe + storm;
    return el('div', { class: 'split' },
        el('div', { class: 'splitLabel', text: label }),
        el('div', { class: 'splitTrack', style: `width:${Math.max(2, 100 * scale)}%` },
            safe ? el('div', { class: 'safe', style: `flex:${safe}`, title: `Zona segura: ${fmt.format(safe)} (${pct(safe, total)})` }) : null,
            storm ? el('div', { class: 'storm', style: `flex:${storm}`, title: `Tempestade: ${fmt.format(storm)} (${pct(storm, total)})` }) : null),
        el('div', { class: 'splitText' },
            el('span', { class: 'key safe' }), el('span', { text: `Zona segura ${fmt.format(safe)} (${pct(safe, total)})` }),
            el('span', { class: 'key storm' }), el('span', { text: `Tempestade ${fmt.format(storm)} (${pct(storm, total)})` })));
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
}

function drawStorm(s) {
    const { chests, treasures, phases, points, matches } = s.storm;
    const known = chests.in + chests.out, knownTreasures = treasures.in + treasures.out;
    if (known === 0) {
        $('stormText').textContent = 'Ainda não há dados de tempestade para as partidas mostradas.';
        $('stormBars').replaceChildren();
        $('phaseText').textContent = 'Sem dados ainda.';
        $('stormPhases').replaceChildren();
    } else {
        const sentences = [`Dos ${plural(known, 'baú', 'baús')} com posição conhecida, ${fmt.format(chests.out)} (${pct(chests.out, known)}) foram abertos na zona segura e ${fmt.format(chests.in)} (${pct(chests.in, known)}) dentro da tempestade.`];
        sentences.push(knownTreasures
            ? `Dos ${plural(knownTreasures, 'tesouro', 'tesouros')}, ${fmt.format(treasures.out)} (${pct(treasures.out, knownTreasures)}) vieram na zona segura e ${fmt.format(treasures.in)} (${pct(treasures.in, knownTreasures)}) dentro da tempestade.`
            : 'Nenhum tesouro com posição conhecida nas partidas mostradas.');
        $('stormText').textContent = sentences.join(' ');
        $('stormBars').replaceChildren(splitBar('Baús', chests.out, chests.in), knownTreasures ? splitBar('Tesouros', treasures.out, treasures.in) : '');

        const top = phases.reduce((best, entry) => (entry[1].in + entry[1].out > best[1].in + best[1].out ? entry : best), phases[0]);
        const worst = phases.filter(([, p]) => p.in + p.out >= 5).reduce((best, entry) => (!best || entry[1].in / (entry[1].in + entry[1].out) > best[1].in / (best[1].in + best[1].out) ? entry : best), null);
        $('phaseText').textContent = `A fase com mais baús é a ${top[0]} (${fmt.format(top[1].in + top[1].out)}).`
            + (worst && worst[1].in > 0 ? ` A maior parte dentro da tempestade é na fase ${worst[0]}: ${pct(worst[1].in, worst[1].in + worst[1].out)}.` : '');
        const most = Math.max(...phases.map(([, p]) => p.in + p.out));
        $('stormPhases').replaceChildren(...phases.map(([phase, p]) => splitBar(`Fase ${phase}`, p.out, p.in, (p.in + p.out) / most)));
    }
    const missing = s.matches - matches;
    $('stormNote').textContent = [
        missing > 0 ? `${plural(missing, 'partida mostrada não tem', 'partidas mostradas não têm')} dados de tempestade: foram lidas antes desta função existir (adicione os replays de novo, se ainda os tiver) ou o replay não trouxe a posição.` : '',
        'Vale para baús de verdade (não caixas de munição). Enquanto o círculo está fechando a borda é calculada, então um baú aberto bem em cima dela pode cair do lado errado.',
    ].filter(Boolean).join(' ');
}

// ---- map ------------------------------------------------------------------------------------------------
// Colours checked with the dataviz validator against the map surface (dark): the safe / storm pair, and the
// four chest kinds in this order. Storm markers are also drawn hollow, so colour is not the only cue.
const MAP_SAFE = '#1c9bd6', MAP_STORM = '#b44dff', MAP_TREASURE = '#fcf400';
const MAP_KINDS = [['Chest', 'Baú', '#2f8fe6'], ['Rare chest', 'Baú raro', '#a88d00'], ['Extraction / relic chest', 'Extração / relíquia', '#a05ae8'], [null, 'Outros', '#d9582f']];
/** One hue, dark to light: early to late. */
const ramp = fraction => `hsl(197, 90%, ${Math.round(28 + 52 * Math.min(1, Math.max(0, fraction)))}%)`;
const mapState = { mode: 'points', color: 'storm', treasures: false };
let mainMap = null;

function pointColor(point, by) {
    if (by === 'kind') return (MAP_KINDS.find(([kind]) => kind === point.kind) ?? MAP_KINDS[3])[2];
    if (by === 'phase') return ramp(point.phase / 7);
    if (by === 'time') return ramp(point.t / 1200);
    return point.inStorm ? MAP_STORM : MAP_SAFE;
}
const chestMarker = (point, by) => ({ x: point.x, y: point.y, color: pointColor(point, by), shape: point.inStorm ? 'hollow' : 'square', data: point });
const treasureMarker = point => ({ x: point.x, y: point.y, color: MAP_TREASURE, shape: 'diamond', data: point });
const legendItem = (color, text, shape = '') => [el('span', { class: `key ${shape}`, style: `background:${color}` }), el('span', { text })];

/** A saved route (flat triples: seconds, x and y in metres) as map points; a hole in time breaks the line. */
function routeLine(route) {
    const line = [];
    for (let i = 0; i + 2 < route.length; i += 3) {
        if (i > 0 && route[i] - route[i - 3] > 30) line.push(null); // no position for a while (vehicle…): no straight line across it
        line.push([route[i + 1] * 100, route[i + 2] * 100]);
    }
    return line;
}

/** Legend of a gradient: the bar, with what its two ends mean. */
const gradientLegend = (css, low, high) => [el('span', { text: low }), el('span', { class: 'gradient', style: `background:${css}` }), el('span', { text: high })];

function showPick(point) {
    const box = $('mapPick');
    box.hidden = !point;
    if (!point) return;
    const whereText = point.inStorm == null ? 'sem dado de tempestade'
        : (point.inStorm ? 'dentro da tempestade' : 'na zona segura') + (point.edge != null ? `, a ${fmt.format(Math.abs(Math.round(point.edge)))} m da borda` : '') + ` · fase ${point.phase}`;
    const open = el('button', { type: 'button', class: 'small', text: 'Abrir partida' });
    open.addEventListener('click', () => openMatch(point.m));
    box.replaceChildren(
        el('b', { text: point.find ? treasureName(point.find) : kindName(point.kind) }),
        el('span', { text: ` · ${modeName(point.m.playlist)} · ${dateShort.format(point.date)} · aos ${clock(point.t)} · ${whereText}` }),
        open);
}

function drawMap(s) {
    mainMap ??= createMap($('map'), { onPick: showPick });
    const { points, treasurePoints, landings, routes } = s.storm;
    const { mode, color, treasures } = mapState;
    $('mapMode').value = mode;
    $('mapColor').value = color;
    $('mapTreasures').checked = treasures;
    $('mapColorBox').hidden = mode !== 'points' || treasures;
    $('mapTreasureBox').hidden = mode !== 'points';

    let scene = { markers: [] }, text = '', legend = [];
    if (mode === 'points') {
        const diamonds = treasurePoints.map(treasureMarker);
        scene.markers = treasures ? diamonds : [...points.map(p => chestMarker(p, color)), ...diamonds];
        text = treasures
            ? `${plural(treasurePoints.length, 'tesouro', 'tesouros')} com posição conhecida.`
            : `${plural(points.length, 'baú', 'baús')} de ${plural(s.storm.matches, 'partida', 'partidas')}` + (treasurePoints.length ? ` e ${plural(treasurePoints.length, 'tesouro', 'tesouros')} (losangos amarelos).` : '.');
        if (!treasures) {
            if (color === 'kind') legend = MAP_KINDS.flatMap(([, name, c]) => legendItem(c, name));
            else if (color === 'phase') legend = [...legendItem(ramp(0), 'Fase 0'), ...legendItem(ramp(0.5), 'Fase 3–4'), ...legendItem(ramp(1), 'Fase 7')];
            else if (color === 'time') legend = [...legendItem(ramp(0), 'Início'), ...legendItem(ramp(0.5), '10 min'), ...legendItem(ramp(1), '20 min ou mais')];
            else legend = [...legendItem(MAP_SAFE, 'Zona segura (cheio)'), ...legendItem(MAP_STORM, 'Tempestade (vazado)', 'hollow')];
            if (color !== 'storm') legend.push(...legendItem('transparent', 'Quadrado vazado: na tempestade', 'hollow outline'));
        }
        if (treasurePoints.length) legend.push(...legendItem(MAP_TREASURE, 'Tesouro', 'diamond'));
    } else if (mode === 'heat') {
        scene.heat = { points: points.map(p => [p.x, p.y]) };
    } else if (mode === 'route') {
        scene.lines = routes.map(routeLine);
    } else {
        scene.markers = landings.map(p => chestMarker(p, 'kind'));
        text = landings.length ? `O primeiro baú de ${plural(landings.length, 'partida', 'partidas')}: é onde você costuma pousar.` : '';
        legend = MAP_KINDS.flatMap(([, name, c]) => legendItem(c, name));
    }

    const heat = mainMap.update(scene);
    if (mode === 'heat' && heat) {
        const side = fmt.format(Math.round(heat.cell / 100));
        text = `${plural(points.length, 'baú', 'baús')}. A área mais quente junta ${plural(heat.max, 'baú', 'baús')} num quadrado de ${side} m de lado (${pct(heat.max, points.length)} do total).`;
        legend = gradientLegend(HEAT_CSS, '1 baú', `${plural(heat.max, 'baú', 'baús')} ou mais perto`);
    } else if (mode === 'route' && routes.length) {
        const minutes = routes.reduce((sum, route) => sum + route.length / 3, 0) * 4 / 60;
        text = `As rotas de ${plural(routes.length, 'partida', 'partidas')} (${fmt.format(Math.round(minutes))} min de jogo), uma linha por partida. Onde as linhas se juntam e ficam mais claras é caminho que você repete.`;
        legend = [el('span', { class: 'key line faint' }), el('span', { text: 'Passou uma vez' }), el('span', { class: 'key line strong' }), el('span', { text: 'Caminho repetido' })];
    }
    if (!scene.markers.length && !scene.heat?.points.length && !scene.lines?.length) {
        text = mode === 'route'
            ? 'Sem rota guardada para as partidas mostradas. Adicione os replays de novo para o mapa ter a rota.'
            : 'Sem posições para as partidas mostradas. Adicione os replays de novo, se ainda os tiver.';
        legend = [];
    }
    $('mapText').textContent = text;
    $('mapLegend').replaceChildren(...(legend.length ? [el('span', { class: 'legendTitle', text: 'Legenda' }), ...legend] : []));
}

for (const [id, key] of [['mapMode', 'mode'], ['mapColor', 'color']]) {
    $(id).addEventListener('change', event => { mapState[key] = event.target.value; showPick(null); render(); });
}
$('mapTreasures').addEventListener('change', event => { mapState.treasures = event.target.checked; showPick(null); render(); });

/** The map of one match: the route as a dashed line and the chests numbered in the order they were opened. */
function matchMap(m) {
    const host = el('div', { class: 'mapHost small' });
    const map = createMap(host);
    const line = routeLine(m.storm?.route ?? []);
    const ordered = [...m.chests].sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0));
    const markers = [];
    ordered.forEach((chest, i) => {
        if (Number.isFinite(chest.storm?.x)) markers.push({ x: chest.storm.x, y: chest.storm.y, color: chest.storm.inStorm ? MAP_STORM : MAP_SAFE, shape: chest.storm.inStorm ? 'hollow' : 'square', label: String(i + 1) });
    });
    for (const find of m.treasureFinds) if (Number.isFinite(find.storm?.x)) markers.push({ x: find.storm.x, y: find.storm.y, color: MAP_TREASURE, shape: 'diamond' });
    if (markers.length === 0 && line.length === 0) return null;
    map.update({ markers, line });
    return el('div', {}, host, el('div', { class: 'splitText legend' }, el('span', { class: 'legendTitle', text: 'Legenda' }),
        ...legendItem(MAP_SAFE, 'Baú na zona segura (nº = ordem)'), ...legendItem(MAP_STORM, 'Baú na tempestade', 'hollow'),
        ...(m.treasureFinds.some(f => f.storm) ? legendItem(MAP_TREASURE, 'Tesouro', 'diamond') : []),
        ...(line.length ? [el('span', { class: 'key dash' }), el('span', { text: 'Sua rota' })] : [])));
}

// ---- Treasure Hours and chances ----------------------------------------------------------------------------
const times_ = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const mult = n => `${times_.format(n)}×`;
const pctFine = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumSignificantDigits: 2 });
const weekdayTime = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
let editingEvents = false;

/** The Treasure Hours in use: the person's list, or the defaults (which follow updates while never edited). */
function events() {
    return data.settings.events ? treasure.readEvents(data.settings.events) : treasure.readEvents(null);
}
const chanceText = c => (c <= 0 ? '0%' : c >= 0.9995 ? 'quase 100%' : c < 0.0001 ? `${pctFine.format(c)}` : pctFine.format(c));
const oneIn = c => (c > 0 ? `1 em ${fmt.format(Math.round(1 / c))}` : '—');

/** "2 d 03:14:09" until a moment. */
function countdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (d ? `${d} d ` : '') + [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

/** Two-part bar with its own names and colours (classes a / b). */
function pairBar(label, a, aName, b, bName, bClass = 'gold') {
    const total = a + b;
    return el('div', { class: 'split' },
        el('div', { class: 'splitLabel', text: label }),
        el('div', { class: 'splitTrack' },
            a ? el('div', { class: 'safe', style: `flex:${a}` }) : null,
            b ? el('div', { class: bClass, style: `flex:${b}` }) : null,
            total ? null : el('div', { class: 'empty', style: 'flex:1' })),
        el('div', { class: 'splitText' },
            el('span', { class: 'key safe' }), el('span', { text: `${aName} ${fmt.format(a)}` + (total ? ` (${pct(a, total)})` : '') }),
            el('span', { class: `key ${bClass}` }), el('span', { text: `${bName} ${fmt.format(b)}` + (total ? ` (${pct(b, total)})` : '') })));
}

/** One bar per value, all on the same scale, with the value written after it. */
function valueBars(rows) {
    const max = Math.max(1, ...rows.map(r => r.value));
    return el('div', { class: 'valueBars' }, ...rows.map(r => el('div', { class: 'valueRow' },
        el('span', { class: 'valueLabel', text: r.label }),
        el('span', { class: 'valueTrack' }, el('span', { class: `valueFill ${r.cls ?? ''}`, style: `width:${Math.max(r.value ? 1.5 : 0, 100 * r.value / max)}%` })),
        el('span', { class: 'valueText', text: r.text }))));
}

function claimKey(prize, profile, weekStart) {
    return `${profile}|${prize.scope === 'season' ? 'season' : weekStart}`;
}

// ---- Rankings ---------------------------------------------------------------------------------------------
/** Matches ordered by a value (ties share the position, the older match first), with a bar for each. */
function rankList(name, entries, unit, describe) {
    entries.sort((a, b) => b.value - a.value || a.date - b.date);
    let position = 0;
    entries.forEach((e, i) => { if (i === 0 || e.value !== entries[i - 1].value) position = i + 1; e.position = position; });
    const shown = entries.slice(0, pager(name, entries.length));
    const max = Math.max(1, entries[0]?.value ?? 0);
    const list = $(name);
    list.replaceChildren(...shown.map(e => {
        const item = el('li', { class: `rankRow p${Math.min(e.position, 4)}`, tabindex: '0', role: 'button', 'aria-label': `${e.position}º: ${plural(e.value, ...unit)} em ${dateShort.format(e.date)}` },
            el('span', { class: 'rankPos', text: `#${e.position}` }),
            el('span', { class: 'rankBody' },
                el('span', { class: 'rankTop' },
                    el('span', { class: 'rankValue', text: plural(e.value, ...unit) }),
                    el('span', { class: 'rankWhen', text: `${dateShort.format(e.date)} · ${modeName(e.m.playlist)}` + (e.m.placement ? ` · ${e.m.placement}º lugar` : '') })),
                el('span', { class: 'rankTrack' }, el('span', { class: 'rankFill', style: `width:${100 * e.value / max}%` })),
                describe ? el('span', { class: 'rankDetail', text: describe(e) }) : null));
        const open = () => openMatch(e.m);
        item.addEventListener('click', open);
        item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        return item;
    }));
    return entries;
}

function drawRankings(s) {
    const settings = data.settings;
    const chests = rankList('rankChests', s.rows.filter(r => r.total > 0).map(r => ({ m: r.m, date: r.date, value: r.total, own: r.own })),
        ['baú', 'baús'], e => [e.value !== e.own ? `${fmt.format(e.own)} seus, o resto do time` : '',
            e.m.durationSeconds > 60 ? `${fmt1.format(e.value / (e.m.durationSeconds / 60))} por minuto` : '',
            e.m.eliminations ? plural(e.m.eliminations, 'eliminação', 'eliminações') : ''].filter(Boolean).join(' · '));
    const treasures = rankList('rankTreasures', s.rows.map(r => ({ m: r.m, date: r.date, finds: stats.treasuresOf(r.m, settings) }))
        .filter(e => e.finds.length).map(e => ({ ...e, value: e.finds.length })),
        ['tesouro', 'tesouros'], e => {
            const names = new Map();
            for (const f of e.finds) names.set(treasureName(f), (names.get(treasureName(f)) ?? 0) + 1);
            return [...names].map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join(', ');
        });
    const avg = s.rows.length ? s.total / s.rows.length : 0;
    $('rankChestsText').textContent = chests.length
        ? `Sua melhor partida teve ${plural(chests[0].value, 'baú', 'baús')} (${dateShort.format(chests[0].date)}), ${fmt1.format(chests[0].value / Math.max(avg, 0.1))}× a sua média de ${fmt1.format(avg)} por partida neste filtro.`
        : 'Nenhuma partida com baús neste filtro.';
    const withTreasure = treasures.length;
    $('rankTreasuresText').textContent = withTreasure
        ? `${plural(withTreasure, 'partida teve', 'partidas tiveram')} tesouro (${pct(withTreasure, s.rows.length)} das partidas neste filtro). O recorde é ${plural(treasures[0].value, 'tesouro', 'tesouros')} em uma partida.`
        : 'Nenhum tesouro encontrado nas partidas deste filtro.';
}

function drawTreasure(s) {
    const list = events();
    const now = Date.now();
    const reset = treasure.DEFAULT_RESET;
    const weekStart = treasure.weekStart(now, reset), weekEnd = weekStart + 7 * 86400000;
    const all = s.profile?.matches ?? [];
    const times = treasure.chestTimes(all, stats.when, stats.CHEST_KINDS);
    const weekTimes = times.filter(t => t >= weekStart && t < weekEnd);
    const seasonTimes = times.filter(t => t >= treasure.SEASON.start && t < treasure.SEASON.end);
    const inEvent = arr => arr.filter(t => treasure.eventAt(list, t)).length;

    // Teammates' chests (minimum seen, no times): counted at the base chance, by the match's start.
    const mateChests = (from, to) => all.filter(m => { const t = stats.when(m).getTime(); return t >= from && t < to; })
        .reduce((sum, m) => sum + (m.teammates ?? []).reduce((a, t) => a + (t.chestsSeen ?? 0), 0), 0);
    const team = data.settings.chanceTeam;
    $('chanceTeam').checked = team;

    // Next / current Treasure Hour
    const current = list.find(e => now >= e.start && now < e.end);
    const next = list.find(e => e.start > now);
    $('nextEvent').dataset.until = String(current ? current.end : next ? next.start : '');
    $('nextEvent').dataset.label = current ? 'Acontecendo agora · termina em' : next ? 'Começa em' : '';
    const describe = e => `${weekdayTime.format(new Date(e.start))} até ${timeOnly.format(new Date(e.end))} · Roupa Dourada ${mult(e.gold)}, token ${mult(e.shop)}, veículo ${mult(e.vehicle)}` + (e.status === 'previsto' ? ' (previsto: a Epic ainda não anunciou)' : '');
    $('nextEventText').textContent = current ? `Agora: ${describe(current)}. Abra o máximo de baús que puder.`
        : next ? `${describe(next)}.` : 'Nenhuma Hora do Tesouro futura na lista. Adicione as próximas em "Horas do Tesouro", abaixo, quando a Epic anunciar.';
    $('weekReset').dataset.until = String(weekEnd);
    $('weekReset').dataset.label = 'Prêmios da semana trocam em';

    const teamWeek = team ? mateChests(weekStart, weekEnd) : 0;
    $('weekText').textContent = `Semana desde ${weekdayTime.format(new Date(weekStart))}: você abriu ${plural(weekTimes.length, 'baú', 'baús')}, ${fmt.format(inEvent(weekTimes))} dentro de uma Hora do Tesouro.`
        + (team ? ` Seus companheiros foram vistos abrindo pelo menos ${fmt.format(teamWeek)}.` : '')
        + ' Cada baú conta pelo horário em que foi aberto, então uma partida que atravessa a troca entra só com os baús de depois dela.';
    $('weekBars').replaceChildren(pairBar('Baús desta semana', weekTimes.length - inEvent(weekTimes), 'Fora da Hora do Tesouro', inEvent(weekTimes), 'Na Hora do Tesouro'));

    // Chances
    const claims = data.settings.claims;
    const profile = s.profile?.key ?? '';
    const rows = treasure.PRIZES.map(prize => {
        const scopeTimes = prize.scope === 'season' ? seasonTimes : weekTimes;
        const extra = team ? (prize.scope === 'season' ? mateChests(treasure.SEASON.start, treasure.SEASON.end) : teamWeek) : 0;
        const result = treasure.chanceOf(prize, scopeTimes, list, extra);
        const key = claimKey(prize, profile, weekStart);
        const owned = (claims[key] ?? []).includes(prize.id);
        const boosted = prize.boost ? `${fmt.format(Math.round(prize.den / (current?.[prize.boost] ?? 1)))}` : null;
        return { prize, result, key, owned, boosted, chests: scopeTimes.length + extra };
    });
    const gold = rows[0];
    $('chanceText').textContent = gold.owned ? 'Você marcou a Roupa Dourada desta semana como já ganha.'
        : `Chance de já ter tirado a Roupa Dourada nesta semana: ${chanceText(gold.result.chance)} (${oneIn(gold.result.chance)}), com ${plural(gold.chests, 'baú', 'baús')}. Token pirata na temporada: ${chanceText(rows[1].result.chance)}.`;
    table($('chances'), [{ t: 'Prêmio' }, { t: 'Por baú', n: true }, { t: 'Baús contados', n: true }, { t: 'Sua chance', n: true }, { t: 'Já tenho' }],
        rows.map(r => [
            { t: r.prize.name, c: 'wrap' },
            `1 em ${fmt.format(r.prize.den)}` + (current && r.prize.boost ? ` (agora 1 em ${r.boosted})` : ''),
            fmt.format(r.chests),
            r.prize.scope === 'repeat' ? `${fmt1.format(r.result.expected)} esperados` : r.owned ? 'ganho' : chanceText(r.result.chance),
            r.prize.scope === 'repeat' ? '' : (r.owned ? '✓' : '—'),
        ]), '');
    // "Já tenho" toggles (the cells are rebuilt as checkboxes).
    [...$('chances').querySelectorAll('tbody tr')].forEach((tr, i) => {
        const r = rows[i];
        if (r.prize.scope === 'repeat') return;
        const box = el('input', { type: 'checkbox', 'aria-label': `Já tenho: ${r.prize.name}` });
        box.checked = r.owned;
        box.addEventListener('change', () => {
            const set = new Set(data.settings.claims[r.key] ?? []);
            if (box.checked) set.add(r.prize.id); else set.delete(r.prize.id);
            data.settings.claims[r.key] = [...set];
            persist();
        });
        tr.lastChild.replaceChildren(box);
    });

    // Goal
    const goal = data.settings.goal;
    const goalRows = rows.filter(r => r.prize.scope !== 'repeat');
    if (!$('goalPrize').options.length) {
        $('goalPrize').replaceChildren(...goalRows.map(r => el('option', { value: r.prize.id, text: r.prize.name })));
    }
    const pick = goalRows.find(r => r.prize.id === goal.prize) ?? goalRows[0];
    $('goalPrize').value = pick.prize.id;
    $('goalTarget').value = String(goal.target);
    // The boost of the Treasure Hour going on, or the next one (sessions do not all give the same boost).
    const boost = pick.prize.boost ? Math.max(1, (current ?? next ?? list.at(-1))?.[pick.prize.boost] ?? 1) : 1;
    const needBase = treasure.chestsFor(pick.prize, goal.target, pick.result.chance, 1);
    const needEvent = treasure.chestsFor(pick.prize, goal.target, pick.result.chance, boost);
    $('goalText').textContent = pick.owned ? `Você já tem: ${pick.prize.name}.`
        : pick.result.chance >= goal.target ? `Você já passou de ${pctFine.format(goal.target)} de chance para ${pick.prize.name}.`
            : `Para chegar a ${pctFine.format(goal.target)} de chance de ${pick.prize.name} ${pick.prize.scope === 'season' ? 'na temporada' : 'nesta semana'}, faltam cerca de ${plural(needBase, 'baú', 'baús')} fora da Hora do Tesouro`
              + (boost > 1 ? `, ou ${plural(needEvent, 'baú', 'baús')} dentro dela (${mult(boost)}).` : '. A Hora do Tesouro não aumenta este prêmio.')
              + (weekTimes.length ? ` No seu ritmo desta semana (${fmt1.format(weekTimes.length / Math.max(1, s.rows.filter(r => r.date.getTime() >= weekStart).length))} baús por partida), isso dá umas ${fmt.format(Math.ceil(needBase / Math.max(1, weekTimes.length / Math.max(1, s.rows.filter(r => r.date.getTime() >= weekStart).length))))} partidas fora do evento.` : '');
    $('goalBars').replaceChildren(pick.owned || pick.result.chance >= goal.target ? '' : valueBars([
        { label: 'Fora do evento', value: needBase, text: plural(needBase, 'baú', 'baús'), cls: 'safe' },
        ...(boost > 1 ? [{ label: `Na Hora do Tesouro (${mult(boost)})`, value: needEvent, text: plural(needEvent, 'baú', 'baús'), cls: 'gold' }] : []),
    ]));

    drawWeeks(list, times, now, reset);
    drawEvents(list, times, now);
    tickCountdowns();
}

/** One row per prize week of the season: chests, how many inside a Treasure Hour, and the Gold Outfit chance of that week. */
function drawWeeks(list, times, now, reset) {
    const gold = treasure.PRIZES[0], vehicle = treasure.PRIZES[2];
    const weeks = [];
    for (let start = treasure.SEASON.start, n = 1; start < Math.min(now, treasure.SEASON.end); n++) {
        const end = Math.min(treasure.weekStart(start, reset) + 7 * 86400000, treasure.SEASON.end);
        const inside = times.filter(t => t >= start && t < end);
        weeks.push({ n, start, end, chests: inside.length, event: inside.filter(t => treasure.eventAt(list, t)).length,
            gold: treasure.chanceOf(gold, inside, list).chance, vehicle: treasure.chanceOf(vehicle, inside, list).chance, current: now >= start && now < end });
        start = end;
    }
    const max = Math.max(1, ...weeks.map(w => w.chests));
    $('weekHistory').replaceChildren(...weeks.map(w => el('div', { class: 'weekRow' + (w.current ? ' current' : '') },
        el('span', { class: 'valueLabel', text: `Semana ${w.n}${w.current ? ' (atual)' : ''}` }),
        el('span', { class: 'weekTrack' },
            w.chests - w.event ? el('span', { class: 'safe', style: `width:${100 * (w.chests - w.event) / max}%` }) : null,
            w.event ? el('span', { class: 'gold', style: `width:${100 * w.event / max}%` }) : null),
        el('span', { class: 'valueText', text: `${plural(w.chests, 'baú', 'baús')}` + (w.event ? ` · ${fmt.format(w.event)} no evento` : '') + ` · roupa ${chanceText(w.gold)} · veículo ${chanceText(w.vehicle)}` }))));
    const best = weeks.reduce((a, w) => (w.chests > (a?.chests ?? -1) ? w : a), null);
    $('weekHistoryText').textContent = weeks.length && best?.chests
        ? `Sua semana com mais baús foi a ${best.n}: ${plural(best.chests, 'baú', 'baús')}, ${fmt.format(best.event)} deles numa Hora do Tesouro. As chances de cada semana não se somam, porque a roupa e o veículo mudam a cada troca.`
        : 'Nenhum baú com horário nas semanas da temporada ainda.';
}

function drawEvents(list, times, now) {
    const edited = !!data.settings.events;
    $('eventsNote').textContent = (edited ? 'Lista editada por você.' : 'Lista padrão, conferida em 16/11/2026 em sites que acompanham os anúncios da Epic.')
        + ' Horários no seu fuso. "Previsto" é o padrão de sábado que ainda não foi anunciado: confira e ajuste quando a Epic anunciar.';
    $('eventsEdit').textContent = editingEvents ? 'Pronto' : 'Editar horários';
    $('eventsAdd').hidden = $('eventsReset').hidden = !editingEvents;
    const target = $('events');
    target.replaceChildren();
    const head = ['Início', 'Fim', 'Roupa ×', 'Token ×', 'Veículo ×', 'Situação', 'Seus baús', ''];
    target.append(el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', { class: i >= 2 && i <= 4 || i === 6 ? 'n' : '', text: h })))));
    const body = el('tbody');
    list.forEach((event, index) => {
        const opened = times.filter(t => t >= event.start && t < event.end).length;
        const state = now >= event.end ? 'passou' : now >= event.start ? 'agora' : event.status;
        let cells;
        if (editingEvents) {
            const input = (type, value, key) => {
                const field = el('input', { type, value, step: type === 'number' ? '0.5' : '60', min: type === 'number' ? '1' : '' });
                field.addEventListener('change', () => {
                    const next = events();
                    next[index][key] = type === 'number' ? Number(field.value) || 1 : new Date(field.value).getTime();
                    if (key === 'start' && next[index].end <= next[index].start) next[index].end = next[index].start + 2 * 3600000;
                    next[index].status = 'meu';
                    saveEvents(next);
                });
                return el('td', {}, field);
            };
            const remove = el('button', { type: 'button', class: 'small danger', text: 'Tirar' });
            remove.addEventListener('click', () => { const next = events(); next.splice(index, 1); saveEvents(next); });
            cells = [input('datetime-local', localInput(new Date(event.start)), 'start'), input('datetime-local', localInput(new Date(event.end)), 'end'),
                input('number', event.gold, 'gold'), input('number', event.shop, 'shop'), input('number', event.vehicle, 'vehicle'),
                el('td', { text: state }), el('td', { class: 'n', text: fmt.format(opened) }), el('td', {}, remove)];
        } else {
            const filterButton = el('button', { type: 'button', class: 'small', text: 'Ver baús' });
            filterButton.addEventListener('click', () => {
                $('period').value = 'custom';
                $('rangeFrom').value = localInput(new Date(event.start));
                $('rangeTo').value = localInput(new Date(event.end));
                filter.period = 'custom';
                tab = 'resumo';
                applyRange();
                window.scrollTo({ top: $('report').offsetTop - 10, behavior: 'smooth' });
            });
            cells = [el('td', { text: weekdayTime.format(new Date(event.start)) }), el('td', { text: timeOnly.format(new Date(event.end)) }),
                el('td', { class: 'n', text: mult(event.gold) }), el('td', { class: 'n', text: mult(event.shop) }), el('td', { class: 'n', text: mult(event.vehicle) }),
                el('td', { class: state === 'agora' ? 'win' : state === 'previsto' ? 'muted' : '', text: state }),
                el('td', { class: 'n', text: event.start > now ? '' : fmt.format(opened) }),
                el('td', {}, event.start > now ? null : filterButton)];
        }
        body.append(el('tr', {}, ...cells));
    });
    target.append(body);
}

function saveEvents(list) {
    data.settings.events = list;
    persist();
}

/** Countdowns tick once a second while the Treasure Hour tab is open. */
function tickCountdowns() {
    for (const box of [$('nextEvent'), $('weekReset')]) {
        const until = Number(box.dataset.until);
        box.textContent = until ? `${box.dataset.label} ${countdown(until - Date.now())}` : '';
    }
}
setInterval(() => {
    if (tab !== 'tesouro' || document.hidden) return;
    const first = [$('nextEvent'), $('weekReset')].some(box => Number(box.dataset.until) && Number(box.dataset.until) <= Date.now());
    if (first) render(); else tickCountdowns();
}, 1000);

$('chanceTeam').addEventListener('change', event => { data.settings.chanceTeam = event.target.checked; persist(); });
$('goalPrize').addEventListener('change', event => { data.settings.goal = { ...data.settings.goal, prize: event.target.value }; persist(); });
$('goalTarget').addEventListener('change', event => { data.settings.goal = { ...data.settings.goal, target: Number(event.target.value) }; persist(); });
$('eventsEdit').addEventListener('click', () => { editingEvents = !editingEvents; render(); });
$('eventsAdd').addEventListener('click', () => {
    const list = events();
    const last = list.at(-1);
    const start = last ? last.start + 7 * 86400000 : Date.now();
    list.push({ start, end: start + 2 * 3600000, gold: last?.gold ?? 7.5, shop: last?.shop ?? 1.5, vehicle: last?.vehicle ?? 10, status: 'meu' });
    saveEvents(list);
});
$('eventsReset').addEventListener('click', () => {
    if (!confirm('Voltar à lista padrão de Horas do Tesouro? As suas mudanças na lista serão perdidas.')) return;
    data.settings.events = null;
    persist();
});

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WEEKDAYS_LONG = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];

function drawExtras(s) {
    // Rhythm: chests per minute of the recording.
    const minutes = s.minutes.slice(0, 40);
    const peak = Math.max(1, ...minutes);
    const peakMinute = minutes.indexOf(peak);
    const totalChests = minutes.reduce((a, b) => a + b, 0);
    const firstFive = minutes.slice(0, 5).reduce((a, b) => a + b, 0);
    $('rhythmText').textContent = totalChests
        ? `O minuto ${peakMinute + 1} é o que mais rende (${plural(peak, 'baú', 'baús')} somando todas as partidas). ${pct(firstFive, totalChests)} dos baús saem nos 5 primeiros minutos.`
        : 'Sem baús nas partidas mostradas.';
    $('rhythm').style.gridTemplateColumns = $('rhythmAxis').style.gridTemplateColumns = `repeat(${Math.max(1, minutes.length)}, 1fr)`;
    $('rhythm').setAttribute('aria-label', 'Baús por minuto de partida: ' + minutes.map((n, i) => `min ${i + 1}: ${n}`).join(', '));
    $('rhythm').replaceChildren(...minutes.map((n, i) => el('div', { class: 'col', tabindex: '0', title: `Minuto ${i + 1}: ${plural(n, 'baú', 'baús')}` },
        el('div', { class: 'val', text: n === peak && n > 0 ? fmt.format(n) : '' }),
        el('div', { class: 'bar', style: `height:${(n / peak) * 82}%` }))));
    $('rhythmAxis').replaceChildren(...minutes.map((_, i) => el('div', { text: (i + 1) % 5 === 0 || i === 0 ? String(i + 1) : '' })));

    // Weekday x hour.
    const max = Math.max(1, ...s.heat.flat());
    let best = null;
    s.heat.forEach((row, day) => row.forEach((n, hour) => { if (n > 0 && (!best || n > best.n)) best = { n, day, hour }; }));
    $('heatText').textContent = best
        ? `Seu melhor horário: ${WEEKDAYS_LONG[best.day]} por volta das ${best.hour}h (${plural(best.n, 'baú', 'baús')}).`
        : 'Sem partidas mostradas.';
    $('heat').setAttribute('aria-label', 'Baús por dia da semana e hora');
    $('heat').replaceChildren(
        el('div', { class: 'heatRow' }, el('span', { class: 'heatDay' }), ...Array.from({ length: 24 }, (_, h) => el('span', { class: 'heatHour', text: h % 3 === 0 ? `${h}h` : '' }))),
        ...s.heat.map((row, day) => el('div', { class: 'heatRow' }, el('span', { class: 'heatDay', text: WEEKDAYS[day] }),
            ...row.map((n, hour) => el('span', { class: 'heatCell', tabindex: n ? '0' : '-1', title: `${WEEKDAYS[day]} ${hour}h: ${plural(n, 'baú', 'baús')}`, style: n ? `background:rgba(39,194,255,${(0.15 + 0.85 * n / max).toFixed(2)})` : '' })))));

    const record = (label, value, small) => el('div', {}, el('dt', { text: label }), el('dd', { text: value }, small ? el('small', { text: small }) : null));
    $('records').replaceChildren(
        record('Melhor partida', fmt.format(s.bestMatch), 'baús'),
        record('Melhor dia', s.bestDay ? fmt.format(s.bestDay.chests) : '—', s.bestDay ? s.bestDay.key.split('-').reverse().join('/') : null),
        record('Dias seguidos jogando', fmt.format(s.streak), 'maior sequência'),
        record('Mais tesouros', fmt.format(s.mostTreasures), 'em uma partida'),
        record('Mais baús na tempestade', fmt.format(s.mostInStorm), 'em uma partida'));
}

function drawChart(days) {
    const chart = $('chart');
    const tip = $('tip');
    const dense = days.length > 7;
    const max = Math.max(1, ...days.map(d => d.chests));
    const todayKey = stats.dayKey(new Date());
    $('chartTitle').textContent = `Últimos ${days.length} dias`;
    $('chartDays').value = String(days.length);
    chart.classList.toggle('dense', dense);
    chart.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
    chart.setAttribute('aria-label', `Baús por dia nos últimos ${days.length} dias: ` + days.map(d => `${d.date.getDate()}/${d.date.getMonth() + 1} ${d.chests}`).join(', '));
    chart.replaceChildren(...days.map(d => {
        const isToday = stats.dayKey(d.date) === todayKey;
        // With 30 bars there is no room for a number on each: only the best day keeps its label.
        const label = d.chests && (!dense || d.chests === max) ? fmt.format(d.chests) : '';
        const col = el('div', { class: 'col' + (isToday ? ' today' : ''), tabindex: '0' },
            el('div', { class: 'val', text: label }),
            el('div', { class: 'bar', style: `height:${(d.chests / max) * 82}%` }));
        const show = () => {
            tip.textContent = `${dayLong.format(d.date)}: ${plural(d.chests, 'baú', 'baús')}`;
            tip.hidden = false;
            const box = col.getBoundingClientRect();
            const width = tip.offsetWidth;
            tip.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2)) + 'px';
            tip.style.top = Math.max(8, box.top - 34) + 'px';
        };
        const hide = () => { tip.hidden = true; };
        col.addEventListener('pointerenter', show);
        col.addEventListener('pointerleave', hide);
        col.addEventListener('focus', show);
        col.addEventListener('blur', hide);
        return col;
    }));
    let axis = chart.nextElementSibling;
    if (!axis || !axis.classList.contains('axis')) {
        axis = el('div', { class: 'axis', 'aria-hidden': 'true' });
        chart.after(axis);
    }
    axis.classList.toggle('dense', dense);
    axis.style.gridTemplateColumns = chart.style.gridTemplateColumns;
    axis.replaceChildren(...days.map((d, i) => el('div', {
        class: stats.dayKey(d.date) === todayKey ? 'today' : '',
        text: !dense ? weekday.format(d.date).replace('.', '') : (days.length - 1 - i) % 5 === 0 ? String(d.date.getDate()) : '',
    })));
}

// ---- one match ------------------------------------------------------------------------------------------
function openMatch(m) {
    m = m.original ?? m; // a match cut by the time window: the detail shows all of it
    openKey = store.matchKey(m);
    const date = stats.when(m);
    $('matchTitle').textContent = `${modeName(m.playlist)} · ${dateShort.format(date)}`;

    const fact = (label, value) => el('div', {}, el('dt', { text: label }), el('dd', { text: String(value) }));
    const facts = el('dl', { class: 'facts' },
        fact('Data', dateFull.format(date)),
        fact('Colocação', m.placement == null ? '—' : `${m.placement}º` + (m.totalPlayers ? ` de ${m.totalPlayers}` : '')),
        fact('Eliminações', m.eliminations ?? '—'),
        fact('Duração', m.durationSeconds ? clock(m.durationSeconds) : '—'),
        fact('Baús', fmt.format(m.chestsOpened)),
        fact('Conta', m.playerName || '—'));

    const where = spot => (spot?.inStorm == null ? '—' : (spot.inStorm ? 'Tempestade' : 'Zona segura') + (spot.phase ? ` · fase ${spot.phase}` : ''));
    const chests = el('table');
    table(chests, [{ t: 'Nº', n: true }, { t: 'Momento', n: true }, { t: 'Tipo' }, { t: 'Onde' }, { t: 'Itens', n: true }],
        [...m.chests].sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0)).map((c, i) => [
            String(i + 1), clock(c.timeSeconds), kindName(c.kind) + (c.destroyed ? ' (destruído)' : ''),
            { t: where(c.storm), c: c.storm?.inStorm ? 'inStorm' : '' }, c.items.length ? fmt.format(c.items.length) : '']),
        'Nenhum baú aberto nesta partida.');

    const body = [facts];
    const split = stats.stormOf(m);
    body.push(el('h3', { text: 'Tempestade' }));
    if (split) {
        body.push(el('p', { text: `${fmt.format(split.out)} de ${plural(split.known, 'baú', 'baús')} (${pct(split.out, split.known)}) na zona segura e ${fmt.format(split.in)} (${pct(split.in, split.known)}) dentro da tempestade.` }),
            splitBar('Baús', split.out, split.in));
    } else {
        body.push(el('p', { class: 'muted', text: 'Sem dados de tempestade para esta partida. Adicione o replay de novo, se ainda o tiver.' }));
    }
    const map = matchMap(m);
    if (map) body.push(el('h3', { text: 'Mapa da partida' }), el('p', { class: 'muted', text: 'Os números são a ordem em que os baús foram abertos, a mesma da tabela abaixo.' }), map);
    body.push(el('h3', { text: 'Baús, na ordem' }), el('div', { class: 'scroll' }, chests));

    const others = Object.entries(m.otherInteractions).filter(([, n]) => n > 0);
    if (others.length) body.push(el('p', { class: 'muted', text: 'Outros contêineres: ' + others.map(([kind, n]) => `${kindName(kind)} ${fmt.format(n)}`).join(', ') }));

    if (m.treasureFinds.length) {
        body.push(el('h3', { text: 'Tesouros' }), el('ul', {}, ...m.treasureFinds.map(find =>
            el('li', { text: `${treasureName(find)}` + (find.obtainedAtSeconds != null ? ` às ${clock(find.obtainedAtSeconds)}` : '') + (find.sourceKind ? ` · ${kindName(find.sourceKind)}` : '') + (find.storm?.inStorm != null ? ` · ${find.storm.inStorm ? 'na tempestade' : 'na zona segura'}` : '') }))));
    }

    const teamFinds = (m.nearbyTreasureFinds ?? []).filter(f => f.scope === 'team');
    if (teamFinds.length) {
        body.push(el('h3', { text: 'Tesouros do time' }), el('ul', {}, ...teamFinds.map(find =>
            el('li', { text: `${treasureName(find)}${find.isPirateToken ? ' · TOKEN PIRATA' : ''} · achado por ${find.finder || 'companheiro'}` + (find.obtainedAtSeconds != null ? ` às ${clock(find.obtainedAtSeconds)}` : '') }))));
    }
    if (m.teammates.length) {
        // With the teammate's own replay in the history, their exact count replaces the minimum seen from here.
        body.push(el('h3', { text: 'Equipe' }), el('ul', {}, ...m.teammates.map(mate => {
            const own = stats.teammateRecord(data, m, mate);
            return el('li', { text: own
                ? `${mate.name}: ${plural(own.chestsOpened, 'baú', 'baús')} (exato, do replay dele)`
                : `${mate.name}: ≥ ${plural(mate.chestsSeen, 'baú visto', 'baús vistos')}` });
        })));
    }

    body.push(el('p', { class: 'muted small', text: [m.replayFile, m.gameVersion?.replace('++Fortnite+Release-', 'v'), `analisador ${m.analyzerVersion}`].filter(Boolean).join(' · ') }));
    $('matchBody').replaceChildren(...body);
    if (typeof $('matchDialog').showModal === 'function') $('matchDialog').showModal();
    else $('matchDialog').setAttribute('open', '');
}

function closeMatch() {
    openKey = null;
    if (typeof $('matchDialog').close === 'function') $('matchDialog').close();
    else $('matchDialog').removeAttribute('open');
}

$('matchClose').addEventListener('click', closeMatch);
$('matchDialog').addEventListener('click', event => { if (event.target === $('matchDialog')) closeMatch(); });
$('matchDelete').addEventListener('click', async () => {
    if (!openKey || !data.matches[openKey]) return closeMatch();
    if (!confirm('Excluir esta partida do histórico? Ela não volta a ser contada se o replay for adicionado de novo (só depois de "Apagar tudo").')) return;
    delete data.matches[openKey];
    data.removed[openKey] = true;
    closeMatch();
    await persist();
    setStatus('Partida excluída.');
});

// ---- reading replays ------------------------------------------------------------------------------------
function log(name, text, kind) {
    if (kind === 'err') {
        problems.push(`${name}: ${text}`);
        if (problems.length > 20) problems.shift();
    }
    const list = $('log');
    list.prepend(el('li', {}, el('span', { text: name }), el('span', { class: kind, text })));
    while (list.children.length > 300) list.lastChild.remove();
}

/** The useful part of an error: the runtime repeats itself and appends a long stack. */
function shortError(message) {
    const text = String(message ?? 'falha na leitura');
    const assertion = /\[MONO\][^\n]*/.exec(text)?.[0];
    const first = text.split('\n')[0].replace(/(Error: )?Assert failed: \.NET runtime already exited with \d+ ?/g, '').trim();
    return (assertion ?? first ?? text).slice(0, 220) || 'o analisador parou';
}

/** Same decisions as the desktop tool (Tracker.Process). Returns 'added', 'known' (already counted), 'skipped' or null (nothing to remember). */
function record(file, fileKey, result) {
    if (result.status === 'recording') {
        log(file.name, 'partida ainda em gravação: adicione de novo quando ela terminar', 'skip');
        return null;
    }
    const match = result.status === 'ok' ? store.cleanMatch(result.match) : null;
    if (!match) {
        log(file.name, result.status === 'invalid' ? 'não é um replay do Fortnite' : `erro: ${shortError(result.message)}`, 'err');
        return null; // not remembered: adding the file again tries again
    }
    // Web-only storm analysis: one point per chest and per treasure, in the same order.
    match.stormVersion = result.stormVersion ?? 0;
    if (result.storm) {
        match.storm = { phases: result.storm.phases ?? [], route: result.storm.route ?? [], note: result.storm.note ?? null };
        (result.storm.chests ?? []).forEach((spot, i) => { if (spot && match.chests[i]) match.chests[i].storm = spot; });
        (result.storm.treasures ?? []).forEach((spot, i) => { if (spot && match.treasureFinds[i]) match.treasureFinds[i].storm = spot; });
    }
    const key = store.matchKey(match);
    const existing = data.matches[key];
    if (!match.isBattleRoyale) {
        delete data.matches[key];
        data.files[fileKey] = 'other mode';
        log(file.name, 'não é Battle Royale (criativo / outro modo)', 'skip');
        return 'skipped';
    }
    if (data.removed[key]) {
        data.files[fileKey] = 'removed';
        log(file.name, 'partida excluída por você: não é contada de novo', 'skip');
        return 'skipped';
    }
    if (existing && existing.match.analyzerVersion >= match.analyzerVersion && (existing.match.stormVersion ?? 0) >= match.stormVersion) {
        data.files[fileKey] = key;
        log(file.name, 'partida já contada', 'skip');
        return 'known';
    }
    if (existing) match.analyzedAtUtc = existing.match.analyzedAtUtc;
    data.matches[key] = { supported: !!result.supportedVersion && result.countedPlaylist !== false, match };
    data.files[fileKey] = key;
    data.settings.profile ??= stats.profileKey(match);
    if (existing?.match.storm && !match.storm && existing.match.analyzerVersion === match.analyzerVersion) {
        // Read again without the storm: keep what an earlier read found.
        match.storm = existing.match.storm;
        match.stormVersion = existing.match.stormVersion;
        match.chests.forEach((c, i) => { c.storm = existing.match.chests[i]?.storm; });
        match.treasureFinds.forEach((f, i) => { f.storm = existing.match.treasureFinds[i]?.storm; });
    }
    const text = plural(match.chestsOpened, 'baú', 'baús') + (match.treasureFinds.length ? `, ${plural(match.treasureFinds.length, 'tesouro', 'tesouros')}` : '');
    const took = file.seconds != null ? ` · ${fmt1.format(file.seconds)} s` : '';
    if (result.supportedVersion) log(file.name, text + took, 'ok');
    else if (result.countedPlaylist === false) log(file.name, `${text}${took} · modo fora da contagem (não é Battle Royale padrão)`, 'skip');
    else log(file.name, `${text}${took} · versão anterior à v43 (fora das estatísticas)`, 'skip');
    return existing ? 'updated' : 'added';
}

/** A match that has chests but not the storm data of the analyzer now loaded. */
function needsStorm(match) {
    return !!match && !!engine && match.isBattleRoyale !== false && (match.chests?.length ?? 0) + (match.treasureFinds?.length ?? 0) > 0
        && (match.stormVersion ?? 0) < engine.stormVersion;
}
/** Read by an older analyzer, or (when the storm is read) without the storm data of this version. */
function needsUpdate(match, withStorm = data.settings.readStorm) {
    return !!match && !!engine && ((match.analyzerVersion ?? 0) < engine.analyzerVersion || (withStorm && needsStorm(match)));
}

let upgradeNext = false;
function drawUpgrade() {
    const entries = engine ? Object.values(data.matches) : [];
    const older = entries.filter(e => (e.match.analyzerVersion ?? 0) < engine.analyzerVersion).length;
    const noStorm = data.settings.readStorm ? entries.filter(e => (e.match.analyzerVersion ?? 0) >= (engine?.analyzerVersion ?? 0) && needsStorm(e.match)).length : 0;
    const missing = older + noStorm;
    $('upgradeBox').hidden = $('upgradeText').hidden = missing === 0;
    const parts = [];
    if (older) parts.push(`${plural(older, 'partida foi lida', 'partidas foram lidas')} por uma versão anterior do analisador (a nova reconhece o token pirata e os tesouros do time)`);
    if (noStorm) parts.push(`${plural(noStorm, 'partida não tem', 'partidas não têm')} os dados de tempestade, mapa e rota`);
    $('upgradeText').textContent = missing
        ? `${parts.join('; ')}. Para atualizá-las, use o botão acima e escolha a pasta (ou os arquivos) de novo: só elas são relidas, e você pode parar a qualquer momento.`
        : '';
}

/** A plain .replay file, as something addFiles can read later. */
const fromFile = file => ({ name: file.name, lastModified: file.lastModified, key: `${file.name}|${file.size}|${file.lastModified}`, getFile: async () => file });

/** upgrade: also read again the replays already counted whose match lacks the storm data of this version. */
async function addFiles(files, { upgrade = false } = {}) {
    const replays = files.filter(f => /\.replay$/i.test(f.name));
    const zips = files.filter(f => /\.zip$/i.test(f.name));
    if (replays.length + zips.length === 0) {
        setStatus(files.length ? 'Nenhum arquivo .replay ou .zip entre os selecionados.' : 'Nenhum arquivo selecionado.');
        return;
    }
    if (busy || !engine) return;
    busy = true;
    stopRequested = false;
    setButtons();
    $('stopImport').hidden = false;
    $('progress').hidden = false;
    $('progressBar').style.width = '0';
    let added = 0, known = 0, updated = 0, unsaved = 0, lastSave = Date.now();
    // The whole history is one record: on a large import it is written every few files, not after each one.
    const flush = async force => {
        if (unsaved === 0 || (!force && unsaved < 15 && Date.now() - lastSave < 4000)) return;
        unsaved = 0;
        lastSave = Date.now();
        if (!(await store.save(data))) persistent = false;
    };
    try {
        // Asked here because it needs a user action; it keeps the browser from clearing the history by itself.
        store.protect().then(state => { protectedStorage = state; drawNotices(); });

        // Replays inside a zip are unpacked one at a time, only when their turn comes.
        const sources = replays.map(fromFile);
        for (const zip of zips) {
            setStatus(`Abrindo ${zip.name}…`);
            try {
                const inside = await listReplays(zip);
                if (inside.length === 0) log(zip.name, 'nenhum .replay dentro do zip', 'skip');
                sources.push(...inside);
            } catch (error) {
                log(zip.name, `erro: ${error.message}`, 'err');
            }
        }

        // A newer analyzer reads every replay again (records are replaced, never duplicated).
        // A newer count reads everything again. A newer storm analysis does not: the old matches are only
        // completed when asked ("Completar partidas antigas"), since reading a whole folder again takes long.
        // Neither a newer analyzer nor a newer storm analysis reads everything again by itself (a whole folder
        // takes long): "Completar partidas antigas" reads again only the matches that need it.
        data.analyzerVersion = engine.analyzerVersion;
        data.stormVersion = engine.stormVersion;
        const withStorm = data.settings.readStorm;
        let stopped = false;
        sources.sort((a, b) => a.lastModified - b.lastModified);
        for (let i = 0; i < sources.length; i++) {
            if (stopRequested) {
                stopped = true;
                break;
            }
            const source = sources[i];
            const seen = data.files[source.key];
            if (seen && !(upgrade && needsUpdate(data.matches[seen]?.match, withStorm))) {
                known++;
                continue;
            }
            const average = readTimes.length ? readTimes.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, readTimes.length) : null;
            setStatus(`Lendo ${i + 1} de ${sources.length}: ${source.name}` + (average ? ` (cerca de ${fmt1.format(average)} s cada)` : ''));
            $('progressBar').style.width = `${(100 * i) / sources.length}%`;
            // Let the text and the bar paint before the analyzer holds the page.
            await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
            const began = performance.now();
            let result = await analyzeOnce(source, withStorm);
            // The runtime stopped for good: start a fresh analyzer and try this replay once more.
            if (result.status === 'error' && isFatal(result.message) && engine.restart) {
                setStatus(`O analisador parou ao ler ${source.name}. Reiniciando…`);
                try {
                    await engine.restart();
                    result = await analyzeOnce(source, withStorm);
                    if (result.status === 'error' && isFatal(result.message)) {
                        // The same replay stops it twice: leave it out and go on with a fresh analyzer.
                        result = { status: 'error', message: 'este replay faz o analisador parar; ele foi pulado' };
                        await engine.restart().catch(() => {});
                    }
                } catch (error) {
                    result = { status: 'error', message: `não foi possível reiniciar o analisador (${error.message})` };
                }
            }
            const seconds = (performance.now() - began) / 1000;
            readTimes.push(seconds);
            if (readTimes.length > 200) readTimes.shift();
            console.info(`[Chest Lookout] ${source.name}: ${fmt1.format(seconds)} s` + (withStorm ? ' (com tempestade)' : ''));
            source.seconds = seconds;
            const outcome = record(source, source.key, result);
            if (outcome) {
                added += outcome === 'added' ? 1 : 0;
                known += outcome === 'known' ? 1 : 0;
                updated += outcome === 'updated' ? 1 : 0;
                unsaved++;
                await flush(false);
                render();
            }
        }
        $('progressBar').style.width = stopped ? $('progressBar').style.width : '100%';
        setStatus((stopped ? 'Leitura parada: ' : 'Pronto: ') + plural(added, 'partida nova', 'partidas novas') + (updated ? `, ${plural(updated, 'partida completada', 'partidas completadas')}` : '') + (known ? `, ${fmt.format(known)} já contada(s) antes` : '') + '.'
            + (stopped ? ' O que já foi lido está salvo; adicione os arquivos de novo para continuar.' : ''));
    } finally {
        await flush(true);
        busy = false;
        $('stopImport').hidden = true;
        setButtons();
        render();
        setTimeout(() => { if (!busy) $('progress').hidden = true; }, 1200);
    }
}

async function analyzeOnce(source, withStorm) {
    try {
        return await engine.analyze(await source.getFile(), withStorm);
    } catch (error) {
        return { status: 'error', message: String(error?.message ?? error) };
    }
}

async function filesFromDrop(transfer) {
    const entries = [...(transfer.items ?? [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length === 0) return [...transfer.files];
    const files = [];
    const walk = async entry => {
        if (entry.isFile) {
            files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            for (;;) {
                const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (batch.length === 0) break;
                for (const child of batch) await walk(child);
            }
        }
    };
    for (const entry of entries) await walk(entry);
    return files;
}

// ---- remembered folder (File System Access API: Chrome and Edge) ---------------------------------------
const canRemember = typeof window.showDirectoryPicker === 'function';
let folder = null;

function renderFolder() {
    $('rememberBox').hidden = !canRemember;
    $('refresh').hidden = $('forgetFolder').hidden = !folder;
    $('refresh').textContent = folder ? `Atualizar "${folder.name}"` : 'Atualizar';
    $('rememberFolder').textContent = folder ? 'Trocar de pasta…' : 'Lembrar uma pasta…';
    $('rememberFolder').classList.toggle('primary', !folder);
}

async function replaysIn(directory, depth = 0) {
    const files = [];
    for await (const entry of directory.values()) {
        if (entry.kind === 'file') {
            if (/\.(replay|zip)$/i.test(entry.name)) files.push(await entry.getFile());
        } else if (depth < 3) {
            files.push(...await replaysIn(entry, depth + 1));
        }
    }
    return files;
}

async function readFolder() {
    if (!folder || busy) return;
    try {
        // After a restart the browser asks again before letting the page read the folder.
        if (folder.queryPermission && (await folder.queryPermission({ mode: 'read' })) !== 'granted'
            && (await folder.requestPermission({ mode: 'read' })) !== 'granted') {
            setStatus('Sem permissão para ler a pasta. Clique em Atualizar de novo e permita o acesso.', true);
            return;
        }
        setStatus(`Procurando replays em "${folder.name}"…`);
        const files = await replaysIn(folder);
        if (files.length === 0) setStatus(`Nenhum arquivo .replay em "${folder.name}".`);
        else await addFiles(files);
    } catch (error) {
        setStatus(error.name === 'NotFoundError'
            ? 'A pasta lembrada não existe mais. Escolha outra.'
            : `Não foi possível ler a pasta (${error.message}).`, true);
    }
}

$('rememberFolder').addEventListener('click', async () => {
    let picked;
    try {
        picked = await window.showDirectoryPicker({ id: 'replays', mode: 'read' });
    } catch (error) {
        // Cancelled, or a folder the browser refuses (it explains that itself, e.g. anything inside AppData).
        if (error.name !== 'AbortError') setStatus(`Não foi possível abrir a pasta (${error.message}). Use "Escolher pasta".`, true);
        return;
    }
    folder = picked;
    const kept = await store.saveFolder(folder);
    renderFolder();
    if (!kept) setStatus('A pasta vale até você fechar a página: este navegador não conseguiu guardá-la.');
    await readFolder();
});
$('refresh').addEventListener('click', readFolder);
$('forgetFolder').addEventListener('click', async () => {
    folder = null;
    renderFolder();
    setStatus('Pasta esquecida.');
    await store.saveFolder(null);
});

async function copyText(text, selectFrom) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        if (!selectFrom) return false;
        // No clipboard permission: select the text so Ctrl+C works.
        const range = document.createRange();
        range.selectNodeContents(selectFrom);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        try { return document.execCommand('copy'); } catch { return false; }
    }
}

$('copyPath').addEventListener('click', async () => {
    const copied = await copyText($('demosPath').textContent, $('demosPath'));
    $('copyPath').textContent = copied ? 'Copiado!' : 'Selecionado: Ctrl+C';
    setTimeout(() => { $('copyPath').textContent = 'Copiar caminho'; }, 2000);
});

// ---- summary picture ------------------------------------------------------------------------------------
async function summaryBlob() {
    const s = stats.build(data, filter);
    if (!s.matches) return null;
    await loadFonts();
    const canvas = drawSummary({
        format: $('imageFormat').value,
        totalText: fmt.format(s.total),
        name: $('imageName').checked ? s.profile?.name : null,
        period: s.filtered ? filterText() : null,
        since: s.filtered || !s.since
            ? plural(s.matches, 'partida', 'partidas')
            : `${plural(s.matches, 'partida', 'partidas')} desde ${dateDay.format(s.since)}`,
        tiles: [
            { label: 'Média por partida', value: fmt1.format(s.average) },
            { label: 'Melhor partida', value: fmt.format(s.bestMatch) },
            { label: 'Melhor dia', value: s.bestDay ? fmt.format(s.bestDay.chests) : '—' },
            { label: 'Tesouros', value: fmt.format(s.treasures.length) },
            { label: 'Vitórias', value: fmt.format(s.wins) },
            { label: 'Top 10', value: fmt.format(s.top10) },
        ],
        days: s.lastDays.map(d => ({ chests: d.chests, valueText: fmt.format(d.chests), label: weekday.format(d.date).replace('.', '') })),
        generated: `${dateDay.format(new Date())} · Chest Lookout · ferramenta não oficial`,
    });
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
const summaryName = () => `chestlookout-resumo-${stats.dayKey(new Date())}.png`;

// The picture is shown first; it is saved (or shared) from the preview.
let preview = null;   // { blob, url } of the picture on screen
let previewTurn = 0;  // the latest request wins when the options change quickly

async function refreshPreview() {
    const turn = ++previewTurn;
    $('imageBusy').hidden = false;
    $('saveImage').disabled = $('shareImage').disabled = true;
    const blob = await summaryBlob();
    if (turn !== previewTurn) return;
    if (preview) URL.revokeObjectURL(preview.url);
    preview = blob ? { blob, url: URL.createObjectURL(blob) } : null;
    $('imagePreview').src = preview?.url ?? '';
    $('imagePreview').dataset.format = $('imageFormat').value;
    $('imageBusy').hidden = true;
    $('saveImage').disabled = $('shareImage').disabled = !preview;
    if (!preview) $('imageBusy').textContent = 'Não foi possível gerar a imagem.';
}

$('openImage').addEventListener('click', () => {
    $('imagePreview').removeAttribute('src');
    $('imageBusy').textContent = 'Gerando a imagem…';
    if (typeof $('imageDialog').showModal === 'function') $('imageDialog').showModal();
    else $('imageDialog').setAttribute('open', '');
    refreshPreview();
});
for (const id of ['imageFormat', 'imageName']) $(id).addEventListener('change', refreshPreview);

function closeImage() {
    previewTurn++;
    if (preview) URL.revokeObjectURL(preview.url);
    preview = null;
    $('imagePreview').removeAttribute('src');
    if (typeof $('imageDialog').close === 'function') $('imageDialog').close();
    else $('imageDialog').removeAttribute('open');
}
$('imageClose').addEventListener('click', closeImage);
$('imageDialog').addEventListener('click', event => { if (event.target === $('imageDialog')) closeImage(); });
$('imageDialog').addEventListener('close', () => { if (preview) closeImage(); });

$('saveImage').addEventListener('click', () => {
    if (preview) download(preview.blob, summaryName());
});
$('shareImage').addEventListener('click', async () => {
    if (!preview) return;
    try {
        await navigator.share({ files: [new File([preview.blob], summaryName(), { type: 'image/png' })], title: 'Chest Lookout' });
    } catch (error) {
        if (error.name !== 'AbortError') download(preview.blob, summaryName());
    }
});
try {
    $('shareImage').hidden = !navigator.canShare?.({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] });
} catch {
    $('shareImage').hidden = true;
}

// ---- wiring ---------------------------------------------------------------------------------------------
function setStatus(text, error = false) {
    $('engineStatus').textContent = text;
    $('engineStatus').classList.toggle('error', error);
    if (error) {
        problems.push(text);
        if (problems.length > 20) problems.shift();
    }
}
function setButtons() {
    for (const id of ['pickFiles', 'pickFolder', 'upgrade', 'refresh', 'rememberFolder', 'import', 'reset']) $(id).disabled = busy || (!engine && !['import', 'reset'].includes(id));
}
async function persist() {
    render();
    if (!(await store.save(data))) persistent = false;
    drawNotices();
}

$('pickFiles').addEventListener('click', () => { upgradeNext = false; $('fileInput').click(); });
$('upgrade').addEventListener('click', () => { upgradeNext = true; $('folderInput').click(); });
$('stopImport').addEventListener('click', () => {
    stopRequested = true;
    $('stopImport').hidden = true;
    setStatus('Parando depois do replay que está sendo lido…');
});
$('pickFolder').addEventListener('click', () => { upgradeNext = false; $('folderInput').click(); });
for (const id of ['fileInput', 'folderInput']) {
    $(id).addEventListener('change', event => {
        const files = [...event.target.files];
        event.target.value = '';
        const upgrade = upgradeNext;
        upgradeNext = false;
        addFiles(files, { upgrade });
    });
}
const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('over'); });
}
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async event => {
    event.preventDefault();
    drop.classList.remove('over');
    addFiles(await filesFromDrop(event.dataTransfer));
});
// A file dropped beside the box must not make the browser navigate to it.
for (const type of ['dragover', 'drop']) window.addEventListener(type, event => event.preventDefault());

for (const box of document.querySelectorAll('[data-setting]')) {
    box.addEventListener('change', () => { data.settings[box.dataset.setting] = box.checked; persist(); });
}
$('profile').addEventListener('change', event => { data.settings.profile = event.target.value; resetLists(); persist(); });
$('period').addEventListener('change', event => {
    filter.period = event.target.value;
    if (filter.period === 'custom') {
        // The last window chosen, or today from midnight until the next full hour.
        const saved = data.settings.range;
        const now = new Date();
        $('rangeFrom').value = saved?.from ?? localInput(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        $('rangeTo').value = saved?.to ?? localInput(new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1));
        applyRange();
        return;
    }
    filter.range = null;
    resetLists();
    render();
});
for (const id of ['rangeFrom', 'rangeTo']) $(id).addEventListener('change', applyRange);
$('size').addEventListener('change', event => { filter.size = event.target.value; resetLists(); render(); });
for (const name of Object.keys(LIST)) {
    $(`more-${name}`).addEventListener('click', () => { shownRows[name] += LIST[name][1]; render(); });
    $(`less-${name}`).addEventListener('click', () => { shownRows[name] = LIST[name][0]; render(); });
}
for (const button of document.querySelectorAll('[data-tab-button]')) {
    button.addEventListener('click', () => { tab = button.dataset.tabButton; drawTabs(); if (tab === 'tesouro') tickCountdowns(); });
}
$('chartDays').addEventListener('change', event => { chartDays = Number(event.target.value) === 30 ? 30 : 7; render(); });
$('initial').addEventListener('change', event => {
    const key = stats.currentProfile(data)?.key ?? '';
    data.settings.initialChests[key] = Math.max(0, Math.floor(Number(event.target.value) || 0));
    persist();
});

/** anonymous: the copy leaves without the teammates' Epic ids (their names stay). */
function exportHistory(name, anonymous = false) {
    data.backup = { at: new Date().toISOString(), matches: Object.keys(data.matches).length };
    let copy = data;
    if (anonymous) {
        copy = JSON.parse(JSON.stringify(data));
        for (const entry of Object.values(copy.matches)) {
            for (const mate of entry.match.teammates ?? []) mate.epicId = null;
        }
    }
    download(new Blob([JSON.stringify(copy, null, 1)], { type: 'application/json' }), name ?? `chestlookout-historico-${stats.dayKey(new Date())}.json`);
}
for (const id of ['export', 'backupNow']) {
    $(id).addEventListener('click', () => { exportHistory(undefined, id === 'export' && data.settings.anonymousExport); persist(); });
}
$('import').addEventListener('click', () => $('importInput').click());
$('importInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        const incoming = store.normalize(JSON.parse(await file.text()));
        const count = Object.keys(incoming.matches).length;
        if (count === 0) {
            setStatus('Esse arquivo não tem nenhuma partida do Chest Lookout.', true);
            return;
        }
        if (!confirm(`Importar ${plural(count, 'partida', 'partidas')}? Elas serão juntadas ao histórico atual.`)) return;
        let merged = 0;
        for (const [key, entry] of Object.entries(incoming.matches)) {
            const mine = data.matches[key];
            if (data.removed[key] || (mine && mine.match.analyzerVersion >= entry.match.analyzerVersion)) continue;
            data.matches[key] = entry;
            merged++;
        }
        Object.assign(data.files, incoming.files);
        Object.assign(data.removed, incoming.removed);
        data.settings.initialChests = { ...incoming.settings.initialChests, ...data.settings.initialChests };
        await persist();
        setStatus(`Histórico importado: ${plural(merged, 'partida nova', 'partidas novas')} de ${fmt.format(count)}.`);
    } catch (error) {
        setStatus(`Não foi possível importar: ${error.message}`, true);
    }
});
$('reset').addEventListener('click', async () => {
    const count = Object.keys(data.matches).length;
    if (!confirm('Apagar todo o histórico e os ajustes deste navegador?' + (count ? ' Um backup será baixado antes.' : ''))) return;
    if (count) exportHistory(`chestlookout-backup-${stats.dayKey(new Date())}.json`);
    data = store.emptyData();
    resetLists();
    filter.period = 'all';
    filter.size = '';
    filter.range = null;
    $('log').replaceChildren();
    await persist();
    setStatus(count ? 'Histórico apagado. O backup foi baixado.' : 'Histórico apagado.');
});

$('copyDiag').addEventListener('click', async () => {
    const entries = Object.values(data.matches);
    const lines = [
        `Chest Lookout ${APP_VERSION}`,
        `analisador: ${engine ? `${engine.analyzerVersion} (${engine.mode}${engine.restarts ? `, reiniciado ${engine.restarts}×` : ''})` : 'não carregado'}` + (startup.ms != null ? `, ${startup.ms} ms` : '') + (startup.fallback ? ', plano B' : '') + (engine?.nativeBytes ? `, runtime ${Math.round(engine.nativeBytes / 1048576)} MB (${engine.nativeBytes > 8 * 1048576 ? 'AOT' : 'sem AOT, leitura mais lenta'})` : ''),
        `leitura: ${data.settings.readStorm ? 'com tempestade' : 'só contagem'}` + (readTimes.length
            ? `, ${readTimes.length} replays nesta visita, média ${fmt1.format(readTimes.reduce((a, b) => a + b, 0) / readTimes.length)} s, maior ${fmt1.format(Math.max(...readTimes))} s` : ', nenhum replay lido nesta visita'),
        `memória da página: ${performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB usados de ${Math.round(performance.memory.jsHeapSizeLimit / 1048576)} MB` : 'indisponível'}`,
        `navegador: ${navigator.userAgent}`,
        `histórico: ${entries.length} partidas (${entries.filter(e => !e.supported).length} anteriores à v43), ${Object.keys(data.files).length} arquivos lidos, ${Object.keys(data.removed).length} excluídas`,
        `versões do jogo: ${[...new Set(entries.map(e => e.match.gameVersion).filter(Boolean))].slice(-5).join(', ') || '—'}`,
        `armazenamento: ${persistent ? 'ok' : 'indisponível'}, protegido: ${protectedStorage}`,
        `últimos erros (${problems.length}):`,
        ...problems.map(p => `  - ${p}`),
    ];
    const copied = await copyText(lines.join('\n'));
    $('copyDiag').textContent = copied ? 'Copiado!' : 'Não foi possível copiar';
    setTimeout(() => { $('copyDiag').textContent = 'Copiar diagnóstico'; }, 2000);
});
window.addEventListener('error', event => { problems.push(`erro: ${event.message}`); });
window.addEventListener('unhandledrejection', event => { problems.push(`erro: ${event.reason?.message ?? event.reason}`); });

// Keeps the analyzer in the browser between visits (see sw.js). Not in local tests ("dev").
if ('serviceWorker' in navigator && APP_VERSION !== 'dev') {
    navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`).catch(error => console.warn('[Chest Lookout] sem cache do analisador:', error));
}

(async () => {
    setButtons();
    const loaded = await store.load();
    data = loaded.data;
    persistent = loaded.persistent;
    try {
        // Not protected yet and already holding matches: say so (protection is asked for when files are added).
        const safe = await navigator.storage?.persisted?.();
        protectedStorage = safe ? true : safe === false && Object.keys(data.matches).length > 0 ? false : null;
    } catch { /* unknown */ }
    render();
    if (canRemember) folder = await store.loadFolder();
    renderFolder();

    // First visit: the analyzer (several megabytes) is downloaded, then started. The buttons wait for it.
    const bar = $('progressBar');
    let lastMove = Date.now();
    $('progress').hidden = false;
    bar.style.width = '2%';
    setStatus('Carregando o analisador… os botões são liberados quando terminar.');
    let files = null; // { done, total } of the download, to say where a slow start is stuck
    const slow = setInterval(() => {
        if (Date.now() - lastMove <= 45000) return;
        const seconds = Math.round((Date.now() - startup.began) / 1000);
        const where = !files ? 'ainda sem resposta'
            : files.done < files.total ? `baixando, ${files.done} de ${files.total} arquivos (o último costuma ser o maior)`
            : 'arquivos baixados, iniciando';
        setStatus(`Carregando o analisador… ${seconds} s: ${where}. Na primeira visita depois de uma atualização pode levar alguns minutos; se passar de 5, recarregue com Ctrl+F5.`);
    }, 5000);
    try {
        engine = await createEngine((done, total) => {
            lastMove = Date.now();
            files = { done, total };
            if (!(total > 0)) return;
            // The last stretch of the bar is kept for starting the runtime once everything is downloaded.
            bar.style.width = `${Math.max(2, Math.min(90, (90 * done) / total))}%`;
            setStatus(done < total
                ? `Baixando o analisador… ${done} de ${total} arquivos. Os botões são liberados quando terminar.`
                : 'Iniciando o analisador…');
        }, () => {
            startup.fallback = true;
            lastMove = Date.now();
            bar.style.width = '2%';
            setStatus('Carregando o analisador de outro modo… os botões são liberados quando terminar.');
        });
        startup.ms = Date.now() - startup.began;
        console.info(`[Chest Lookout] analisador pronto em ${startup.ms} ms (${engine.mode})`);
        bar.style.width = '100%';
        setStatus('Pronto para ler replays.');
        setTimeout(() => { if (!busy) $('progress').hidden = true; }, 800);
    } catch (error) {
        $('progress').hidden = true;
        console.error(error);
        setStatus(`Não foi possível carregar o analisador (${error.message}). Recarregue a página; se continuar, use um navegador atualizado (Chrome, Edge ou Firefox).`, true);
    } finally {
        clearInterval(slow);
    }
    setButtons();
    drawNotices();
})();
