// One analyze(file) function for the page. The analyzer normally lives in a worker; if it cannot start there
// (error, or no sign of life), it is loaded in the page itself: same result, the page just freezes for a moment
// while a replay is read.
import { loadAnalyzer } from './runtime.js';

/** How long the worker may stay silent: before the runtime download shows progress, and once it does. */
const QUIET_START_MS = 20000, QUIET_DOWNLOAD_MS = 120000;

export async function createEngine(onProgress = () => {}, onNote = () => {}) {
    try {
        return await workerEngine(onProgress);
    } catch (error) {
        console.warn('[Chest Lookout] worker indisponível, a análise roda na própria página:', error);
        onNote('fallback');
        const api = await loadAnalyzer(onProgress);
        return {
            mode: 'page',
            analyzerVersion: api.AnalyzerVersion(),
            analyze: async file => {
                const bytes = new Uint8Array(await file.arrayBuffer());
                await new Promise(resolve => setTimeout(resolve, 30)); // let the progress text paint first
                return JSON.parse(api.Analyze(bytes, file.name));
            },
        };
    }
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
                    analyze: async file => {
                        const buffer = await file.arrayBuffer();
                        const id = nextId++;
                        const json = await new Promise((done, fail) => {
                            pending.set(id, { resolve: done, reject: fail });
                            worker.postMessage({ id, name: file.name, buffer }, [buffer]);
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
