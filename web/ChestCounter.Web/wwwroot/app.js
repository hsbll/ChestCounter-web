import { createEngine } from './engine.js';
import * as store from './store.js';
import * as stats from './stats.js';
import { listReplays } from './zip.js';
import { drawSummary } from './summary-image.js';

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('pt-BR');
const fmt1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateShort = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
const kindName = kind => KIND_NAMES[kind] ?? kind;

let data = store.emptyData();
let engine = null;
let busy = false;

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
function table(target, head, rows, emptyText) {
    target.replaceChildren();
    if (rows.length === 0) {
        target.append(el('tbody', {}, el('tr', {}, el('td', { class: 'none', text: emptyText }))));
        return;
    }
    target.append(el('thead', {}, el('tr', {}, ...head.map(h => el('th', { class: h.n ? 'n' : '', text: h.t })))));
    target.append(el('tbody', {}, ...rows.map(cells => el('tr', {}, ...cells.map((cell, i) => {
        const c = cell && typeof cell === 'object' ? cell : { t: cell };
        return el('td', { class: [head[i]?.n ? 'n' : '', c.c ?? ''].join(' ').trim(), text: c.t ?? '' });
    })))));
}

function modeName(playlist) {
    if (!playlist) return '—';
    const p = playlist.toLowerCase();
    const size = p.includes('solo') ? 'Solo' : p.includes('duo') ? 'Duplas' : p.includes('trio') ? 'Trios' : p.includes('squad') ? 'Esquadrões' : null;
    const parts = [];
    if (p.includes('showdown') || p.includes('ranked')) parts.push('Ranqueado');
    if (p.includes('nobuild')) parts.push('Zero Construção');
    if (p.includes('reload') || p.includes('punchberry') || p.includes('blastberry')) parts.push('Recarga');
    if (size) parts.unshift(size);
    return parts.length ? parts.join(' · ') : playlist.replace(/^Playlist_/i, '').replaceAll('_', ' ');
}
const clock = seconds => seconds == null ? '' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// ---- rendering ------------------------------------------------------------------------------------------
function render() {
    const s = stats.build(data);
    const settings = data.settings;
    const all = stats.profiles(data);

    $('profileBox').hidden = all.length < 2;
    $('profile').replaceChildren(...all.map(p => {
        const option = el('option', { value: p.key, text: `${p.name} (${fmt.format(p.matches.length)})` });
        option.selected = p.key === s.profile?.key;
        return option;
    }));

    for (const box of document.querySelectorAll('[data-setting]')) box.checked = !!settings[box.dataset.setting];
    $('initial').value = s.initial || '';
    $('initial').disabled = !s.profile;

    const has = s.matches > 0;
    $('empty').hidden = has;
    $('report').hidden = !has;
    if (!has) {
        const hidden = Object.values(data.matches).length;
        $('empty').querySelector('p').textContent = hidden > 0 && !settings.includeOld
            ? `Há ${fmt.format(hidden)} partida(s) de versões anteriores à v43 no histórico. Ative "Incluir partidas anteriores à v43" nos Ajustes para vê-las.`
            : 'Adicione seus replays acima. Cada partida é contada uma única vez, e o histórico continua aqui mesmo que você apague os arquivos depois.';
        return;
    }

    $('total').textContent = fmt.format(s.total);
    const notes = [];
    if (s.profile?.name) notes.push(s.profile.name);
    if (s.since) notes.push(`desde ${dateDay.format(s.since)}`);
    if (s.initial) notes.push(`inclui ${fmt.format(s.initial)} de antes do contador`);
    if (settings.countTeammates) notes.push('inclui os baús vistos dos companheiros');
    $('totalNote').textContent = notes.join(' · ');

    const tile = (label, value, small) => el('div', {}, el('dt', { text: label }), el('dd', { text: value }, small ? el('small', { text: small }) : null));
    $('tiles').replaceChildren(
        tile('Partidas', fmt.format(s.matches)),
        tile('Média por partida', fmt1.format(s.average)),
        tile('Melhor partida', fmt.format(s.bestMatch)),
        tile('Hoje', fmt.format(s.today)),
        tile('Melhor dia', s.bestDay ? fmt.format(s.bestDay.chests) : '—', s.bestDay ? s.bestDay.key.split('-').reverse().join('/') : null),
        tile('Tesouros', fmt.format(s.treasures.length)),
        tile('Vitórias', fmt.format(s.wins), s.placed ? `${fmt1.format(100 * s.wins / s.placed)}% de ${fmt.format(s.placed)}` : null),
        settings.showTeammates ? tile('Baús dos companheiros', '≥ ' + fmt.format(s.teamChests)) : null,
    );

    renderChart(s.lastDays);

    const chestTotal = s.byKind.reduce((sum, [, n]) => sum + n, 0);
    table($('kinds'), [{ t: 'Tipo' }, { t: 'Baús', n: true }, { t: '%', n: true }],
        s.byKind.map(([kind, n]) => [kindName(kind), fmt.format(n), fmt1.format(100 * n / chestTotal)]), 'Nenhum baú aberto ainda.');
    const counted = new Set(stats.extraKinds(settings));
    table($('others'), [{ t: 'Tipo' }, { t: 'Abertos', n: true }, { t: 'No total?' }],
        s.others.map(([kind, n]) => [kindName(kind), fmt.format(n), counted.has(kind) ? 'Sim' : 'Não']), 'Nenhum outro contêiner.');

    table($('treasures'), [{ t: 'Tesouro' }, { t: 'Partida' }, { t: 'Momento', n: true }, { t: 'Origem' }],
        s.treasures.map(({ find, date }) => [
            { t: (find.fromGoldenChest ? '★★ ' : '★ ') + (TREASURE_NAMES[find.displayName] ?? find.displayName ?? find.item), c: 'wrap' },
            dateShort.format(date), clock(find.obtainedAtSeconds),
            kindName(find.sourceKind) + (find.sourceDestroyed ? ' (destruído)' : '') + (find.sourceIsChest === false ? ' ⚑' : ''),
        ]), 'Nenhum tesouro encontrado nas partidas lidas.');

    $('matesCard').hidden = !settings.showTeammates;
    if (settings.showTeammates) {
        table($('mates'), [{ t: 'Companheiro' }, { t: 'Partidas juntos', n: true }, { t: 'Vitórias juntos', n: true }, { t: 'Baús vistos', n: true }, { t: 'Média', n: true }, { t: 'Recorde', n: true }],
            s.mates.map(m => [m.name || 'Companheiro', fmt.format(m.matches), fmt.format(m.wins), '≥ ' + fmt.format(m.seen), fmt1.format(m.seen / m.matches), fmt.format(m.best)]),
            'Nenhuma partida em equipe ainda.');
    }

    const shown = s.rows.slice(0, 100);
    $('matchesNote').textContent = s.rows.length > shown.length ? `(as ${shown.length} mais recentes de ${fmt.format(s.rows.length)})` : '';
    const head = [{ t: 'Data' }, { t: 'Modo' }, { t: 'Colocação', n: true }, { t: 'Elim.', n: true }, { t: 'Baús', n: true }, { t: 'Tesouros', n: true }];
    if (settings.showTeammates) head.push({ t: 'Equipe' });
    table($('matches'), head, shown.map(({ m, date, total, own }) => {
        const place = m.placement == null ? { t: '—' } : { t: (m.placement === 1 ? '🏆 ' : '') + m.placement + 'º', c: m.placement === 1 ? 'win' : m.placement <= 10 ? 'top10' : '' };
        const row = [dateShort.format(date), modeName(m.playlist), place, m.eliminations ?? '—',
            fmt.format(total) + (total !== own ? ` (${fmt.format(own)} meus)` : ''), m.treasureFinds?.length ? fmt.format(m.treasureFinds.length) : ''];
        if (settings.showTeammates) {
            row.push({ t: (m.teammates ?? []).map(t => `${t.name} ≥${stats.mateSeen(t, stats.extraKinds(settings))}`).join(', ') || '—', c: 'wrap' });
        }
        return row;
    }), '');
}

