// The history lives in the browser (IndexedDB): nothing is sent anywhere. Export it from the page to keep a copy.
const DB = 'chestcounter-web';
const STORE = 'kv';
const KEY = 'data';
export const DATA_VERSION = 2;

/** One record per match AND account: two friends in the same match (same session id) keep one record each. */
export const matchKey = match => `${match.sessionId}|${match.epicId || match.playerName || ''}`;

export function emptyData() {
    return {
        version: DATA_VERSION,
        analyzerVersion: 0,
        matches: {},   // matchKey -> { supported, match }
        files: {},     // file key -> matchKey, or the reason it was skipped
        removed: {},   // matchKey -> true: matches deleted by hand, not added again by a later import
        backup: { at: null, matches: 0 },  // last export: when, and how many matches it held
        settings: {
            profile: null, countAmmo: false, countFood: false, countCannons: false,
            showTeammates: false, countTeammates: false, includeOld: false, initialChests: {},
        },
    };
}

function open() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function run(mode, action) {
    return open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    }));
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : value == null ? null : String(value));
const count = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const numberOrNull = value => (Number.isFinite(value) ? value : null);
const counters = value => Object.fromEntries(Object.entries(isObject(value) ? value : {}).map(([k, v]) => [k, count(v)]));

/**
 * A match record as the page expects it, whatever came in (older version, hand-edited or damaged file).
 * Returns null when it cannot be a match at all. Unknown fields are kept.
 */
export function cleanMatch(raw) {
    if (!isObject(raw) || typeof raw.sessionId !== 'string' || raw.sessionId === '') return null;
    const list = value => (Array.isArray(value) ? value.filter(isObject) : []);
    return {
        ...raw,
        playerName: text(raw.playerName),
        epicId: text(raw.epicId),
        playlist: text(raw.playlist),
        gameVersion: text(raw.gameVersion),
        replayFile: text(raw.replayFile) ?? '',
        matchStartUtc: text(raw.matchStartUtc),
        analyzedAtUtc: text(raw.analyzedAtUtc),
        durationSeconds: numberOrNull(raw.durationSeconds),
        placement: numberOrNull(raw.placement),
        totalPlayers: numberOrNull(raw.totalPlayers),
        eliminations: numberOrNull(raw.eliminations),
        analyzerVersion: count(raw.analyzerVersion),
        chestsOpened: count(raw.chestsOpened),
        ammoBoxesOpened: count(raw.ammoBoxesOpened),
        otherInteractions: counters(raw.otherInteractions),
        chests: list(raw.chests).map(c => ({ ...c, kind: text(c.kind) ?? 'Chest', timeSeconds: numberOrNull(c.timeSeconds), items: Array.isArray(c.items) ? c.items.map(String) : [] })),
        treasureFinds: list(raw.treasureFinds),
        teammates: list(raw.teammates).map(t => ({ ...t, name: text(t.name) ?? '', epicId: text(t.epicId), chestsSeen: count(t.chestsSeen), kinds: counters(t.kinds) })),
    };
}

export function normalize(raw) {
    const data = emptyData();
    if (!isObject(raw)) return data;
    if (Number.isFinite(raw.analyzerVersion)) data.analyzerVersion = raw.analyzerVersion;

    // Records are re-keyed on the way in: version 1 used the session id alone.
    const renamed = new Map();
    for (const [oldKey, entry] of Object.entries(isObject(raw.matches) ? raw.matches : {})) {
        const match = cleanMatch(entry?.match);
        if (!match) continue;
        const key = matchKey(match);
        renamed.set(oldKey, key);
        const kept = data.matches[key];
        if (!kept || kept.match.analyzerVersion < match.analyzerVersion) data.matches[key] = { supported: entry.supported !== false, match };
    }
    for (const [fileKey, value] of Object.entries(isObject(raw.files) ? raw.files : {})) {
        if (typeof value === 'string') data.files[fileKey] = renamed.get(value) ?? value;
    }
    for (const key of Object.keys(isObject(raw.removed) ? raw.removed : {})) data.removed[key] = true;
    if (isObject(raw.backup)) data.backup = { at: text(raw.backup.at), matches: count(raw.backup.matches) };

    const settings = isObject(raw.settings) ? raw.settings : {};
    for (const name of Object.keys(data.settings)) {
        if (typeof data.settings[name] === 'boolean') data.settings[name] = settings[name] === true;
    }
    data.settings.profile = text(settings.profile);
    data.settings.initialChests = counters(settings.initialChests);
    return data;
}

/** Returns { data, persistent }: persistent is false when the browser refuses storage (private window…). */
export async function load() {
    try {
        return { data: normalize(await run('readonly', store => store.get(KEY))), persistent: true };
    } catch (error) {
        console.warn('Sem armazenamento no navegador:', error);
        return { data: emptyData(), persistent: false };
    }
}

export async function save(data) {
    try {
        await run('readwrite', store => store.put(data, KEY));
        return true;
    } catch (error) {
        console.warn('Não foi possível salvar o histórico:', error);
        return false;
    }
}

/**
 * Asks the browser not to clear this site's data when the disk runs low. Returns true (protected), false
 * (refused: the browser decides by itself) or null (not supported).
 */
export async function protect() {
    try {
        if (!navigator.storage?.persist) return null;
        return (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch {
        return null;
    }
}

/** The remembered folder (a FileSystemDirectoryHandle) is kept beside the history; null when there is none. */
export async function loadFolder() {
    try {
        return (await run('readonly', store => store.get('folder'))) ?? null;
    } catch {
        return null;
    }
}

/** Returns false when the browser could not keep the folder (it then stays usable until the page is closed). */
export async function saveFolder(handle) {
    try {
        await run('readwrite', store => (handle ? store.put(handle, 'folder') : store.delete('folder')));
        return true;
    } catch (error) {
        console.warn('Não foi possível lembrar a pasta:', error);
        return false;
    }
}
