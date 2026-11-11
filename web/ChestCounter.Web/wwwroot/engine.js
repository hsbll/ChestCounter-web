// One analyze(file) function for the page. The analyzer normally lives in a worker; if the browser cannot start
// it there, it is loaded in the page itself (same result, the page just freezes while a replay is read).
import { loadAnalyzer } from './runtime.js';

export async function createEngine() {
    try {
        return await workerEngine();
    } catch (error) {
        console.warn('Worker indisponível, a análise roda na própria página:', error);
        const api = await loadAnalyzer();
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

function workerEngine() {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        const pending = new Map();
        let nextId = 1;
        let started = false;

        worker.onerror = event => {
            const error = new Error(event.message || 'falha ao iniciar o worker');
            if (!started) {
                worker.terminate();
                reject(error);
            }
            for (const waiting of pending.values()) waiting.reject(error);
            pending.clear();
        };
        worker.onmessage = event => {
            const message = event.data;
            if (message.type === 'failed') {
                worker.terminate();
                reject(new Error(message.message));
            } else if (message.type === 'ready') {
                started = true;
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
