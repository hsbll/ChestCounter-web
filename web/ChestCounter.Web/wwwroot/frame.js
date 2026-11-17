// Runs inside a hidden frame of the page (see engine.js). The analyzer lives here so that, if the .NET runtime
// ever stops for good, the page throws the frame away and starts a fresh one instead of needing a reload.
import { loadAnalyzer, nativeBytes } from './runtime.js';

const send = message => parent.postMessage({ chestLookout: true, ...message }, '*');
const ready = loadAnalyzer(
    (loaded, total) => send({ type: 'progress', loaded, total }),
    name => send({ type: 'stage', name }),
).then(
    api => { send({ type: 'ready', analyzerVersion: api.AnalyzerVersion(), stormVersion: api.StormVersion?.() ?? 0, nativeBytes: nativeBytes() }); return api; },
    error => { send({ type: 'failed', message: String(error?.message ?? error) }); throw error; });
ready.catch(() => { /* reported above */ });

window.addEventListener('message', async event => {
    if (event.source !== parent || !event.data?.chestLookout) return;
    const { id, name, buffer, withStorm = true } = event.data;
    try {
        const api = await ready;
        send({ type: 'result', id, json: api.Analyze(new Uint8Array(buffer), name, withStorm) });
    } catch (error) {
        send({ type: 'result', id, error: String(error?.message ?? error) });
    }
});