function renderChart(days) {
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
            tip.textContent = `${dayLong.format(d.date)}: ${fmt.format(d.chests)} ${d.chests === 1 ? 'baú' : 'baús'}`;
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

// ---- reading replays ------------------------------------------------------------------------------------
function log(name, text, kind) {
    const list = $('log');
    list.prepend(el('li', {}, el('span', { text: name }), el('span', { class: kind, text })));
    while (list.children.length > 300) list.lastChild.remove();
}

/** Same decisions as the desktop tool (Tracker.Process). Returns a truthy value when there is something to save ('known' = match already counted). */
function record(file, key, result) {
    if (result.status === 'recording') {
        log(file.name, 'partida ainda em gravação: adicione de novo quando ela terminar', 'skip');
        return false;
    }
    if (result.status !== 'ok' || !result.match) {
        log(file.name, result.status === 'invalid' ? 'não é um replay do Fortnite' : `erro: ${result.message ?? 'falha na leitura'}`, 'err');
        return false; // not remembered: adding the file again tries again
    }
    const match = result.match;
    const existing = data.matches[match.sessionId];
    if (!match.isBattleRoyale) {
        delete data.matches[match.sessionId];
        data.files[key] = 'other mode';
        log(file.name, 'não é Battle Royale (criativo / outro modo)', 'skip');
        return true;
    }
    if (existing && (existing.match.analyzerVersion ?? 0) >= (match.analyzerVersion ?? 0)) {
        data.files[key] = match.sessionId;
        log(file.name, 'partida já contada', 'skip');
        return 'known';
    }
    if (existing) match.analyzedAtUtc = existing.match.analyzedAtUtc;
    data.matches[match.sessionId] = { supported: !!result.supportedVersion, match };
    data.files[key] = match.sessionId;
    data.settings.profile ??= stats.profileKey(match);
    const n = match.chestsOpened ?? 0;
    const text = `${fmt.format(n)} ${n === 1 ? 'baú' : 'baús'}` + (match.treasureFinds?.length ? `, ${match.treasureFinds.length} tesouro(s)` : '');
    if (result.supportedVersion) log(file.name, text, 'ok');
    else log(file.name, `${text} · versão anterior à v43 (fora das estatísticas)`, 'skip');
    return true;
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
    let added = 0, skipped = 0;
    try {
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
                skipped++;
                continue;
            }
            let result;
            try {
                result = await engine.analyze(await source.getFile());
            } catch (error) {
                result = { status: 'error', message: String(error?.message ?? error) };
            }
            const before = Object.keys(data.matches).length;
            const outcome = record(source, source.key, result);
            if (outcome) {
                added += Object.keys(data.matches).length > before ? 1 : 0;
                skipped += outcome === 'known' ? 1 : 0;
                if (!(await store.save(data))) $('storageNotice').hidden = false;
                render();
            }
        }
        $('progressBar').style.width = '100%';
        setStatus(`Pronto: ${added} partida(s) nova(s)` + (skipped ? `, ${skipped} já contada(s) antes` : '') + '.');
    } finally {
        busy = false;
        setButtons();
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
            if (/\.replay$/i.test(entry.name)) files.push(await entry.getFile());
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

$('copyPath').addEventListener('click', async () => {
    const button = $('copyPath');
    const text = $('demosPath').textContent;
    let copied = false;
    try {
        await navigator.clipboard.writeText(text);
        copied = true;
    } catch {
        // No clipboard permission: select the text so Ctrl+C works.
        const range = document.createRange();
        range.selectNodeContents($('demosPath'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        try { copied = document.execCommand('copy'); } catch { /* the text stays selected */ }
    }
    button.textContent = copied ? 'Copiado!' : 'Selecionado: Ctrl+C';
    setTimeout(() => { button.textContent = 'Copiar caminho'; }, 2000);
});

// ---- wiring ---------------------------------------------------------------------------------------------
function setStatus(text, error = false) {
    $('engineStatus').textContent = text;
    $('engineStatus').classList.toggle('error', error);
}
function setButtons() {
    for (const id of ['pickFiles', 'pickFolder', 'refresh', 'rememberFolder', 'import', 'reset']) $(id).disabled = busy || (!engine && !['import', 'reset'].includes(id));
}
async function persist() {
    render();
    if (!(await store.save(data))) $('storageNotice').hidden = false;
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
$('profile').addEventListener('change', event => { data.settings.profile = event.target.value; persist(); });
$('initial').addEventListener('change', event => {
    const key = stats.currentProfile(data)?.key ?? '';
    data.settings.initialChests[key] = Math.max(0, Math.floor(Number(event.target.value) || 0));
    persist();
});
$('saveImage').addEventListener('click', async () => {
    const s = stats.build(data);
    if (!s.matches) return;
    const canvas = drawSummary({ totalText: fmt.format(s.total) }, {
        name: $('imageName').checked ? s.profile?.name : null,
        since: s.since ? `${fmt.format(s.matches)} ${s.matches === 1 ? 'partida' : 'partidas'} desde ${dateDay.format(s.since)}` : null,
        tiles: [
            { label: 'Média por partida', value: fmt1.format(s.average) },
            { label: 'Melhor partida', value: fmt.format(s.bestMatch) },
            { label: 'Melhor dia', value: s.bestDay ? fmt.format(s.bestDay.chests) : '—' },
            { label: 'Hoje', value: fmt.format(s.today) },
            { label: 'Tesouros', value: fmt.format(s.treasures.length) },
            { label: 'Vitórias', value: fmt.format(s.wins) },
        ],
        days: s.lastDays.map(d => ({ chests: d.chests, valueText: fmt.format(d.chests), label: weekday.format(d.date).replace('.', '') })),
        generated: `${dateDay.format(new Date())} · ChestCounter Web · ferramenta não oficial`,
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
        setStatus('Não foi possível gerar a imagem neste navegador.', true);
        return;
    }
    const link = el('a', { href: URL.createObjectURL(blob), download: `chestcounter-resumo-${stats.dayKey(new Date())}.png` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});
$('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: `chestcounter-web-${stats.dayKey(new Date())}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});
$('import').addEventListener('click', () => $('importInput').click());
$('importInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        const incoming = store.normalize(JSON.parse(await file.text()));
        const count = Object.keys(incoming.matches).length;
        if (!confirm(`Importar ${count} partida(s)? Elas serão juntadas ao histórico atual.`)) return;
        for (const [id, entry] of Object.entries(incoming.matches)) {
            if (!entry?.match?.sessionId) continue;
            const mine = data.matches[id];
            if (!mine || (mine.match.analyzerVersion ?? 0) < (entry.match.analyzerVersion ?? 0)) data.matches[id] = entry;
        }
        Object.assign(data.files, incoming.files);
        data.settings.initialChests = { ...incoming.settings.initialChests, ...data.settings.initialChests };
        await persist();
        setStatus(`Histórico importado: ${count} partida(s).`);
    } catch (error) {
        setStatus(`Não foi possível importar: ${error.message}`, true);
    }
});
$('reset').addEventListener('click', async () => {
    if (!confirm('Apagar todo o histórico e os ajustes deste navegador? Exporte antes se quiser guardar uma cópia.')) return;
    data = store.emptyData();
    $('log').replaceChildren();
    await persist();
    setStatus('Histórico apagado.');
});

(async () => {
    setButtons();
    const loaded = await store.load();
    data = loaded.data;
    $('storageNotice').hidden = loaded.persistent;
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
            setStatus('Carregando o analisador… está demorando mais que o normal. Se não avançar, recarregue a página (Ctrl+F5); se continuar, abra o console (F12) e veja as linhas [ChestCounter].');
        }
    }, 5000);
    try {
        engine = await createEngine((loaded, total) => {
            lastMove = Date.now();
            if (!(total > 0)) return;
            // The last stretch of the bar is kept for starting the runtime once everything is downloaded.
            bar.style.width = `${Math.max(2, Math.min(90, (90 * loaded) / total))}%`;
            setStatus(loaded < total
                ? `Baixando o analisador… ${loaded} de ${total} arquivos. Os botões são liberados quando terminar.`
                : 'Iniciando o analisador…');
        }, () => {
            lastMove = Date.now();
            bar.style.width = '2%';
            setStatus('Carregando o analisador de outro modo… os botões são liberados quando terminar.');
        });
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
})();
