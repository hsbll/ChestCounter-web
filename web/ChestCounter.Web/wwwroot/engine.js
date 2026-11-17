// One analyze(file) function for the page. The analyzer runs in a hidden frame of the page (frame.js): same
// thread as the page, so the page still pauses while a replay is read, but a runtime that has stopped for good
// can be thrown away and started again (restart()). If the frame cannot start, the analyzer runs in the page
// itself. A worker version exists behind ?worker=1, with a fallback if it stalls.
import { loadAnalyzer } from './runtime.js';

/** How long the worker may stay silent: before the runtime download shows progress, and once it does. */
const QUIET_START_MS = 20000, QUIET_DOWNLOAD_MS = 120000;

/** An error after which the .NET runtime cannot run anything else: the analyzer has to be started again. */
export const isFatal = message => /runtime already exited|Assertion|RuntimeError|memory access out of bounds|unreachable|Aborted/i.test(String(message ?? ''));

export async function createEngine(onProgress = () => {}, onNote = () => {}) {
    const mode = new URLSearchParams(location.search).get('worker') === '1' ? 'worker' : 'frame';
    if (mode === 'worker') {
        try {
            return await workerEngine(onProgress);
        } catch (error) {
            console.warn('[Chest Lookout] worker indisponível:', error);
            onNote('fallback');
        }
    } else {
        try {
            return await frameEngine(onProgress);
        } catch (error) {
            console.warn('[Chest Lookout] frame indisponível, a análise roda na própria página:', error);
            onNote('fallback');
        }
    }
    const api = await loadAnalyzer(onProgress);
    return {
        mode: 'page',
        analyzerVersion: api.AnalyzerVersion(),
        stormVersion: api.StormVersion?.() ?? 0,
        analyze: async (file, withStorm = true) => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            await new Promise(resolve => setTimeout(resolve, 30)); // let the progress text paint first
            return JSON.parse(api.Analyze(bytes, file.name, withStorm));
        },
        restart: null, // the page's own runtime cannot be started twice: a reload is needed
    };
}

/** The analyzer in a hidden same-origin frame, spoken to with messages; restart() replaces the frame. */
function frameEngine(onProgress) {
    const version = new URL(import.meta.url).search; // same version stamp as this file
    let frame = null, pending = new Map(), nextId = 1, started = null;

    const start = (quiet = false) => new Promise((resolve, reject) => {
        frame?.remove();
        for (const waiting of pending.values()) waiting.reject(new Error('runtime already exited (analisador reiniciado)'));
        pending = new Map();
        frame = document.createElement('iframe');
        frame.hidden = true;
        frame.setAttribute('aria-hidden', 'true');
        frame.title = 'analisador';
        const script = new URL(`./frame.js${version}`, import.meta.url).href;
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><script type="module" src="${script}"></` + 'script>';
        const own = frame;
        let watchdog = setTimeout(() => fail(new Error('o analisador não respondeu em 120 s')), QUIET_DOWNLOAD_MS);
        const fail = error => { clearTimeout(watchdog); if (own === frame) { frame.remove(); frame = null; } reject(error); };
        const listener = event => {
            if (event.source !== own.contentWindow || !event.data?.chestLookout) return;
            const message = event.data;
            if (message.type === 'progress') {
                clearTimeout(watchdog);
                watchdog = setTimeout(() => fail(new Error('o analisador parou de responder')), QUIET_DOWNLOAD_MS);
                if (!quiet) onProgress(message.loaded, message.total);
            } else if (message.type === 'failed') {
                fail(new Error(message.message));
            } else if (message.type === 'ready') {
                clearTimeout(watchdog);
                resolve(message);
            } else if (message.type === 'result') {
                const waiting = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) waiting?.reject(new Error(message.error));
                else waiting?.resolve(message.json);
            }
        };
        window.addEventListener('message', listener);
        own.addEventListener('load', () => {}, { once: true });
        document.body.append(own);
        // Forget this frame's messages once it is replaced.
        const cleanup = setInterval(() => { if (!own.isConnected) { window.removeEventListener('message', listener); clearInterval(cleanup); } }, 5000);
    });

    return start().then(info => {
        started = info;
        const engine = {
            mode: 'frame',
            analyzerVersion: info.analyzerVersion,
            stormVersion: info.stormVersion ?? 0,
            nativeBytes: info.nativeBytes ?? 0,
            restarts: 0,
            analyze: async (file, withStorm = true) => {
                const buffer = await file.arrayBuffer();
                if (!frame) throw new Error('runtime already exited (sem analisador)');
                const id = nextId++;
                const json = await new Promise((done, failed) => {
                    pending.set(id, { resolve: done, reject: failed });
                    frame.contentWindow.postMessage({ chestLookout: true, id, name: file.name, buffer, withStorm }, '*', [buffer]);
                });
                return JSON.parse(json);
            },
            /** Throws the frame away and starts the analyzer again (files already downloaded: a few seconds). */
            restart: async () => {
                engine.restarts++;
                const info2 = await start(true);
                started = info2;
            },
        };
        return engine;
    });
}

function workerEngine(onProgress) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        const pending = new Map();
        let nextId = 1;
        let started = false;
        let watchdog = null;

        const giveUp = error => {
            clearTimeout(watchdog);
            if (!started) {
                worker.terminate();
                reject(error);
            }
            for (const waiting of pending.values()) waiting.reject(error);
            pending.clear();
        };
        const watch = quiet => {
            clearTimeout(watchdog);
            if (!started) watchdog = setTimeout(() => giveUp(new Error(`o worker não respondeu em ${quiet / 1000} s`)), quiet);
        };
        watch(QUIET_START_MS);

        worker.onerror = event => giveUp(new Error(event.message || 'falha ao iniciar o worker'));
        worker.onmessage = event => {
            const message = event.data;
            if (message.type === 'progress') {
                watch(QUIET_DOWNLOAD_MS);
                onProgress(message.loaded, message.total);
            } else if (message.type === 'failed') {
                giveUp(new Error(message.message));
            } else if (message.type === 'ready') {
                started = true;
                clearTimeout(watchdog);
                resolve({
                    mode: 'worker',
                    analyzerVersion: message.analyzerVersion,
                    stormVersion: message.stormVersion ?? 0,
                    analyze: async (file, withStorm = true) => {
                        const buffer = await file.arrayBuffer();
                        const id = nextId++;
                        const json = await new Promise((done, fail) => {
                            pending.set(id, { resolve: done, reject: fail });
                            worker.postMessage({ id, name: file.name, buffer, withStorm }, [buffer]);
                        });
                        return JSON.parse(json);
                    },
                });
            } else if (message.type === 'result') {
                const waiting = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) waiting?.reject(new Error(message.error));
                else waiting?.resolve(message.json);
            }
        };
    });
}
