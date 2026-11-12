import { createEngine } from './engine.js';
import * as store from './store.js';
import * as stats from './stats.js';
import { listReplays } from './zip.js';
import { drawSummary, loadFonts } from './summary-image.js';

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
const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;

const PAGE = 100;
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || 'dev';

let data = store.emptyData();
let engine = null;
let busy = false;
let persistent = true;   // false: the browser keeps nothing (private window…)
let protectedStorage = null;
let shown = PAGE;
let openKey = null;      // match shown in the dialog
const filter = { period: 'all', size: '' };
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
    $('filterNote').textContent = s.filtered ? `${plural(s.matches, 'partida', 'partidas')} de ${fmt.format(s.available)}` : '';

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
        tile('Vitórias', fmt.format(s.wins), share(s.wins)),
        tile('Top 10', fmt.format(s.top10), share(s.top10)),
        settings.showTeammates ? tile('Baús dos companheiros', '≥ ' + fmt.format(s.teamChests)) : null,
    );

    drawChart(s.lastDays);

    const chestTotal = s.byKind.reduce((sum, [, n]) => sum + n, 0);
    table($('kinds'), [{ t: 'Tipo' }, { t: 'Baús', n: true }, { t: '%', n: true }],
        s.byKind.map(([kind, n]) => [kindName(kind), fmt.format(n), fmt1.format(100 * n / chestTotal)]), 'Nenhum baú aberto.');
    const counted = new Set(stats.extraKinds(settings));
    table($('others'), [{ t: 'Tipo' }, { t: 'Abertos', n: true }, { t: 'No total?' }],
        s.others.map(([kind, n]) => [kindName(kind), fmt.format(n), counted.has(kind) ? 'Sim' : 'Não']), 'Nenhum outro contêiner.');

    table($('treasures'), [{ t: 'Tesouro' }, { t: 'Partida' }, { t: 'Momento', n: true }, { t: 'Origem' }],
        s.treasures.map(({ find, date }) => [
            { t: (find.fromGoldenChest ? '★★ ' : '★ ') + treasureName(find), c: 'wrap' },
            dateShort.format(date), clock(find.obtainedAtSeconds),
            kindName(find.sourceKind) + (find.sourceDestroyed ? ' (destruído)' : '') + (find.sourceIsChest === false ? ' ⚑' : ''),
        ]), 'Nenhum tesouro encontrado nas partidas mostradas.');

    $('matesCard').hidden = !settings.showTeammates;
    if (settings.showTeammates) {
        table($('mates'), [{ t: 'Companheiro' }, { t: 'Partidas juntos', n: true }, { t: 'Vitórias juntos', n: true }, { t: 'Baús vistos', n: true }, { t: 'Média', n: true }, { t: 'Recorde', n: true }],
            s.mates.map(m => [m.name || 'Companheiro', fmt.format(m.matches), fmt.format(m.wins), '≥ ' + fmt.format(m.seen), fmt1.format(m.seen / m.matches), fmt.format(m.best)]),
            'Nenhuma partida em equipe.');
    }

    const visible = s.rows.slice(0, shown);
    $('matchesNote').textContent = s.rows.length > visible.length ? `(${fmt.format(visible.length)} de ${fmt.format(s.rows.length)})` : `(${fmt.format(s.rows.length)})`;
    $('moreMatches').hidden = s.rows.length <= visible.length;
    const head = [{ t: 'Data' }, { t: 'Modo' }, { t: 'Colocação', n: true }, { t: 'Elim.', n: true }, { t: 'Baús', n: true }, { t: 'Tesouros', n: true }];
    if (settings.showTeammates) head.push({ t: 'Equipe' });
    table($('matches'), head, visible.map(({ m, date, total, own }) => {
        const row = [dateShort.format(date), modeName(m.playlist), placeCell(m), m.eliminations ?? '—',
            fmt.format(total) + (total !== own ? ` (${fmt.format(own)} meus)` : ''), m.treasureFinds?.length ? fmt.format(m.treasureFinds.length) : ''];
        if (settings.showTeammates) {
            row.push({ t: (m.teammates ?? []).map(t => `${t.name} ≥${stats.mateSeen(t, stats.extraKinds(settings))}`).join(', ') || '—', c: 'wrap' });
        }
        return row;
    }), 'Nenhuma partida neste filtro.', index => openMatch(visible[index].m));
}

