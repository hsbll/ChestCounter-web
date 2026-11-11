// The history lives in the browser (IndexedDB): nothing is sent anywhere. Export it from the page to keep a copy.
const DB = 'chestcounter-web';
const STORE = 'kv';
const KEY = 'data';

export function emptyData() {
    return {
        version: 1,
        analyzerVersion: 0,
        matches: {},   // sessionId -> { supported, match }
        files: {},     // "name|size|lastModified" -> sessionId or the reason it was skipped
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

export function normalize(raw) {
    const data = emptyData();
    if (raw && typeof raw === 'object') {
        if (raw.matches && typeof raw.matches === 'object') data.matches = raw.matches;
        if (raw.files && typeof raw.files === 'object') data.files = raw.files;
        if (Number.isFinite(raw.analyzerVersion)) data.analyzerVersion = raw.analyzerVersion;
        Object.assign(data.settings, raw.settings ?? {});
        data.settings.initialChests ??= {};
    }
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
