// Runs the .NET replay analyzer off the main thread, so the page stays responsive while a replay is read.
import { loadAnalyzer } from './runtime.js';

self.addEventListener('unhandledrejection', event => self.postMessage({ type: 'failed', message: String(event.reason?.message ?? event.reason) }));

const ready = loadAnalyzer(
    (loaded, total) => self.postMessage({ type: 'progress', loaded, total }),
    name => self.postMessage({ type: 'stage', name }),
).then(
    api => { self.postMessage({ type: 'ready', analyzerVersion: api.AnalyzerVersion() }); return api; },
    error => { self.postMessage({ type: 'failed', message: String(error?.message ?? error) }); throw error; });
ready.catch(() => { /* reported above */ });

self.onmessage = async event => {
    const { id, name, buffer } = event.data;
    try {
        const api = await ready;
        self.postMessage({ type: 'result', id, json: api.Analyze(new Uint8Array(buffer), name) });
    } catch (error) {
        self.postMessage({ type: 'result', id, error: String(error?.message ?? error) });
    }
};