function filterText() {
    return [PERIOD_NAMES[filter.period], SIZE_NAMES[filter.size]].filter(Boolean).join(' · ');
}

function drawNotices() {
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
    $('appVersion').textContent = `Versão ${APP_VERSION}` + (engine ? ` · analisador ${engine.analyzerVersion}` : '');
}

function drawChart(days) {
    const chart = $('chart');
    const tip = $('tip');
    const max = Math.max(1, ...days.map(d => d.chests));
    const todayKey = stats.dayKey(new Date());
    chart.setAttribute('aria-label', 'Baús por dia nos últimos 7 dias: ' + days.map(d => `${weekday.format(d.date)} ${d.chests}`).join(', '));
    chart.replaceChildren(...days.map(d => {
        const isToday = stats.dayKey(d.date) === todayKey;
        const col = el('div', { class: 'col' + (isToday ? ' today' : ''), tabindex: '0' },
            el('div', { class: 'val', text: d.chests ? fmt.format(d.chests) : '' }),
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
    axis.replaceChildren(...days.map(d => el('div', { class: stats.dayKey(d.date) === todayKey ? 'today' : '', text: weekday.format(d.date).replace('.', '') })));
}

// ---- one match ------------------------------------------------------------------------------------------
function openMatch(m) {
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

    const chests = el('table');
    table(chests, [{ t: 'Momento', n: true }, { t: 'Tipo' }, { t: 'Itens', n: true }],
        [...m.chests].sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0)).map(c => [
            clock(c.timeSeconds), kindName(c.kind) + (c.destroyed ? ' (destruído)' : ''), c.items.length ? fmt.format(c.items.length) : '']),
        'Nenhum baú aberto nesta partida.');

    const body = [facts, el('h3', { text: 'Baús, na ordem' }), el('div', { class: 'scroll' }, chests)];

    const others = Object.entries(m.otherInteractions).filter(([, n]) => n > 0);
    if (others.length) body.push(el('p', { class: 'muted', text: 'Outros contêineres: ' + others.map(([kind, n]) => `${kindName(kind)} ${fmt.format(n)}`).join(', ') }));

    if (m.treasureFinds.length) {
        body.push(el('h3', { text: 'Tesouros' }), el('ul', {}, ...m.treasureFinds.map(find =>
            el('li', { text: `${treasureName(find)}` + (find.obtainedAtSeconds != null ? ` às ${clock(find.obtainedAtSeconds)}` : '') + (find.sourceKind ? ` · ${kindName(find.sourceKind)}` : '') }))));
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

/** Same decisions as the desktop tool (Tracker.Process). Returns 'added', 'known' (already counted), 'skipped' or null (nothing to remember). */
function record(file, fileKey, result) {
    if (result.status === 'recording') {
        log(file.name, 'partida ainda em gravação: adicione de novo quando ela terminar', 'skip');
        return null;
    }
    const match = result.status === 'ok' ? store.cleanMatch(result.match) : null;
    if (!match) {
        log(file.name, result.status === 'invalid' ? 'não é um replay do Fortnite' : `erro: ${result.message ?? 'falha na leitura'}`, 'err');
        return null; // not remembered: adding the file again tries again
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
    if (existing && existing.match.analyzerVersion >= match.analyzerVersion) {
        data.files[fileKey] = key;
        log(file.name, 'partida já contada', 'skip');
        return 'known';
    }
    if (existing) match.analyzedAtUtc = existing.match.analyzedAtUtc;
    data.matches[key] = { supported: !!result.supportedVersion, match };
    data.files[fileKey] = key;
    data.settings.profile ??= stats.profileKey(match);
    const text = plural(match.chestsOpened, 'baú', 'baús') + (match.treasureFinds.length ? `, ${plural(match.treasureFinds.length, 'tesouro', 'tesouros')}` : '');
    if (result.supportedVersion) log(file.name, text, 'ok');
    else log(file.name, `${text} · versão anterior à v43 (fora das estatísticas)`, 'skip');
    return existing ? 'known' : 'added';
}

/** A plain .replay file, as something addFiles can read later. */
const fromFile = file => ({ name: file.name, lastModified: file.lastModified, key: `${file.name}|${file.size}|${file.lastModified}`, getFile: async () => file });

async function addFiles(files) {
    const replays = files.filter(f => /\.replay$/i.test(f.name));
    const zips = files.filter(f => /\.zip$/i.test(f.name));
    if (replays.length + zips.length === 0) {
        setStatus(files.length ? 'Nenhum arquivo .replay ou .zip entre os selecionados.' : 'Nenhum arquivo selecionado.');
        return;
    }
    if (busy || !engine) return;
    busy = true;
    setButtons();
    $('progress').hidden = false;
    $('progressBar').style.width = '0';
    let added = 0, known = 0, unsaved = 0, lastSave = Date.now();
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
        if (data.analyzerVersion !== engine.analyzerVersion) {
            data.files = {};
            data.analyzerVersion = engine.analyzerVersion;
        }
        sources.sort((a, b) => a.lastModified - b.lastModified);
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            setStatus(`Lendo ${i + 1} de ${sources.length}: ${source.name}`);
            $('progressBar').style.width = `${(100 * i) / sources.length}%`;
            if (data.files[source.key]) {
                known++;
                continue;
            }
            let result;
            try {
                result = await engine.analyze(await source.getFile());
            } catch (error) {
                result = { status: 'error', message: String(error?.message ?? error) };
            }
            const outcome = record(source, source.key, result);
            if (outcome) {
                added += outcome === 'added' ? 1 : 0;
                known += outcome === 'known' ? 1 : 0;
                unsaved++;
                await flush(false);
                render();
            }
        }
        $('progressBar').style.width = '100%';
        setStatus(`Pronto: ${plural(added, 'partida nova', 'partidas novas')}` + (known ? `, ${fmt.format(known)} já contada(s) antes` : '') + '.');
    } finally {
        await flush(true);
        busy = false;
        setButtons();
        render();
        setTimeout(() => { if (!busy) $('progress').hidden = true; }, 1200);
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
    for (const id of ['pickFiles', 'pickFolder', 'refresh', 'rememberFolder', 'import', 'reset']) $(id).disabled = busy || (!engine && !['import', 'reset'].includes(id));
}
async function persist() {
    render();
    if (!(await store.save(data))) persistent = false;
    drawNotices();
}

$('pickFiles').addEventListener('click', () => $('fileInput').click());
$('pickFolder').addEventListener('click', () => $('folderInput').click());
for (const id of ['fileInput', 'folderInput']) {
    $(id).addEventListener('change', event => {
        const files = [...event.target.files];
        event.target.value = '';
        addFiles(files);
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
$('profile').addEventListener('change', event => { data.settings.profile = event.target.value; shown = PAGE; persist(); });
$('period').addEventListener('change', event => { filter.period = event.target.value; shown = PAGE; render(); });
$('size').addEventListener('change', event => { filter.size = event.target.value; shown = PAGE; render(); });
$('moreMatches').addEventListener('click', () => { shown += PAGE; render(); });
$('initial').addEventListener('change', event => {
    const key = stats.currentProfile(data)?.key ?? '';
    data.settings.initialChests[key] = Math.max(0, Math.floor(Number(event.target.value) || 0));
    persist();
});

function exportHistory(name) {
    data.backup = { at: new Date().toISOString(), matches: Object.keys(data.matches).length };
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), name ?? `chestlookout-historico-${stats.dayKey(new Date())}.json`);
}
for (const id of ['export', 'backupNow']) {
    $(id).addEventListener('click', () => { exportHistory(); persist(); });
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
    shown = PAGE;
    filter.period = 'all';
    filter.size = '';
    $('log').replaceChildren();
    await persist();
    setStatus(count ? 'Histórico apagado. O backup foi baixado.' : 'Histórico apagado.');
});

$('copyDiag').addEventListener('click', async () => {
    const entries = Object.values(data.matches);
    const lines = [
        `Chest Lookout ${APP_VERSION}`,
        `analisador: ${engine ? `${engine.analyzerVersion} (${engine.mode})` : 'não carregado'}` + (startup.ms != null ? `, ${startup.ms} ms` : '') + (startup.fallback ? ', plano B' : ''),
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
    const slow = setInterval(() => {
        if (Date.now() - lastMove > 45000) {
            setStatus('Carregando o analisador… está demorando mais que o normal. Se não avançar, recarregue a página (Ctrl+F5); se continuar, abra o console (F12) e veja as linhas [Chest Lookout].');
        }
    }, 5000);
    try {
        engine = await createEngine((done, total) => {
            lastMove = Date.now();
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
